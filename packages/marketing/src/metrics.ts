/**
 * The decisions pulling metrics makes, without the IO that makes them matter.
 *
 * Same split as `spend.ts`, `scopes.ts` and `publish.ts`, for the same reason: the
 * sweep in `apps/api/src/lib/metrics.ts` is deliberately thin, and what it decides
 * should be readable without a database, a platform account or a running ticker.
 *
 * Three decisions live here.
 *
 * **Which periods are owed** (`duePeriods`), which is the whole idempotency story
 * and the reason this file exists at all. `campaign_outcomes` is append-only by
 * grant, including for `service_role`: there is no UPDATE and no correction, so a
 * row written against the wrong window can never be revised. The unique key
 * `(campaign_id, period_start, period_end, source)` only dedupes windows that
 * match exactly, which means **the single producer of period bounds is what makes
 * a re-pull collide instead of double-counting**. That producer is this function.
 *
 * **Whether the adapter answered the question it was asked** (`acceptMetricsRows`).
 * A read that returns somebody else's entity, or two rows, or a different window,
 * is an adapter-contract anomaly, and writing it anyway would put a number nobody
 * measured into the table the optimizer reads.
 *
 * **What to do about what the platform said** (`decideMetricsOutcome`), the
 * counterpart to `decidePublishOutcome`, with a materially different map because
 * this call is a read: there is no terminal outcome to reach, and no campaign arc
 * that closing one would take.
 */

import type { AdapterEntityRef, AdapterError, AdapterResult, MetricsPeriod } from './adapter';
import type { MetricsRow } from './adapter';

/**
 * `campaign_outcomes.source` for a row this sweep wrote.
 *
 * The column's other legal value is `manual`, which has no writer yet. Both are
 * part of the unique key, so a manual correction for a period we already pulled
 * is a NEW row rather than a collision, and both numbers survive with their
 * provenance attached. That is the migration's stated intent and it is why a
 * correction is never an edit.
 */
export const METRICS_SOURCE = 'pull_metrics';

/* ------------------------------------------------------------- due periods */

const DAY_MS = 86_400_000;

function instant(value: string, label: string): number {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    // Thrown rather than returned. Every input here comes from our own database
    // or our own clock, so an unparseable one is a defect on our side, and the
    // per-campaign catch in the sweep logs it against the campaign that carries
    // it. Returning an empty list instead would make a corrupt timestamp look
    // like a campaign that is simply up to date, which is the silent-wrong-answer
    // shape this codebase keeps finding.
    throw new Error(`${label} is not a usable timestamp: ${value}`);
  }
  return t;
}

