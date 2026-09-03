import type { SupabaseClient } from '@supabase/supabase-js';
import {
  acceptMetricsRows,
  adapterFor,
  checkScopes,
  chooseConnection,
  decideMetricsOutcome,
  duePeriods,
  METRICS_REQUIRED_SCOPES,
  METRICS_SOURCE,
  type AdChannelAdapter,
  type MetricsPeriod,
} from '@octopus/marketing';
import { markConnectionExpired, readPublishableConnections } from './connections';
import { postPersonaMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * The writer `campaign_outcomes` has been waiting for.
 *
 * Four marketing tables landed with their guards in `20260829120000` and after;
 * three of them got writers over the following slices and this one did not, which
 * `marketing-growth-engine.md` has been recording as the next slice ever since.
 * It is the writer that closes the auto-optimize loop, and until it existed the
 * only performance number anywhere in the product was the budget somebody
 * authorised.
 *
 * **The table is append-only by grant, including for `service_role`**, and that
 * single fact shapes everything below. There is no UPDATE and no DELETE, so a row
 * written against the wrong window can never be revised, and a correction is a
 * new row with `source = 'manual'` rather than an edit. Three consequences:
 *
 *   1. **Only whole, closed UTC days are measured.** A partial day could never be
 *      completed later, and the next pass asking for the whole day would write a
 *      second overlapping row rather than replacing the first.
 *   2. **One producer makes every window.** `duePeriods` is it. The unique key
 *      `(campaign_id, period_start, period_end, source)` only dedupes windows
 *      that match exactly, so a single deterministic producer is what turns a
 *      re-pull into a collision instead of a doubled spend.
 *   3. **A collision is the mechanism working**, counted as a duplicate and never
 *      logged as an error. This sweep issues no UPDATE against `campaign_outcomes`
 *      or `campaigns` at all; the only update it can make is marking a connection
 *      expired.
 *
 * **Periods are pulled oldest first and a campaign stops at its first failure.**
 * That is a correctness property rather than politeness. The cursor is derived
 * from `max(period_end)`, so writing day 4 while day 3 failed would move the
 * cursor past day 3 and lose it permanently. Contiguity is what makes a gap
 * recoverable.
 *
 * **Nothing here pauses, closes or optimises anything.** Acting on a CPA ceiling
 * needs a ceiling, which has no writer yet, and a sweep that paused somebody's
 * spend because it could not read a number would be the worst possible use of an
 * uncertain measurement. This records; the auto-optimize slice decides.
 *
 * **Known limitation, recorded rather than discovered later:** a `completed`
 * campaign is not selected, so any days between its last pull and its completion
 * are never measured. Nothing in the product writes `completed` yet, so the gap
 * has no instances today, and closing it needs a completion timestamp the table
 * does not carry. It belongs to the slice that first writes that state. The same
 * shape applies to a live campaign whose project was paused: it keeps spending on
 * the platform while going unmeasured here, which is a kill-switch question
 * rather than a measurement one.
 */

/** A campaign this pass may measure, as the table holds it. */
export interface MeasurableCampaign {
  id: string;
  project_id: string;
  name: string;
  channel: string;
  state: string;
  created_at: string;
}

/**
 * How many days one campaign may catch up in one pass.
 *
 * A constant rather than a knob. Steady state is one day per live campaign per
 * day, so this only matters for a campaign that has been dark, and the cap exists
 * to stop one long backlog holding the tick's lease while somebody waits on a
 * publish. Seven drains a month in under five passes and is still one platform
 * call at a time.
 */
export const MAX_PERIODS_PER_PULL = 7;

/**
 * How many campaigns one read may consider.
 *
 * Bounds the read rather than the work, exactly as the publish sweep's does. The
 * dueness probe below is one indexed limit-1 read per candidate, so this is also
 * what bounds that: a workspace whose campaigns are all caught up costs at most
 * this many cheap reads per pass and pulls nothing.
 */
const CANDIDATE_READ_LIMIT = 200;

export interface MetricsSweepDeps {
  admin: SupabaseClient;
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  now?: () => Date;
  /** Injected for tests. Production resolves through the checked-in registry. */
  adapters?: (provider: string) => AdChannelAdapter;
}

export interface MetricsSweepResult {
  /** Campaigns that owed at least one day and were therefore pulled. */
  attempted: number;
  rowsWritten: number;
  /** Windows already recorded. The unique key doing its job, not a failure. */
  duplicates: number;
  /** Campaigns that stopped early. The next pass resumes from the same day. */
  waiting: number;
  /** Campaigns the platform no longer recognises. Said once, then left alone. */
  gone: number;
}

interface RootEntity {
  campaign_id: string;
  external_id: string;
  created_at: string;
}

export async function metricsSweep(deps: MetricsSweepDeps): Promise<MetricsSweepResult> {
  const now = deps.now?.() ?? new Date();
  const result: MetricsSweepResult = {
    attempted: 0,
    rowsWritten: 0,
    duplicates: 0,
    waiting: 0,
    gone: 0,
  };

  // `live` and `paused` only. `publishing` is a request in flight with no
  // confirmed object to measure, and everything else either never spent or is
  // terminal.
  const { data: rows, error } = await deps.admin
    .from('campaigns')
    .select('id, project_id, name, channel, state, created_at')
    .in('state', ['live', 'paused'])
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const candidates = (rows ?? []) as MeasurableCampaign[];
  if (candidates.length === 0) return result;

  // Two plain reads rather than an embedded join, for `roomForProject`'s reason:
  // PostgREST relationship guessing fails silently, and a silently shorter list
  // here is a campaign that quietly stops being measured.
  const projectIds = [...new Set(candidates.map((c) => c.project_id))];
  const { data: projects, error: projectError } = await deps.admin
    .from('projects')
    .select('id, status')
    .in('id', projectIds);
  if (projectError) throw projectError;

  const runnable = new Set(
    ((projects ?? []) as { id: string; status: string }[])
      .filter((p) => p.status === 'active' || p.status === 'planning')
      .map((p) => p.id),
  );

  const live = candidates.filter((c) => runnable.has(c.project_id));
  const skipped = candidates.length - live.length;
  if (skipped > 0) {
    // Not silent (rule 16). A live campaign in a paused project is still spending
    // on the platform while nothing here records it, which is worth saying out
    // loud even though this sweep is not the thing that should fix it.
    deps.log.info(
      { skipped },
      'campaigns skipped because their project is not active; they are not being measured',
    );
  }
  if (live.length === 0) return result;

  // The platform's own id for the campaign root, which is what `pullMetrics` is
  // asked about, plus the earliest instant it could have spent anything.
  const { data: entityRows, error: entityError } = await deps.admin
    .from('ad_entities')
    .select('campaign_id, external_id, created_at')
    .in(
      'campaign_id',
      live.map((c) => c.id),
    )
    .eq('kind', 'campaign')
    .not('external_id', 'is', null);
  if (entityError) throw entityError;

  const roots = new Map<string, RootEntity>();
  for (const row of (entityRows ?? []) as RootEntity[]) {
    if (!roots.has(row.campaign_id)) roots.set(row.campaign_id, row);
  }

  for (const campaign of live) {
    if (result.attempted >= deps.maxPerPass) break;

    const root = roots.get(campaign.id);
    if (!root) {
      // Live with no published root entity is a state the publish sweep has not
      // finished leaving, not an anomaly. Nothing to measure and nothing to say.
      continue;
    }

    let periods: MetricsPeriod[];
    try {
      periods = duePeriods({
        from: root.created_at,
        lastPeriodEnd: await lastMeasuredEnd(deps, campaign.id),
        now: now.toISOString(),
        cap: MAX_PERIODS_PER_PULL,
      });
    } catch (err) {
      // `duePeriods` throws on a timestamp it cannot read, which is our own data
      // being wrong. Counted as waiting so the campaign is visible in the summary
      // rather than silently absent from it.
      result.waiting += 1;
      deps.log.error(
        { err, campaignId: campaign.id },
        'could not work out which days a campaign owes; it is not being measured',
      );
      continue;
    }

    // A campaign that owes nothing does NOT consume a slot. The cap bounds the
    // campaigns actually pulled, so a long tail of caught-up campaigns at the
    // head of the queue cannot starve one that is behind.
    if (periods.length === 0) continue;

    result.attempted += 1;
    try {
      const summary = await pullOne(deps, campaign, root, periods, now);
      result.rowsWritten += summary.written;
      result.duplicates += summary.duplicates;
      if (summary.outcome === 'waiting') result.waiting += 1;
      if (summary.outcome === 'gone') result.gone += 1;
    } catch (err) {
      // Per campaign, exactly as a tick is per project. Whatever was written
      // before the throw stays written, and the cursor picks up from there.
      result.waiting += 1;
      deps.log.error(
        { err, campaignId: campaign.id, projectId: campaign.project_id },
        'could not measure a campaign; the days it owes stay owed and the next pass retries',
      );
    }
  }

  deps.log.info(result, 'metrics sweep complete');
  return result;
}

/* ------------------------------------------------------------- one campaign */

interface PullSummary {
  written: number;
  duplicates: number;
  outcome: 'measured' | 'waiting' | 'gone';
}

/**
 * The last window this campaign has recorded, or null.
 *
 * Ordered by `period_start` rather than by `period_end`, deliberately: the index
 * is `(campaign_id, period_start desc)`, and because every window this writer
 * produces is the same width, the row with the greatest start is also the row
 * with the greatest end. Ordering by `period_end` would answer the same question
 * with a sort.
 *
 * Scoped to `pull_metrics`. A `manual` correction is a separate row for the same
 * window, so letting one move this cursor would skip a day nobody pulled.
 */
async function lastMeasuredEnd(deps: MetricsSweepDeps, campaignId: string): Promise<string | null> {
  const { data, error } = await deps.admin
    .from('campaign_outcomes')
    .select('period_end')
    .eq('campaign_id', campaignId)
    .eq('source', METRICS_SOURCE)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle<{ period_end: string }>();
  if (error) throw error;
  return data?.period_end ?? null;
}

async function pullOne(
  deps: MetricsSweepDeps,
  campaign: MeasurableCampaign,
  root: RootEntity,
  periods: MetricsPeriod[],
  now: Date,
): Promise<PullSummary> {
  const { admin, log } = deps;
  const summary: PullSummary = { written: 0, duplicates: 0, outcome: 'measured' };

  const roomId = await roomForProject(admin, campaign.project_id);
  if (!roomId) {
    // Connections are room-scoped, so with no room there is no account to read
    // through and nobody to tell about it either.
    log.warn(
      { campaignId: campaign.id, projectId: campaign.project_id },
      'campaign has no room, so its performance cannot be read or explained',
    );
    return { ...summary, outcome: 'waiting' };
  }

  // ---- which account, and may it do this (rule 7, before the call) ----

  const choice = chooseConnection(
    await readPublishableConnections(admin, roomId, campaign.channel),
  );
  if (!choice.chosen) {
    await announceBlocked(deps, campaign, roomId, choice.rule, choice.reason);
    return { ...summary, outcome: 'waiting' };
  }
  const connection = choice.connection;

  const scopes = checkScopes({
    grantedScopes: connection.grantedScopes,
    requiredScopes: [...METRICS_REQUIRED_SCOPES],
    status: connection.status,
  });
  if (!scopes.allowed) {
    await announceBlocked(deps, campaign, roomId, scopes.rule, scopes.reason);
    return { ...summary, outcome: 'waiting' };
  }

  const adapter = (deps.adapters ?? adapterFor)(connection.provider);
  const ref = { externalId: root.external_id };

  // ---- oldest day first, stopping at the first one that does not land ----

  for (const period of periods) {
    const decision = decideMetricsOutcome(await adapter.pullMetrics(ref, period));

    if (decision.action === 'await_reconnect') {
      await markConnectionExpired(admin, connection.id, now);
      await announceBlocked(deps, campaign, roomId, 'auth_expired', decision.reason);
      log.warn(
        { campaignId: campaign.id, connectionId: connection.id },
        'the connection expired mid-read; the remaining days stay owed',
      );
      summary.outcome = 'waiting';
      break;
    }

    if (decision.action === 'gone') {
      await announceBlocked(deps, campaign, roomId, 'not_found', decision.reason);
      log.warn(
        { campaignId: campaign.id, externalId: root.external_id, message: decision.message },
        'the platform no longer recognises this campaign, so it cannot be measured',
      );
      summary.outcome = 'gone';
      break;
    }

    if (decision.action === 'retry') {
      // Nothing moves and nobody is told, on the publish sweep's reasoning: a
      // rate limit is not something an owner can act on, and a message every
      // thirty seconds about a condition that fixes itself is noise on the
      // surface where the important messages live. Unbounded, because there is
      // no terminal state for a measurement and nothing is lost by waiting.
      const line = {
        campaignId: campaign.id,
        kind: decision.kind,
        message: decision.message,
        period,
      };
      if (decision.contractViolation) {
        // An adapter answering a read with a write's error kind has broken the
        // seam's contract, and a warn would bury that among the rate limits.
        log.error(line, 'the adapter refused a metrics read with a write-only error kind');
      } else {
        log.warn(line, 'metrics were refused for now; the same days are read on the next pass');
      }
      summary.outcome = 'waiting';
      break;
    }

    const verdict = acceptMetricsRows(ref, period, decision.rows);
    if (!verdict.ok) {
      // Nothing is written and nothing is invented. A zero here would be a claim
      // that the campaign spent nothing that day, and "we could not tell" is a
      // different sentence.
      log.warn(
        { campaignId: campaign.id, rule: verdict.rule, detail: verdict.detail, period },
        'the adapter did not answer the question it was asked; nothing was recorded',
      );
      summary.outcome = 'waiting';
      break;
    }

    const written = await insertOutcome(deps, campaign, period, verdict.row);
    if (written) summary.written += 1;
    else summary.duplicates += 1;
  }

  if (summary.written > 0) {
    await writeEvent(deps, campaign, {
      provider: connection.provider,
      connection_id: connection.id,
      external_id: root.external_id,
      rows_written: summary.written,
      duplicates: summary.duplicates,
      period_start: periods[0]!.start,
      period_end: periods[summary.written + summary.duplicates - 1]!.end,
    });
  }

  return summary;
}

/**
 * Append one measured day. True when it landed, false when it was already there.
 *
 * Insert-and-tolerate-`23505`, which is both the house idiom and the only one
 * available: `service_role` holds no UPDATE on this table, so `on conflict do
 * update` would fail on privilege rather than resolve anything.
 *
 * **The window written is the one that was asked for, not the one the row
 * reported.** `acceptMetricsRows` has already established they are the same
 * instant, and using our own canonical form keeps `duePeriods` the single
 * producer of window bounds, which is what makes the unique key collide reliably.
 */
async function insertOutcome(
  deps: MetricsSweepDeps,
  campaign: MeasurableCampaign,
  period: MetricsPeriod,
  row: {
    spend: number;
    impressions: number | null;
    clicks: number | null;
    conversions: number | null;
    revenue: number | null;
    extras: Record<string, unknown>;
  },
): Promise<boolean> {
  const { error } = await deps.admin.from('campaign_outcomes').insert({
    campaign_id: campaign.id,
    project_id: campaign.project_id,
    period_start: period.start,
    period_end: period.end,
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    conversions: row.conversions,
    revenue: row.revenue,
    metrics: row.extras,
    source: METRICS_SOURCE,
  });

  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

/* ---------------------------------------------------------------- utilities */

/**
 * Tell the owner why the numbers stopped, once per reason.
 *
 * The rule is in the key, exactly as the publish sweep does it, so a campaign
 * blocked first on a missing account and later on a missing scope says both
 * things once rather than the first thing forever.
 *
 * Its own wording rather than the publish sweep's: a campaign that is already
 * live and already spending has a different problem from one waiting to start,
 * and telling somebody their live campaign is "waiting to publish" would be
 * false.
 */
async function announceBlocked(
  deps: MetricsSweepDeps,
  campaign: MeasurableCampaign,
  roomId: string,
  rule: string,
  reason: string,
): Promise<void> {
  await postPersonaMessage(
    deps.admin,
    deps.log,
    roomId,
    `campaign-metrics-blocked:${campaign.id}:${rule}`,
    `Performance is not being recorded for your campaign "${campaign.name}". ${reason} ` +
      'Anything already measured is still on the project panel.',
    'analyst',
  );
  deps.log.info({ campaignId: campaign.id, rule }, 'a campaign cannot be measured right now');
}

/**
 * The act, which the row cannot record.
 *
 * A measurement causes no state transition, so unlike `campaign.published` there
 * is no trigger-written event beside this one and nothing to avoid duplicating.
 * What it carries is what `campaign_outcomes` has no column for: which account
 * the numbers came through, and what the platform calls the object they describe.
 * Without it, "measured through which connection" is recorded nowhere.
 *
 * Only on a pass that wrote something. A pass that found every window already
 * recorded changed nothing, and an event per no-op tick is log spam that would
 * bury the ones that mean something.
 *
 * Never throws: an event that failed to write must not undo a measurement that
 * landed. Same stance `writeEvent` in the publish sweep and `auditConnection`
 * take.
 */
async function writeEvent(
  deps: MetricsSweepDeps,
  campaign: MeasurableCampaign,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.admin.from('events').insert({
    project_id: campaign.project_id,
    // No actor. Nobody asked for this pass; it is machinery reading a number on a
    // cadence, and attributing it to the person who approved the campaign would
    // misdate their act by however many days have passed.
    actor_kind: 'system',
    verb: 'campaign.metrics_pulled',
    subject_type: 'campaign',
    subject_id: campaign.id,
    payload,
  });
  if (error) {
    deps.log.error(
      { err: error, campaignId: campaign.id },
      'performance was recorded but the event was not',
    );
  }
}

/* -------------------------------------------------------------- the rollup */

/** One outcome row as the project route reads it back. */
export interface OutcomeReadRow {
  campaign_id: string;
  /** `numeric(12,2)`, which PostgREST hands back as a string. */
  spend: number | string | null;
  /** `bigint`, which PostgREST may hand back as a string. */
  impressions: number | string | null;
  clicks: number | string | null;
  conversions: number | string | null;
  period_end: string;
}

export interface CampaignRollup {
  spendToDate: number;
  impressionsToDate: number | null;
  clicksToDate: number | null;
  conversionsToDate: number | null;
  lastMeasuredAt: string | null;
}

/**
 * A number from a column PostgREST may have stringified, or null.
 *
 * `Number(null)` is `0`, which is why this is a function rather than an inline
 * cast: a null metric turned into a zero is a claim that something was measured
 * and found to be none, and that is the distinction this whole rollup exists to
 * keep.
 */
function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sum what has been measured, per campaign.
 *
 * **Only `pull_metrics` rows reach here**, filtered in the query rather than
 * here, and that is a decision rather than an omission. `manual` corrections have
 * no writer yet, and a correction is a second row for a window rather than a
 * replacement, so summing both sources would count a corrected day twice. The
 * slice that writes the first manual row owns the supersedence rule, which is the
 * same guards-land-with-their-writer ordering this module already follows.
 *
 * **A metric nothing has measured stays null.** Only rows that carried a value
 * contribute, and a campaign whose every row had a null `clicks` reports null
 * rather than zero. `spend` is the exception because the column is `not null`:
 * a campaign with any row at all has a real spend, even if it is 0.00.
 */
export function rollupOutcomes(rows: OutcomeReadRow[]): Map<string, CampaignRollup> {
  const out = new Map<string, CampaignRollup>();

  for (const row of rows) {
    const current = out.get(row.campaign_id) ?? {
      spendToDate: 0,
      impressionsToDate: null,
      clicksToDate: null,
      conversionsToDate: null,
      lastMeasuredAt: null,
    };

    current.spendToDate += toNumber(row.spend) ?? 0;

    for (const key of ['impressions', 'clicks', 'conversions'] as const) {
      const value = toNumber(row[key]);
      if (value === null) continue;
      const field = `${key}ToDate` as 'impressionsToDate' | 'clicksToDate' | 'conversionsToDate';
      current[field] = (current[field] ?? 0) + value;
    }

    if (current.lastMeasuredAt === null || row.period_end > current.lastMeasuredAt) {
      // String comparison is safe and exact here: every value is an ISO-8601
      // instant in UTC as PostgREST renders `timestamptz`, so lexical order is
      // chronological order.
      current.lastMeasuredAt = row.period_end;
    }

    out.set(row.campaign_id, current);
  }

  return out;
}
