/**
 * The decisions the optimizer makes, without the IO that makes them matter.
 *
 * Same split as `spend.ts`, `scopes.ts`, `publish.ts` and `metrics.ts`, and here
 * the argument is at its sharpest: this is the first code in the product that
 * acts on somebody's money without a person clicking anything, so whether it may
 * act must be checkable without a database, a platform account or a running
 * ticker. The sweep in `apps/api/src/lib/optimize.ts` is the IO half and is
 * deliberately thin.
 *
 * Three decisions live here.
 *
 * **Whether the ceiling is breached** (`decideCpaBreach`). One inequality with
 * no division, judged only on measured whole days, abstaining loudly on anything
 * unmeasured. The authorisation story is ADR-0014: the owner typing a ceiling is
 * the authorisation to pause, so the ceiling is read from the row a person wrote
 * and never proposed by the model, on `budget_cap`'s exact reasoning.
 *
 * **The idempotency keys** (`pauseIdempotencyKey`, `resumeIdempotencyKey`),
 * which differ from `publishIdempotencyKey` in the one way that matters: they
 * carry an **epoch**. A publish happens once, so its key derives from the
 * campaign id alone. A campaign can be paused, resumed by its owner, and breach
 * again, and a key derived from the id alone would let a record-replay platform
 * answer the second pause with the first pause's recorded result, moving our row
 * to `paused` while the platform keeps spending. The epoch is the count of prior
 * opposite-direction transitions, read from the trigger-written audit trail, so
 * it is durable, monotonic and re-derivable after any crash.
 *
 * **What to do about what the platform said** (`decidePauseOutcome`), the
 * mutation counterpart of `decideMetricsOutcome` with the same spine: nothing
 * here ever closes a campaign. `live -> failed` is not a legal arc, and a
 * campaign we could not pause must stay visibly live and retried rather than
 * filed as somebody else's problem.
 */

import type { AdapterEntityRef, AdapterError, AdapterResult } from './adapter';

/* ------------------------------------------------------------------- keys */

