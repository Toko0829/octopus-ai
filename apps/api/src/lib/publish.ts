import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adapterFor,
  checkScopes,
  chooseConnection,
  CreateCampaignSpec,
  decidePublishOutcome,
  publishIdempotencyKey,
  PUBLISH_REQUIRED_SCOPES,
  type AdChannelAdapter,
  type PublishDecision,
} from '@octopus/marketing';
import { markConnectionExpired, readPublishableConnections } from './connections';
import { postSystemMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * The first thing in this system that acts outside it.
 *
 * `20260829140000` gave `campaigns` a writer and left it at `ready`, which means
 * a person authorised a budget and nothing happened. `ad_entities` has had its
 * guards since `20260829122000` and no writer at all. This sweep closes both: it
 * takes campaigns a person approved, publishes the campaign-level entity through
 * the registered provider, and moves `ready -> publishing -> live`.
 *
 * **The approval is the authorisation.** There is no second button, because the
 * card already asked the only question there is to ask and asking it twice is how
 * a confirmation becomes something people click through (ADR-0013). What that
 * buys is a copy obligation rather than a free pass: the card used to say
 * "nothing is published or spent", and this slice changes those sentences in the
 * same commit, because a promise altered on a trust surface has to be altered
 * where it was made.
 *
 * **Postgres has no transaction across a platform call**, and that single fact
 * shapes the whole ordering below. The intent row is written BEFORE the call,
 * under a key derived from the campaign id alone, so every crash point leaves a
 * state the next pass re-enters rather than a decision nobody recorded:
 *
 *   1. crash after the intent row  -> the key collides, the row is found, resume
 *   2. crash after `ready -> publishing` -> the campaign is selected again
 *   3. crash after the platform answered, before anything was recorded
 *                                  -> the same key is asked again, the provider
 *                                     returns the same id (`alreadyExisted`)
 *   4. crash after the entity was finished, before the campaign was
 *                                  -> `external_id` is present, the adapter is
 *                                     skipped entirely, the campaign finishes
 *
 * **What it publishes is one entity, and the limit is named rather than
 * implied.** `createCampaign` only: no ad sets and no ads, because `CreateAdSpec`
 * requires creative and nothing in this product produces creative yet (slice 6).
 * An ad set with no ad under it spends nothing and shows nothing, so publishing
 * the empty middle of the tree would be structure with no content. `setBudget` is
 * not called either, since `CreateCampaignSpec.budgetCap` already carries the
 * authorised cap into the create.
 *
 * **Nothing here re-derives an authorisation.** The cap was checked twice at
 * approval time (ADR-0011) and is read off the row; the spec is built from the
 * approved campaign rather than regenerated, which is what `ad_entities.spec`
 * exists to guarantee. This file's job is to carry out a decision, not to make
 * one.
 */

/** A campaign this pass may act on, as the table holds it. */
export interface PublishableCampaign {
  id: string;
  project_id: string;
  name: string;
  objective: string | null;
  channel: string;
  state: string;
  /** `numeric(12,2)`, which PostgREST hands back as a string. */
  budget_cap: number | string | null;
  currency: string;
  created_at: string;
}

/**
 * Which campaigns this pass takes, and in what order.
 *
 * **`ready` outranks `publishing`, deliberately.** A `publishing` row is either a
 * resume or a retry, and both can recur for as long as a platform stays unhappy.
 * A newly approved campaign has somebody watching for it. Draining retries first
 * would let one persistently failing campaign hold the cap and starve every
 * approval behind it, which is a queue that looks broken to the only person who
 * would notice.
 *
 * Oldest first within each group, so the cap can never starve a particular row:
 * whatever is skipped this pass is the newest of its group and will be the oldest
 * soon enough. Same argument `selectDueSources` makes for the crawl.
 */
export function selectPublishable(
  campaigns: PublishableCampaign[],
  cap: number,
): PublishableCampaign[] {
  const byAge = (a: PublishableCampaign, b: PublishableCampaign) => {
    const at = new Date(a.created_at).getTime();
    const bt = new Date(b.created_at).getTime();
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return at - bt;
  };

  return [
    ...campaigns.filter((c) => c.state === 'ready').sort(byAge),
    ...campaigns.filter((c) => c.state === 'publishing').sort(byAge),
  ].slice(0, cap);
}

/**
 * A money column as a number, or null.
 *
 * **`Number(null)` is `0`**, and that is the whole reason this exists rather than
 * an inline cast. A campaign row with no `budget_cap` would otherwise parse
 * cleanly into a spec authorising zero and publish, reporting success. It is the
 * same shape as the `jsonb_typeof(...) <> 'number'` defect `20260829140000`
 * shipped and its own suite caught, and as the `NaN` case `checkSpendCap` guards:
 * not an error, not a type mismatch, a wrong answer wearing the shape of a right
 * one.
 */
function toAmount(value: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface PublishSweepDeps {
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

export interface PublishSweepResult {
  attempted: number;
  published: number;
  /** Reached a terminal state without publishing. Not retried. */
  failed: number;
  /** Left where it was, on purpose. The next pass tries again. */
  waiting: number;
}

type Outcome = 'published' | 'failed' | 'waiting';

/**
 * How many campaigns one read may consider.
 *
 * Generous rather than tight: `selectPublishable` applies the real cap, and this
 * only bounds the read so a pathological backlog cannot pull an unbounded result
 * set into memory. Ordered oldest first so the bound can never hide the rows that
 * have been waiting longest, which is the failure a naive limit would introduce.
 */
const CANDIDATE_READ_LIMIT = 200;

export async function publishSweep(deps: PublishSweepDeps): Promise<PublishSweepResult> {
  const now = deps.now?.() ?? new Date();
  const result: PublishSweepResult = { attempted: 0, published: 0, failed: 0, waiting: 0 };

  const { data: rows, error } = await deps.admin
    .from('campaigns')
    .select('id, project_id, name, objective, channel, state, budget_cap, currency, created_at')
    .in('state', ['ready', 'publishing'])
    .order('created_at', { ascending: true })
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const candidates = (rows ?? []) as PublishableCampaign[];
  if (candidates.length === 0) return result;

  // Two plain reads rather than an embedded join, for `roomForProject`'s reason:
  // PostgREST relationship guessing fails silently, and a silent failure on the
  // publish path is the one thing this file cannot have.
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
    // Not silent. A campaign whose project was paused or completed will never
    // publish, and "nothing happened and nobody said why" is the defect shape
    // this repository keeps finding.
    deps.log.info({ skipped }, 'campaigns skipped because their project is not active');
  }

  for (const campaign of selectPublishable(live, deps.maxPerPass)) {
    result.attempted += 1;
    try {
      result[await publishOne(deps, campaign, now)] += 1;
    } catch (err) {
      // Per campaign, exactly as a tick is per project. A transport failure or an
      // unexpected throw leaves this campaign where it was and must not cost the
      // others their pass. The same key re-drives next time.
      result.waiting += 1;
      deps.log.error(
        { err, campaignId: campaign.id, projectId: campaign.project_id },
        'could not publish a campaign; it stays where it was and the next pass retries',
      );
    }
  }

  deps.log.info(result, 'publish sweep complete');
  return result;
}

/* ------------------------------------------------------------------ one campaign */

interface AdEntityRow {
  id: string;
  state: string;
  external_id: string | null;
}

async function publishOne(
  deps: PublishSweepDeps,
  campaign: PublishableCampaign,
  now: Date,
): Promise<Outcome> {
  const { admin, log } = deps;

  const roomId = await roomForProject(admin, campaign.project_id);
  if (!roomId) {
    // Connections are room-scoped, so with no room there is no account to
    // publish through and nobody to tell about it either.
    log.warn(
      { campaignId: campaign.id, projectId: campaign.project_id },
      'campaign has no room, so it cannot be published or explained',
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
    requiredScopes: [...PUBLISH_REQUIRED_SCOPES],
    status: connection.status,
  });
  if (!scopes.allowed) {
    await announceBlocked(deps, campaign, roomId, scopes.rule, scopes.reason);
    return 'waiting';
  }

  // ---- the approved brief, read rather than regenerated ----

  const budgetCap = toAmount(campaign.budget_cap);
  if (budgetCap === null) {
    log.error(
      { campaignId: campaign.id },
      'campaign is approved with no usable budget cap; refusing to publish it',
    );
    await announceBlocked(
      deps,
      campaign,
      roomId,
      'no_budget_cap',
      'This campaign has no authorised budget on it, so it cannot be published. ' +
        'That is a defect on our side rather than something you did.',
    );
    return 'waiting';
  }

  const spec = CreateCampaignSpec.safeParse({
    name: campaign.name,
    objective: campaign.objective ?? undefined,
    channel: campaign.channel,
    budgetCap,
    currency: campaign.currency,
  });
  if (!spec.success) {
    log.error(
      { campaignId: campaign.id, issues: spec.error.issues },
      'approved campaign does not form a valid spec; refusing to publish it',
    );
    await announceBlocked(
      deps,
      campaign,
      roomId,
      'invalid_spec',
      'This campaign cannot be turned into a valid request for the platform. ' +
        'That is a defect on our side rather than something you did.',
    );
    return 'waiting';
  }

  // ---- the intent row, before the call ----

  const key = publishIdempotencyKey(campaign.id);
  const entity = await ensureIntentRow(deps, campaign, connection.id, spec.data, key);

  // ---- ready -> publishing ----

  if (campaign.state === 'ready') {
    const { data: moved, error: moveError } = await admin
      .from('campaigns')
      .update({ state: 'publishing' })
      .eq('id', campaign.id)
      .eq('state', 'ready')
      .select('id')
      .maybeSingle();
    if (moveError) throw moveError;

    if (!moved) {
      // Something else moved it while this pass was reading. The only legal exit
      // from `ready` other than `publishing` is `cancelled`, so re-read rather
      // than assume, and stop BEFORE the platform is called: a cancelled
      // campaign must never reach anybody's ad account.
      const { data: current } = await admin
        .from('campaigns')
        .select('state')
        .eq('id', campaign.id)
        .maybeSingle<{ state: string }>();

      if (current?.state !== 'publishing') {
        await moveEntity(deps, entity.id, 'publishing', 'failed');
        log.info(
          { campaignId: campaign.id, state: current?.state ?? 'unknown' },
          'campaign left ready before it could be published; nothing was sent',
        );
        return 'failed';
      }
    }
  }

  // ---- an entity already closed finishes closing, and is never re-asked ----

  // The narrow crash this covers: the platform refused, we moved the entity to
  // `rejected` or `failed`, and the process died before the campaign followed.
  // Re-asking would be wrong in the one direction that matters, because a
  // platform that changed its mind would leave a campaign `live` while the
  // entity holding its `external_id` stayed closed, and nothing would point at
  // the object now spending. A closed entity is a decision already taken; this
  // finishes recording it.
  if (entity.state === 'rejected' || entity.state === 'failed') {
    const { error: closeError } = await admin
      .from('campaigns')
      .update({ state: 'failed' })
      .eq('id', campaign.id)
      .eq('state', 'publishing');
    if (closeError) throw closeError;
    log.info(
      { campaignId: campaign.id, entityState: entity.state },
      'the ad entity was already closed, so the campaign was closed to match',
    );
    return 'failed';
  }

  // ---- the call, or the answer we already have ----

  let decision: PublishDecision;
  if (entity.external_id) {
    // The crash-after-the-answer case. The platform already made this object;
    // asking again would be a second request for a side effect we can see the
    // result of. `alreadyExisted` is true because that is exactly what happened.
    decision = { action: 'confirm', externalId: entity.external_id, alreadyExisted: true };
  } else {
    const adapter = (deps.adapters ?? adapterFor)(connection.provider);
    decision = decidePublishOutcome(await adapter.createCampaign(spec.data, key));
  }

  return finish(deps, campaign, roomId, entity, connection, decision, now);
}

/**
 * Write what we are about to do, or find what we already wrote.
 *
 * Insert-and-tolerate-`23505` rather than read-then-write, which is the house
 * idiom and here also the correctness argument: two passes racing both insert,
 * one wins in Postgres, and the loser reads the winner's row instead of creating
 * a rival intent under a second key.
 *
 * The row is written at `publishing` rather than at `draft` and immediately moved,
 * because a draft that existed for one statement is a state the system was never
 * really in and would put a transition in the audit trail that describes nothing.
 */
async function ensureIntentRow(
  deps: PublishSweepDeps,
  campaign: PublishableCampaign,
  connectionId: string,
  spec: CreateCampaignSpec,
  key: string,
): Promise<AdEntityRow> {
  const { data: created, error } = await deps.admin
    .from('ad_entities')
    .insert({
      campaign_id: campaign.id,
      project_id: campaign.project_id,
      kind: 'campaign',
      parent_id: null,
      state: 'publishing',
      spec,
      idempotency_key: key,
      channel_connection_id: connectionId,
    })
    .select('id, state, external_id')
    .maybeSingle<AdEntityRow>();

  if (error && error.code !== '23505') throw error;
  if (created) return created;

  const { data: existing, error: readError } = await deps.admin
    .from('ad_entities')
    .select('id, state, external_id')
    .eq('idempotency_key', key)
    .maybeSingle<AdEntityRow>();
  if (readError) throw readError;
  if (!existing) {
    throw new Error(`intent row for ${key} collided on insert but could not be read back`);
  }
  return existing;
}

/** Record the outcome, in the order that makes each crash point recoverable. */
async function finish(
  deps: PublishSweepDeps,
  campaign: PublishableCampaign,
  roomId: string,
  entity: AdEntityRow,
  connection: { id: string; provider: string },
  decision: PublishDecision,
  now: Date,
): Promise<Outcome> {
  const { admin, log } = deps;

  if (decision.action === 'confirm') {
    // One statement for the id and the state. The write-once guard permits the
    // same value being written again, which is what makes the resume path free.
    const { error: entityError } = await admin
      .from('ad_entities')
      .update({ external_id: decision.externalId, state: 'live' })
      .eq('id', entity.id)
      .eq('state', 'publishing');
    if (entityError) throw entityError;

    const { error: campaignError } = await admin
      .from('campaigns')
      .update({ state: 'live' })
      .eq('id', campaign.id)
      .eq('state', 'publishing');
    if (campaignError) throw campaignError;

    await writeEvent(deps, campaign, 'campaign.published', {
      external_id: decision.externalId,
      provider: connection.provider,
      connection_id: connection.id,
      ad_entity_id: entity.id,
      // True both when the provider recognised the key and when we resumed onto
      // an id already recorded. Either way this pass created nothing new, and
      // the audit trail should not read as though it did.
      already_existed: decision.alreadyExisted,
    });

    await postSystemMessage(
      deps.admin,
      deps.log,
      roomId,
      `campaign-published:${campaign.id}`,
      `Your campaign "${campaign.name}" is live. ` +
        `It will not spend more than the ${campaign.budget_cap} ${campaign.currency} you authorised.`,
    );

    log.info(
      {
        campaignId: campaign.id,
        externalId: decision.externalId,
        alreadyExisted: decision.alreadyExisted,
      },
      'campaign published',
    );
    return 'published';
  }

  if (decision.action === 'reject' || decision.action === 'stop') {
    await moveEntity(
      deps,
      entity.id,
      'publishing',
      decision.action === 'reject' ? 'rejected' : 'failed',
    );

    const { error: campaignError } = await admin
      .from('campaigns')
      .update({ state: 'failed' })
      .eq('id', campaign.id)
      .eq('state', 'publishing');
    if (campaignError) throw campaignError;

    await writeEvent(
      deps,
      campaign,
      decision.action === 'reject' ? 'campaign.publish_rejected' : 'campaign.publish_failed',
      {
        kind: decision.kind,
        // The platform's own words, unparaphrased. This is the sentence somebody
        // will read to decide what to change.
        message: decision.message,
        detail: decision.action === 'reject' ? decision.detail : undefined,
        provider: connection.provider,
        connection_id: connection.id,
        ad_entity_id: entity.id,
      },
    );

    await postSystemMessage(
      deps.admin,
      deps.log,
      roomId,
      `campaign-publish-outcome:${campaign.id}`,
      decision.action === 'reject'
        ? `The platform did not approve your campaign "${campaign.name}". ` +
            `It said: ${decision.message} ` +
            'This campaign is closed and nothing was spent. To try again, approve a new ' +
            'campaign card with the wording changed; it will carry its own budget.'
        : `Your campaign "${campaign.name}" could not be published. ` +
            `The platform said: ${decision.message} ` +
            'This campaign is closed and nothing was spent. This looks like a fault on our ' +
            'side, so approving the same thing again is unlikely to help until it is fixed.',
    );

    log.warn(
      { campaignId: campaign.id, kind: decision.kind, message: decision.message },
      'campaign was not published and is closed',
    );
    return 'failed';
  }

  if (decision.action === 'await_reconnect') {
    // Recorded so the panel and the next scope check both tell the truth. The
    // campaign stays at `publishing`: the same key republishes once the owner
    // reconnects, and nothing was lost by waiting.
    await markConnectionExpired(admin, connection.id, now);
    await announceBlocked(deps, campaign, roomId, 'auth_expired', decision.reason);
    log.warn(
      { campaignId: campaign.id, connectionId: connection.id },
      'the connection expired mid-publish; the campaign waits for a reconnect',
    );
    return 'waiting';
  }

  // `retry`. Nothing moves and nobody is told, on purpose: a rate limit or a
  // provider blip is not something an owner can act on, and a message every
  // thirty seconds about a condition that fixes itself is noise on the surface
  // where the important messages live. Unbounded at tick cadence, because
  // `failed` is terminal in Postgres and a bound tripping on a transient outage
  // would close a campaign somebody authorised.
  log.warn(
    {
      campaignId: campaign.id,
      kind: decision.kind,
      message: decision.message,
      retryAfterMs: decision.retryAfterMs,
    },
    'publishing was refused for now; the same key retries on the next pass',
  );
  return 'waiting';
}

/* ---------------------------------------------------------------- utilities */

async function moveEntity(
  deps: PublishSweepDeps,
  entityId: string,
  from: string,
  to: string,
): Promise<void> {
  const { error } = await deps.admin
    .from('ad_entities')
    .update({ state: to })
    .eq('id', entityId)
    .eq('state', from);
  if (error) throw error;
}

/**
 * Tell the owner what is in the way, once per reason.
 *
 * The rule is in the key, so a campaign blocked first on a missing account and
 * later on a missing scope says both things once rather than the first thing
 * forever. Without the rule in the key, fixing one blocker would leave the room
 * silent about the next one.
 */
async function announceBlocked(
  deps: PublishSweepDeps,
  campaign: PublishableCampaign,
  roomId: string,
  rule: string,
  reason: string,
): Promise<void> {
  await postSystemMessage(
    deps.admin,
    deps.log,
    roomId,
    `campaign-publish-blocked:${campaign.id}:${rule}`,
    `Your campaign "${campaign.name}" is approved and waiting to publish. ${reason} ` +
      'Connected accounts are listed beside this conversation. Nothing has been spent.',
  );
  deps.log.info({ campaignId: campaign.id, rule }, 'campaign is approved but cannot publish yet');
}

/**
 * The why behind a transition the trigger already recorded.
 *
 * `campaigns_guard_transition` writes `campaign.transitioned` itself and must not
 * be duplicated here. What it cannot know is which account was used, what the
 * platform called the object, and what it said when it refused, so that is what
 * these carry.
 *
 * Never throws: an event that failed to write must not undo a publish that
 * happened. Same stance `auditConnection` and the embed route take.
 */
async function writeEvent(
  deps: PublishSweepDeps,
  campaign: PublishableCampaign,
  verb: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await deps.admin.from('events').insert({
    project_id: campaign.project_id,
    // No actor. This is machinery carrying out a decision somebody already made,
    // and attributing it to them would misdate their act by however long the
    // campaign sat in the queue.
    actor_kind: 'system',
    verb,
    subject_type: 'campaign',
    subject_id: campaign.id,
    payload,
  });
  if (error) {
    deps.log.error(
      { err: error, campaignId: campaign.id, verb },
      'campaign publish state changed but the event was not recorded',
    );
  }
}
