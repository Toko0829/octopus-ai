import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adapterFor,
  checkScopes,
  chooseConnection,
  decideCpaBreach,
  decidePauseOutcome,
  METRICS_SOURCE,
  OPTIMIZE_REQUIRED_SCOPES,
  pauseIdempotencyKey,
  type AdChannelAdapter,
  type CpaVerdict,
} from '@octopus/marketing';
import { markConnectionExpired, readPublishableConnections } from './connections';
import { postPersonaMessage } from './system-message';
import { roomForProject } from './room-for-project';
import { rollupOutcomes, type OutcomeReadRow } from './metrics';

/**
 * The first code in this product that acts on money with no click behind the
 * act.
 *
 * The metrics sweep records what a campaign spent and stops there, saying so in
 * its own header: "this records; the auto-optimize slice decides." This is that
 * slice. A campaign whose owner typed a CPA ceiling is judged against its
 * measured whole days, and one that breaches is paused at the platform and then
 * here, with the arithmetic stated in the room.
 *
 * **The authorisation is the ceiling itself** (ADR-0014). `optimize_campaign`
 * is `external` tier, not `high_risk`: it acts within a cap a person already
 * authorised, and a confirmation click on every pass would be a confirmation
 * carrying no new information, which is the thing ADR-0013 refuses to build.
 * The sweep is doubly inert until somebody opts in: it selects only campaigns
 * whose `cpa_ceiling` is non-null, and nothing writes that column except the
 * owner-only route.
 *
 * **The platform is called BEFORE the database is written, inverting the
 * publish sweep, and the inversion is argued rather than accidental.** Publish
 * writes its intent row first because the platform invents an id that must not
 * be lost: an unrecorded created object is unrecoverable. A pause creates
 * nothing, and the decision to pause is re-derivable from durable rows (the
 * outcomes and the ceiling are both in Postgres), so a crash at any point
 * re-derives the same breach, presents the same epoch-carrying key, and
 * converges. Writing our row first would open the one truly bad window: a
 * database that says `paused` about a campaign the platform is still spending
 * on.
 *
 * **The pause key carries an epoch** (`pause:<id>:cpa:<epoch>`, where the epoch
 * counts prior `paused -> live` transitions in `events`). Derived from the
 * campaign id alone it would be stable across an owner's resume, and a
 * record-replay platform would answer a second breach with the first pause's
 * recorded success while the money kept moving. The epoch cannot change
 * mid-sequence, because the resume route only acts on campaigns that are
 * `paused` in our database and mid-pause the row still says `live`.
 *
 * **No failure here ever moves a campaign**, and the state machine agrees:
 * `live -> failed` is not a legal arc. A campaign we could not pause is still
 * spending, and the one unacceptable state is our row claiming otherwise. So
 * every failure is retry-quietly or tell-the-owner-once, on the metrics sweep's
 * map, with one deliberate inversion of that sweep's posture: `auth_expired`
 * IS announced here, because "your spend cannot be stopped" is a more urgent
 * sentence than "your numbers stopped".
 *
 * **There is deliberately no project-status gate**, unlike the metrics sweep.
 * Stopping money is kill-switch-family work, and the kill-switch principle is
 * that the stopping arc must have no states it cannot reach: a live campaign in
 * a paused project is precisely the "still spending while unmeasured" gap the
 * metrics sweep names as a kill-switch question. Its rollup may be stale, and
 * a stale-data pause errs in the only safe direction, which is spend stopped.
 */

/** A campaign this pass may judge, as the table holds it. */
export interface OptimizableCampaign {
  id: string;
  project_id: string;
  name: string;
  channel: string;
  state: string;
  /** `numeric(12,2)`, which PostgREST hands back as a string. */
  cpa_ceiling: number | string | null;
  currency: string;
  created_at: string;
}

/**
 * How many campaigns one read may consider. Bounds the read rather than the
 * work, exactly as the other sweeps' constants do: judging is a per-campaign
 * indexed read and a pure function, so a workspace of caught-up campaigns costs
 * at most this many cheap reads and pauses nothing.
 */
const CANDIDATE_READ_LIMIT = 200;