function epochOrThrow(epoch: number, label: string): number {
  // Thrown rather than clamped, on `duePeriods`' reasoning for `instant`: the
  // epoch is a count over our own events table, so a NaN or a negative here is
  // a defect on our side, and a clamped one would silently reuse an old key,
  // which is exactly the replay this scheme exists to prevent.
  if (!Number.isInteger(epoch) || epoch < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${epoch}`);
  }
  return epoch;
}

/**
 * The name of one intended side effect: stopping this campaign's spend for the
 * `resumeEpoch`-th time.
 *
 * `resumeEpoch` is the count of prior `paused -> live` transitions in `events`.
 * It cannot change between the platform call and the DB write, because the
 * resume route only acts on campaigns that are `paused` in our database, and
 * mid-pause the row still says `live`. So a crash anywhere in the pause sequence
 * re-derives the same key and converges, while a genuine second breach after a
 * resume gets a genuinely new key. The `:cpa` segment is the reason for the
 * pause, so a later kill-switch pause cannot collide with this one.
 */
export function pauseIdempotencyKey(campaignId: string, resumeEpoch: number): string {
  return `pause:${campaignId}:cpa:${epochOrThrow(resumeEpoch, 'resumeEpoch')}`;
}

/**
 * The mirror image: starting this campaign's spend again after its
 * `pauseEpoch`-th stop. `pauseEpoch` is the count of prior `live -> paused`
 * transitions, so a retried resume replays and a resume after a later pause is
 * its own act.
 */
export function resumeIdempotencyKey(campaignId: string, pauseEpoch: number): string {
  return `resume:${campaignId}:${epochOrThrow(pauseEpoch, 'pauseEpoch')}`;
}

/* ----------------------------------------------------------------- breach */

export type CpaBreachRule =
  | 'nothing_measured'
  | 'conversions_unmeasured'
  | 'unusable_input'
  | 'within_ceiling'
  | 'ceiling_breached';

export type CpaVerdict =
  | { breach: false; rule: 'nothing_measured' | 'conversions_unmeasured'; reason: string }
  | {
      /**
       * Also not a breach, but distinguished so the sweep logs it at error
       * rather than folding it into the quiet abstentions: a garbage threshold
       * reaching this function means a guard upstream failed, and pausing on a
       * garbage threshold would be acting on a number nobody authorised.
       */
      breach: false;
      rule: 'unusable_input';
      reason: string;
    }
  | { breach: false; rule: 'within_ceiling'; reason: string }
  | {
      breach: true;
      rule: 'ceiling_breached';
      reason: string;
      /** The arithmetic, carried so the event and the room message state it. */
      spend: number;
      conversions: number;
      cpaCeiling: number;
      /** What the spend was allowed to reach: ceiling * (conversions + 1). */
      allowance: number;
    };

export interface CpaBreachInput {
  /** `CampaignRollup.spendToDate`: summed `pull_metrics` rows, null when none. */
  spendToDate: number | null;
  /** `CampaignRollup.conversionsToDate`: null when never reported, not 0. */
  conversionsToDate: number | null;
  /** How many measured periods the rollup covers. */
  periodsMeasured: number;
  /** `campaigns.cpa_ceiling`, already known non-null by the sweep's query. */
  cpaCeiling: number;
}

/**
 * Whether the measured whole days breach the owner's ceiling.
 *
 * **The rule is `spend > ceiling * (conversions + 1)`, strictly.** Read it as:
 * even granting one more conversion arriving this instant, the money already
 * spent would still exceed what the owner said a conversion may cost. Written
 * as a product rather than a quotient so `conversions = 0` needs no special
 * case and no division: a campaign that spent past one ceiling's worth with
 * nothing to show breaches, and one still inside its first allowance does not.
 * Strict, because the ceiling is the authorised figure and spending exactly it
 * is inside the authorisation, on the spend cap's own boundary rule.
 *
 * **Every abstention is named, and two of them are the no-invented-zero rule.**
 * Zero measured periods means nothing is known, not that nothing was spent. A
 * null `conversionsToDate` means the provider reported spend and never reported
 * conversions, and judging that as zero conversions would manufacture the worst
 * possible number for the campaign out of an absence. Both refuse to judge,
 * quietly, because "not enough data yet" is the normal state of a young
 * campaign and not an anomaly.
 *
 * The consequence worth naming: a campaign whose provider never reports
 * conversions can never breach a CPA ceiling. That is correct rather than a
 * gap, because cost-per-conversion is unjudgeable without conversions, and the
 * guardrail for runaway raw spend is `budget_cap`, which is checked before a
 * cent is authorised.
 */
export function decideCpaBreach(input: CpaBreachInput): CpaVerdict {
  const { spendToDate, conversionsToDate, periodsMeasured, cpaCeiling } = input;

  if (!Number.isFinite(cpaCeiling) || cpaCeiling <= 0) {
    return {
      breach: false,
      rule: 'unusable_input',
      reason:
        `The ceiling ${cpaCeiling} is not a usable threshold, which the contract and the ` +
        'check constraint should both have refused. Nothing is judged against it.',
    };
  }

  if (periodsMeasured <= 0 || spendToDate === null) {
    return {
      breach: false,
      rule: 'nothing_measured',
      reason:
        'No whole day has been measured for this campaign yet, so there is nothing to judge. ' +
        'An unmeasured campaign is not a campaign that spent nothing.',
    };
  }

  if (
    !Number.isFinite(spendToDate) ||
    (conversionsToDate !== null && !Number.isFinite(conversionsToDate))
  ) {
    return {
      breach: false,
      rule: 'unusable_input',
      reason: `The rollup produced an unusable figure (spend ${spendToDate}, conversions ${conversionsToDate}), which is a defect on our side. Nothing is judged.`,
    };
  }

  if (conversionsToDate === null) {
    return {
      breach: false,
      rule: 'conversions_unmeasured',
      reason:
        'Spend was measured but conversions never were, and judging an absence as zero would ' +
        'manufacture the worst possible number out of not knowing. Cost per conversion is ' +
        'unjudgeable here; the budget cap remains the guard on raw spend.',
    };
  }

  const allowance = cpaCeiling * (conversionsToDate + 1);
  if (spendToDate > allowance) {
    return {
      breach: true,
      rule: 'ceiling_breached',
      reason:
        `Spent ${spendToDate} for ${conversionsToDate} conversion(s) against a ceiling of ` +
        `${cpaCeiling} per conversion: even granting one more conversion right now, the spend ` +
        `exceeds the ${allowance} that would justify.`,
      spend: spendToDate,
      conversions: conversionsToDate,
      cpaCeiling,
      allowance,
    };
  }

  return {
    breach: false,
    rule: 'within_ceiling',
    reason:
      `Spent ${spendToDate} for ${conversionsToDate} conversion(s), within the ` +
      `${allowance} the ceiling of ${cpaCeiling} allows.`,
  };
}

/* ------------------------------------------------ what the platform answered */

/**
 * What to do next, named by the action rather than by the error.
 *
 * The map shares `decideMetricsOutcome`'s spine rather than
 * `decidePublishOutcome`'s, and the difference is the safety property of this
 * slice: **no failure here ever closes or moves a campaign.** Publishing has
 * terminal outcomes because an unpublishable campaign is a finished question; a
 * campaign we failed to pause is still spending, and the one unacceptable state
 * is our row saying anything other than `live` about it. `live -> failed` is
 * not a legal arc in the state machine, so the doctrine costs nothing to hold.
 *
 * - `confirm`: the platform paused (or resumed) it. Move our rows.
 * - `retry`: ask again next pass, unbounded, silent in the room. The breach is
 *   re-derived from the same durable rows, so no queue and no counter is
 *   needed: the sweep converges on the same decision until it lands.
 * - `await_reconnect`: the owner has to reconnect, and this one is said in the
 *   room. "Your spend cannot be stopped" is a more urgent sentence than the
 *   metrics sweep's "your numbers stopped", so it is not left to that sweep's
 *   announcement.
 * - `gone`: the platform no longer recognises the campaign, so there is nothing
 *   there to pause. Said once; our row stays `live` because moving it on an
 *   absence would be inventing a confirmation.
 *
 * `invalid_spec` and `policy_rejected` are mutation vocabulary, but a pause
 * sends no spec and no creative, so reaching either means the adapter has
 * broken the seam's contract: `retry` with `contractViolation`, logged at
 * error, exactly the metrics sweep's stance.
 */
export type PauseDecision =
  | { action: 'confirm'; externalId: string; alreadyExisted: boolean }
  | {
      action: 'retry';
      kind: 'rate_limited' | 'provider_error' | 'invalid_spec' | 'policy_rejected';
      message: string;
      reason: string;
      retryAfterMs?: number;
      status?: number;
      contractViolation: boolean;
    }
  | { action: 'await_reconnect'; kind: 'auth_expired'; message: string; reason: string }
  | { action: 'gone'; kind: 'not_found'; message: string; reason: string };

export function decidePauseOutcome(result: AdapterResult<AdapterEntityRef>): PauseDecision {
  if (result.ok) {
    return {
      action: 'confirm',
      externalId: result.value.externalId,
      // Carried through, and here `alreadyExisted: true` has a precise meaning:
      // this attempt is the crash-resume path replaying under the same epoch
      // key, and the audit trail should read it as a retry rather than as a
      // second act.
      alreadyExisted: result.alreadyExisted,
    };
  }

  const error: AdapterError = result.error;
  switch (error.kind) {
    case 'auth_expired':
      return {
        action: 'await_reconnect',
        kind: 'auth_expired',
        message: error.message,
        reason:
          'The connection needs reconnecting by its owner before spend can be stopped from ' +
          'here. The campaign stays live and the pause is attempted again once it is back.',
      };
    case 'not_found':
      return {
        action: 'gone',
        kind: 'not_found',
        message: error.message,
        reason:
          'The platform no longer recognises this campaign, so there is nothing there to ' +
          'pause. It usually means it was deleted on the platform rather than here, and the ' +
          'record here stays as it is rather than inventing a confirmation.',
      };
    case 'rate_limited':
      return {
        action: 'retry',
        kind: 'rate_limited',
        message: error.message,
        retryAfterMs: error.retryAfterMs,
        reason:
          'The platform asked us to slow down. The breach is re-derived and the same pause is ' +
          'attempted on a later pass under the same key.',
        contractViolation: false,
      };
    case 'provider_error':
      return {
        action: 'retry',
        kind: 'provider_error',
        message: error.message,
        status: error.status,
        reason:
          'The platform failed in a way that may not repeat. The breach is re-derived and the ' +
          'same pause is attempted on a later pass under the same key.',
        contractViolation: false,
      };
    case 'invalid_spec':
      return {
        action: 'retry',
        kind: 'invalid_spec',
        message: error.message,
        reason:
          'The adapter refused a pause with a spec error, and a pause sends no spec, so this ' +
          'is a defect on our side. The pause is attempted again while it is fixed.',
        contractViolation: true,
      };
    case 'policy_rejected':
      return {
        action: 'retry',
        kind: 'policy_rejected',
        message: error.message,
        reason:
          'The adapter refused a pause with a policy error, and a pause carries no creative ' +
          'to disapprove, so this is a defect on our side. The pause is attempted again ' +
          'while it is fixed.',
        contractViolation: true,
      };
  }
}