/** UTC midnight at or before `t`. Epoch zero is a UTC midnight, so this is exact. */
function dayFloor(t: number): number {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

/** UTC midnight at or after `t`. */
function dayCeil(t: number): number {
  return Math.ceil(t / DAY_MS) * DAY_MS;
}

export interface DuePeriodsInput {
  /**
   * The earliest instant this campaign could have spent anything, which is the
   * root ad entity's `created_at`.
   *
   * The entity's row is written immediately before the platform call, so it is
   * the tightest lower bound available. The campaign's own `created_at` predates
   * its approval and would ask the platform for days when nothing existed.
   */
  from: string;
  /** `max(period_end)` over this campaign's `pull_metrics` rows, or null if none. */
  lastPeriodEnd: string | null;
  /** Passed in. This package has no clock, and that is a property to keep. */
  now: string;
  /** The most periods one pass may take for one campaign. */
  cap: number;
}

/**
 * The closed UTC days this campaign owes, oldest first.
 *
 * **A period is a whole UTC day, `[00:00Z, 24:00Z)`, and only ever a past one.**
 * Partial days are excluded because the table cannot revise them: a row written
 * at noon covering half of today could never be completed, and the next pass
 * asking for the whole day would write a second overlapping row rather than
 * replacing the first. Whole closed days are the only window shape that is
 * correct under an append-only table.
 *
 * **The cursor never moves backwards past a measured window.** `lastPeriodEnd`
 * outranks `from`, and a cursor that is not already on a day boundary is rounded
 * **up**. Rounding down would re-measure a span already partly covered and double
 * the spend the optimizer reads, which the migration names as the failure this
 * key exists to prevent. Losing the tail of an odd window is the safe direction;
 * counting it twice is not.
 *
 * The cap bounds one pass rather than the backlog: whatever is left is the oldest
 * thing owed next time, so a campaign that has been dark for a month drains in
 * order instead of jumping to yesterday and stranding the middle.
 */
export function duePeriods(input: DuePeriodsInput): MetricsPeriod[] {
  const { cap } = input;
  if (!Number.isFinite(cap) || cap <= 0) return [];

  const from = dayFloor(instant(input.from, 'the entity created_at'));
  const last =
    input.lastPeriodEnd === null
      ? null
      : dayCeil(instant(input.lastPeriodEnd, 'the last period end'));
  const today = dayFloor(instant(input.now, 'now'));

  let cursor = last === null ? from : Math.max(from, last);

  const periods: MetricsPeriod[] = [];
  while (cursor + DAY_MS <= today && periods.length < cap) {
    periods.push({
      start: new Date(cursor).toISOString(),
      end: new Date(cursor + DAY_MS).toISOString(),
    });
    cursor += DAY_MS;
  }
  return periods;
}

/* ---------------------------------------------------- what the adapter said */

export type MetricsRowsRule = 'no_row_for_entity' | 'multiple_rows_for_entity' | 'period_mismatch';

export type MetricsRowsVerdict =
  { ok: true; row: MetricsRow } | { ok: false; rule: MetricsRowsRule; detail: string };

/**
 * Exactly one row, for the entity we asked about, covering the window we asked
 * for. Anything else is refused rather than reconciled.
 *
 * **The caller does not sum, merge or collapse.** A real provider may one day
 * report per-child rows, and whether those overlap their parent's totals is a
 * fact about that platform's reporting model. Deciding it here would bake a guess
 * about somebody else's semantics into every caller, and it is the same argument
 * `scopes.ts` makes for refusing to normalise scope strings: translation belongs
 * in the adapter that already knows the platform's vocabulary.
 *
 * A refusal writes nothing. There is no partial credit and no invented zero,
 * because a zero here is a claim that the campaign spent nothing that day, and
 * "we could not tell" and "it spent nothing" are the two answers this table must
 * never confuse.
 */
export function acceptMetricsRows(
  ref: AdapterEntityRef,
  period: MetricsPeriod,
  rows: MetricsRow[],
): MetricsRowsVerdict {
  const mine = rows.filter((r) => r.externalId === ref.externalId);

  if (mine.length === 0) {
    return {
      ok: false,
      rule: 'no_row_for_entity',
      detail: `asked for ${ref.externalId} and got ${rows.length} row(s), none of them for it`,
    };
  }
  if (mine.length > 1) {
    return {
      ok: false,
      rule: 'multiple_rows_for_entity',
      detail: `asked for one window of ${ref.externalId} and got ${mine.length} rows for it`,
    };
  }

  const row = mine[0]!;
  // Compared as instants rather than as strings, so an adapter that answers in a
  // different but equivalent ISO form is not refused for its formatting.
  const wantStart = Date.parse(period.start);
  const wantEnd = Date.parse(period.end);
  const gotStart = Date.parse(row.periodStart);
  const gotEnd = Date.parse(row.periodEnd);

  if (
    Number.isNaN(gotStart) ||
    Number.isNaN(gotEnd) ||
    gotStart !== wantStart ||
    gotEnd !== wantEnd
  ) {
    return {
      ok: false,
      rule: 'period_mismatch',
      detail:
        `asked for ${period.start}/${period.end} and got ` + `${row.periodStart}/${row.periodEnd}`,
    };
  }

  return { ok: true, row };
}

/* ------------------------------------------------ what the platform answered */

/**
 * What to do next, named by the action rather than by the error.
 *
 * The map differs from `decidePublishOutcome`'s in the way that matters: this
 * call is a **read**, so there is no side effect to have half-made and no
 * terminal state to reach. `campaign_outcomes` has no failed row and the campaign
 * machine has no arc a failed measurement could take (`live -> failed` is not
 * legal, and pausing on our own uncertainty would stop somebody's spend because
 * we could not read a number). So every failure here is either "ask again later"
 * or "somebody has to do something", and nothing is ever closed.
 *
 * - `write`: the platform answered. Check the rows and insert.
 * - `retry`: ask again on a later pass. Unbounded, silent in the room.
 * - `await_reconnect`: the owner has to reconnect. Said once.
 * - `gone`: the entity is not there any more. Permanent, and said once, because a
 *   number that stops arriving with nobody told is exactly the silence rule 16
 *   forbids.
 */
export type MetricsDecision =
  | { action: 'write'; rows: MetricsRow[] }
  | {
      action: 'retry';
      kind: 'rate_limited' | 'provider_error' | 'invalid_spec' | 'policy_rejected';
      message: string;
      reason: string;
      retryAfterMs?: number;
      status?: number;
      /**
       * True when the adapter answered a read with an error kind that only a
       * mutation can produce.
       *
       * It is not a different action, because there is still nothing to close and
       * asking again is still the only move. It changes the log level instead: a
       * warn would bury a provider that has broken the seam's contract among the
       * rate limits, and the seam's contract is the thing every later adapter is
       * written against.
       */
      contractViolation: boolean;
    }
  | { action: 'await_reconnect'; kind: 'auth_expired'; message: string; reason: string }
  | { action: 'gone'; kind: 'not_found'; message: string; reason: string };

export function decideMetricsOutcome(result: AdapterResult<MetricsRow[]>): MetricsDecision {
  if (result.ok) {
    // `alreadyExisted` is deliberately ignored. It reports whether an idempotency
    // key had been used before, and a read carries no key: reading twice is
    // reading twice, so there is nothing for it to mean here.
    return { action: 'write', rows: result.value };
  }

  const error: AdapterError = result.error;
  switch (error.kind) {
    case 'auth_expired':
      return {
        action: 'await_reconnect',
        kind: 'auth_expired',
        message: error.message,
        reason:
          'The connection needs reconnecting by its owner before performance can be read again. ' +
          'Nothing is lost by waiting: the days in between are still owed and will be pulled ' +
          'once it is back.',
      };
    case 'not_found':
      return {
        action: 'gone',
        kind: 'not_found',
        message: error.message,
        reason:
          'The platform no longer recognises this campaign, so no more performance can be read ' +
          'for it. Anything already recorded stays. This usually means it was deleted on the ' +
          'platform rather than here.',
      };
    case 'rate_limited':
      return {
        action: 'retry',
        kind: 'rate_limited',
        message: error.message,
        retryAfterMs: error.retryAfterMs,
        reason: 'The platform asked us to slow down, so the same days are read on a later pass.',
        contractViolation: false,
      };
    case 'provider_error':
      return {
        action: 'retry',
        kind: 'provider_error',
        message: error.message,
        status: error.status,
        reason:
          'The platform failed in a way that may not repeat, so the same days are read on a ' +
          'later pass.',
        contractViolation: false,
      };
    // `invalid_spec` and `policy_rejected` describe a mutation being refused, and
    // this call sends no spec and creates nothing. Reaching either means the
    // adapter is answering a read with a mutation's vocabulary. There is still
    // nothing to close, so the action is the same one, and the flag is what makes
    // it loud enough to fix.
    case 'invalid_spec':
      return {
        action: 'retry',
        kind: 'invalid_spec',
        message: error.message,
        reason:
          'The adapter refused a read with an error only a write can produce, which is a defect ' +
          'on our side. The days stay owed and are read again later.',
        contractViolation: true,
      };
    case 'policy_rejected':
      return {
        action: 'retry',
        kind: 'policy_rejected',
        message: error.message,
        reason:
          'The adapter refused a read with an error only a write can produce, which is a defect ' +
          'on our side. The days stay owed and are read again later.',
        contractViolation: true,
      };
  }
}