export interface OptimizeSweepDeps {
  admin: SupabaseClient;
  /** Bounds pauses ATTEMPTED (platform calls), not campaigns judged. */
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

export interface OptimizeSweepResult {
  /** Campaigns with a ceiling and a published root, judged against their rollup. */
  judged: number;
  /** Nothing measured yet, or conversions never reported. Quiet and normal. */
  abstained: number;
  /** A garbage ceiling or rollup reached the judge. Our defect, logged at error. */
  unusable: number;
  withinCeiling: number;
  /** Breaches found. Each consumes a maxPerPass slot whatever happens next. */
  breached: number;
  /** Pauses that landed: platform confirmed and our rows moved. */
  paused: number;
  /** Breaches that could not be acted on this pass. Retried next pass. */
  waiting: number;
  /** The platform no longer recognises the campaign. Said once, left alone. */
  gone: number;
}

interface RootEntity {
  id: string;
  campaign_id: string;
  external_id: string;
}

export async function optimizeSweep(deps: OptimizeSweepDeps): Promise<OptimizeSweepResult> {
  const result: OptimizeSweepResult = {
    judged: 0,
    abstained: 0,
    unusable: 0,
    withinCeiling: 0,
    breached: 0,
    paused: 0,
    waiting: 0,
    gone: 0,
  };

  // Only `live` and only with a ceiling. A `paused` campaign is already stopped,
  // whatever the reason; a NULL ceiling abstains by design (the column comment's
  // inversion: an unset judgement threshold refuses to judge, unlike an unset
  // budget, which refuses spend).
  const { data: rows, error } = await deps.admin
    .from('campaigns')
    .select('id, project_id, name, channel, state, cpa_ceiling, currency, created_at')
    .eq('state', 'live')
    .not('cpa_ceiling', 'is', null)
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const candidates = (rows ?? []) as OptimizableCampaign[];
  if (candidates.length === 0) return result;

  const { data: entityRows, error: entityError } = await deps.admin
    .from('ad_entities')
    .select('id, campaign_id, external_id')
    .in(
      'campaign_id',
      candidates.map((c) => c.id),
    )
    .eq('kind', 'campaign')
    .not('external_id', 'is', null);
  if (entityError) throw entityError;

  const roots = new Map<string, RootEntity>();
  for (const row of (entityRows ?? []) as RootEntity[]) {
    if (!roots.has(row.campaign_id)) roots.set(row.campaign_id, row);
  }

  for (const campaign of candidates) {
    if (result.breached >= deps.maxPerPass) break;

    const root = roots.get(campaign.id);
    if (!root) {
      // Live with no published root is a state the publish sweep has not
      // finished leaving. There is nothing at the platform to pause yet, and
      // nothing to say.
      continue;
    }

    try {
      const verdict = await judgeOne(deps, campaign);
      result.judged += 1;

      if (!verdict.breach) {
        if (verdict.rule === 'within_ceiling') result.withinCeiling += 1;
        else if (verdict.rule === 'unusable_input') {
          // A guard upstream failed: the contract and the check constraint both
          // refuse what this rule fires on, so reaching it is our defect, and a
          // quiet abstention would hide it among the young campaigns.
          result.unusable += 1;
          deps.log.error(
            { campaignId: campaign.id, reason: verdict.reason },
            'a campaign could not be judged against its ceiling; nothing was paused',
          );
        } else {
          result.abstained += 1;
        }
        continue;
      }

      result.breached += 1;
      const outcome = await pauseOne(deps, campaign, root, verdict);
      if (outcome === 'paused') result.paused += 1;
      if (outcome === 'waiting') result.waiting += 1;
      if (outcome === 'gone') result.gone += 1;
    } catch (err) {
      // Per campaign, exactly as the other sweeps. The breach, if there was
      // one, is re-derived from the same rows next pass, so nothing is lost.
      result.waiting += 1;
      deps.log.error(
        { err, campaignId: campaign.id, projectId: campaign.project_id },
        'could not judge or pause a campaign; the next pass re-derives the same decision',
      );
    }
  }

  deps.log.info(result, 'optimize sweep complete');
  return result;
}

/* ------------------------------------------------------------ the judgement */

/**
 * A number from a column PostgREST may have stringified, or NaN.
 *
 * NaN rather than null, unlike the rollup's `toNumber`, because the query
 * already filtered NULL out: a value that fails to parse here is a defect, and
 * NaN flows into `decideCpaBreach`, which names it `unusable_input` and
 * abstains loudly. `Number(null)` is `0`, which is the recorded trap this
 * helper exists to step around: a ceiling read as 0 would pause on the first
 * cent.
 */
function toAmount(value: number | string | null): number {
  if (value === null) return Number.NaN;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

async function judgeOne(
  deps: OptimizeSweepDeps,
  campaign: OptimizableCampaign,
): Promise<CpaVerdict> {
  const { data, error } = await deps.admin
    .from('campaign_outcomes')
    .select('campaign_id, spend, impressions, clicks, conversions, period_end')
    .eq('campaign_id', campaign.id)
    .eq('source', METRICS_SOURCE);
  if (error) throw error;

  const outcomeRows = (data ?? []) as OutcomeReadRow[];
  const rollup = rollupOutcomes(outcomeRows).get(campaign.id);

  return decideCpaBreach({
    spendToDate: rollup?.spendToDate ?? null,
    conversionsToDate: rollup?.conversionsToDate ?? null,
    periodsMeasured: outcomeRows.length,
    cpaCeiling: toAmount(campaign.cpa_ceiling),
  });
}

/* ---------------------------------------------------------------- the pause */

/**
 * The count of prior `paused -> live` transitions, from the trigger-written
 * audit trail. Durable, monotonic, and re-derivable after any crash, which is
 * what lets the pause key converge on retry and diverge across resumes.
 */
async function resumeEpoch(deps: OptimizeSweepDeps, campaignId: string): Promise<number> {
  const { count, error } = await deps.admin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('verb', 'campaign.transitioned')
    .eq('subject_type', 'campaign')
    .eq('subject_id', campaignId)
    .eq('payload->>from', 'paused')
    .eq('payload->>to', 'live');
  if (error) throw error;
  return count ?? 0;
}

async function pauseOne(
  deps: OptimizeSweepDeps,
  campaign: OptimizableCampaign,
  root: RootEntity,
  verdict: Extract<CpaVerdict, { breach: true }>,
): Promise<'paused' | 'waiting' | 'gone'> {
  const { admin, log } = deps;
  const now = deps.now?.() ?? new Date();

  const roomId = await roomForProject(admin, campaign.project_id);
  if (!roomId) {
    log.warn(
      { campaignId: campaign.id, projectId: campaign.project_id },
      'campaign breached its ceiling but has no room, so no account can be read to pause it',
    );
    return 'waiting';
  }

  // ---- which account, and may it do this (rule 7, before the call) ----

  const choice = chooseConnection(
    await readPublishableConnections(admin, roomId, campaign.channel),
  );
  if (!choice.chosen) {
    await announceBlocked(deps, campaign, roomId, choice.rule, choice.reason);
    return 'waiting';
  }
  const connection = choice.connection;

  const scopes = checkScopes({
    grantedScopes: connection.grantedScopes,
    requiredScopes: [...OPTIMIZE_REQUIRED_SCOPES],
    status: connection.status,
  });
  if (!scopes.allowed) {
    await announceBlocked(deps, campaign, roomId, scopes.rule, scopes.reason);
    return 'waiting';
  }

  const adapter = (deps.adapters ?? adapterFor)(connection.provider);
  const epoch = await resumeEpoch(deps, campaign.id);
  const key = pauseIdempotencyKey(campaign.id, epoch);

  // ---- platform first, then our rows (see the header for why) ----

  const decision = decidePauseOutcome(await adapter.pause({ externalId: root.external_id }, key));

  if (decision.action === 'await_reconnect') {
    await markConnectionExpired(admin, connection.id, now);
    await announceBlocked(deps, campaign, roomId, 'auth_expired', decision.reason);
    log.warn(
      { campaignId: campaign.id, connectionId: connection.id },
      'the connection expired before spend could be stopped; the pause retries after reconnect',
    );
    return 'waiting';
  }

  if (decision.action === 'gone') {
    await announceBlocked(deps, campaign, roomId, 'not_found', decision.reason);
    log.error(
      { campaignId: campaign.id, externalId: root.external_id, message: decision.message },
      'the platform no longer recognises a campaign that breached its ceiling',
    );
    return 'gone';
  }

  if (decision.action === 'retry') {
    const line = { campaignId: campaign.id, kind: decision.kind, message: decision.message, key };
    if (decision.contractViolation) {
      log.error(line, 'the adapter refused a pause with an error kind a pause cannot produce');
    } else {
      log.warn(line, 'the platform did not accept the pause yet; the same key retries next pass');
    }
    return 'waiting';
  }

  // ---- the platform confirmed. Move our rows, conditionally. ----

  const { error: entityError } = await admin
    .from('ad_entities')
    .update({ state: 'paused' })
    .eq('id', root.id)
    .eq('state', 'live');
  if (entityError) throw entityError;

  const { data: moved, error: campaignError } = await admin
    .from('campaigns')
    .update({ state: 'paused', pause_reason: 'cpa_breach' })
    .eq('id', campaign.id)
    .eq('state', 'live')
    .select('id');
  if (campaignError) throw campaignError;

  if ((moved ?? []).length === 0) {
    // The crash-resume path: an earlier pass moved the row and died before
    // saying so. The trigger already audited the transition, so only the
    // enriched decision event is skipped; the message below has an idempotent
    // key and is posted regardless, so the owner is never left untold.
    log.info(
      { campaignId: campaign.id, key },
      'campaign was already paused; this pass is a replay finishing the announcement',
    );
  } else {
    await writeAutoPausedEvent(deps, campaign, {
      spend: verdict.spend,
      conversions: verdict.conversions,
      cpa_ceiling: verdict.cpaCeiling,
      allowance: verdict.allowance,
      provider: connection.provider,
      connection_id: connection.id,
      external_id: root.external_id,
      idempotency_key: key,
      already_existed: decision.alreadyExisted,
    });
  }

  await postPersonaMessage(
    admin,
    log,
    roomId,
    `campaign-paused:${campaign.id}:${epoch}`,
    `Your campaign "${campaign.name}" was paused because it crossed the cost per conversion ` +
      `ceiling you set. It spent ${verdict.spend} ${campaign.currency} for ` +
      `${verdict.conversions} conversion(s) against a ceiling of ${verdict.cpaCeiling} ` +
      `${campaign.currency} per conversion. To run it again, raise or clear the ceiling on ` +
      'the project panel, then resume it there.',
    'analyst',
  );

  log.info(
    {
      campaignId: campaign.id,
      spend: verdict.spend,
      conversions: verdict.conversions,
      cpaCeiling: verdict.cpaCeiling,
      alreadyExisted: decision.alreadyExisted,
    },
    'campaign paused on a cpa ceiling breach',
  );
  return 'paused';
}

/* ---------------------------------------------------------------- utilities */

/**
 * Tell the owner why spend cannot be stopped, once per reason.
 *
 * The rule is in the key, as both sibling sweeps do it. Its own wording rather
 * than either sibling's: "waiting to publish" is false for a live campaign, and
 * "performance is not being recorded" understates a campaign that is spending
 * past its ceiling with nothing able to stop it.
 */
async function announceBlocked(
  deps: OptimizeSweepDeps,
  campaign: OptimizableCampaign,
  roomId: string,
  rule: string,
  reason: string,
): Promise<void> {
  await postPersonaMessage(
    deps.admin,
    deps.log,
    roomId,
    `campaign-pause-blocked:${campaign.id}:${rule}`,
    `Your campaign "${campaign.name}" has crossed the cost per conversion ceiling you set, ` +
      `and I cannot stop its spend from here. ${reason} ` +
      'I will keep trying to pause it until it lands.',
    'analyst',
  );
  deps.log.info({ campaignId: campaign.id, rule }, 'a breached campaign cannot be paused yet');
}

/**
 * The decision, which the trigger-written transition cannot carry.
 *
 * `campaigns_guard_transition` records that the state moved and why in one
 * word; this carries the arithmetic a person or the analytics module needs to
 * see the decision was sound: what was spent, for how many conversions, against
 * what ceiling. It is the producer of the "auto-pause events" line analytics.md
 * has carried without one.
 *
 * Never throws, and written only when this pass actually moved the row, because
 * `events` has no unique key and a crash-replay writing it again would put two
 * decisions in the trail where one act happened.
 */
async function writeAutoPausedEvent(
  deps: OptimizeSweepDeps,
  campaign: OptimizableCampaign,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.admin.from('events').insert({
    project_id: campaign.project_id,
    // No actor. The authorisation was the owner typing the ceiling, and that
    // act has its own event with their id on it; this is machinery carrying it
    // out, and attributing the pause to them would misdate their decision.
    actor_kind: 'system',
    verb: 'campaign.auto_paused',
    subject_type: 'campaign',
    subject_id: campaign.id,
    payload,
  });
  if (error) {
    deps.log.error(
      { err: error, campaignId: campaign.id },
      'a campaign was paused but the decision event was not written',
    );
  }
}
