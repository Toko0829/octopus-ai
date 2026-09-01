import type { SupabaseClient } from '@supabase/supabase-js';
import type { NodeEngagement, TaskState } from '@octopus/contracts';
import { checkSpendCap } from '@octopus/marketing';
import { carriesRealMoney, escrowKey, providerFor } from '@octopus/payments';
import { readSpendInputs } from './spend-reads';

/**
 * Accepting an offer, from the node's side, and reading back what they took.
 *
 * **The refusals here are readable and the SQL is authoritative**, which is
 * [ADR-0011](../../../../docs/40-adr/0011-spend-cap-checked-twice.md)'s split
 * applied to acceptance rather than to campaign approval. Every pre-check below
 * is duplicated inside `public.accept_offer`, on purpose:
 *
 *   * this side exists so a person is told *which* thing stopped them, in a
 *     sentence, before anything is written;
 *   * that side exists because two nodes accepting two steps on one project at
 *     the same instant both pass a check made here, since each reads the
 *     committed total before either writes. The row lock in SQL is what actually
 *     holds the ceiling.
 *
 * A pre-check that passes and a raise that follows is therefore not a bug, it is
 * the race being caught by the layer that can catch it, and the route surfaces
 * the raise's own message rather than a generic 409.
 *
 * **The provider is called before the rpc, and the refusal is before that.**
 * `carriesRealMoney` is the enforced half of payments-billing.md's counsel gate:
 * the first person to register a real provider hits a failing write here rather
 * than a paragraph they did not read. Nothing in this build charges anything.
 */

/** Postgres SQLSTATEs the caller translates into HTTP. */
export const PG_CHECK_VIOLATION = '23514';

export type AcceptRefusalRule =
  | 'not_found'
  | 'not_open'
  | 'expired'
  | 'hourly_rate'
  | 'no_rate'
  | 'currency_mismatch'
  | 'no_ceiling'
  | 'exceeds_ceiling'
  | 'real_money_refused';

export type AcceptPrecheck =
  | { ok: true; price: number; currency: string; projectId: string; taskId: string }
  | { ok: false; rule: AcceptRefusalRule; reason: string };

interface OfferRow {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  status: string;
  expires_at: string;
}

interface NodeRateRow {
  rate: number | string | null;
  rate_period: string | null;
  currency: string | null;
}

/**
 * Read the offer **as the caller**, so a stranger asking about somebody else's
 * offer gets nothing rather than a refusal that confirms it exists.
 *
 * `offers_select_own` is `node_id = auth.uid()`, so this needs no `.eq('node_id',
 * …)` to be correct. It carries one anyway, which is the defense-in-depth this
 * repository applies everywhere: the policy is the control, the filter is what
 * makes the query say what it means.
 */
export async function readOwnOffer(
  db: SupabaseClient,
  offerId: string,
  nodeId: string,
): Promise<OfferRow | null> {
  const { data, error } = await db
    .from('offers')
    .select('id, task_id, project_id, node_id, status, expires_at')
    .eq('id', offerId)
    .eq('node_id', nodeId)
    .maybeSingle();
  if (error) throw error;
  return (data as OfferRow | null) ?? null;
}

/**
 * Everything that can be said no to before anything is written.
 *
 * Reads the node's rate and the project's committed totals with the service key,
 * because a node has no grant on `node_profiles` beyond their own row and none
 * at all on `projects` or `campaigns`. The authorisation was `readOwnOffer`
 * above; this is arithmetic on rows that authorisation already reached.
 *
 * `now` is passed in so a test can stand at either side of an expiry. Postgres
 * makes the same comparison against its own clock inside `accept_offer`, and
 * that one decides.
 */
export async function precheckAccept(
  admin: SupabaseClient,
  offer: OfferRow,
  now: Date = new Date(),
): Promise<AcceptPrecheck> {
  if (offer.status !== 'open') {
    return {
      ok: false,
      rule: 'not_open',
      reason: 'That offer is no longer open, so there is nothing to accept.',
    };
  }
  if (new Date(offer.expires_at).getTime() <= now.getTime()) {
    return {
      ok: false,
      rule: 'expired',
      reason: 'That offer has expired, so the step has gone back to the marketplace.',
    };
  }

  const { data: nodeRow, error: nodeError } = await admin
    .from('node_profiles')
    .select('rate, rate_period, currency')
    .eq('user_id', offer.node_id)
    .maybeSingle();
  if (nodeError) throw nodeError;
  const node = nodeRow as NodeRateRow | null;
  if (!node) {
    return { ok: false, rule: 'not_found', reason: 'You do not have a marketplace profile.' };
  }

  if (node.rate === null) {
    return {
      ok: false,
      rule: 'no_rate',
      reason: 'Set your rate before accepting work. The price of a step is your rate.',
    };
  }
  // **Defense in depth behind the pool filter.** `readEligiblePool` excludes
  // hourly nodes, so an hourly node is never offered anything; this catches a
  // node who changed their rate period after being offered. An hourly rate is a
  // price per hour and an escrow hold is a total, so funding one as the other
  // would hold an arbitrary fraction of a real bill against somebody's ceiling.
  if (node.rate_period !== 'task') {
    return {
      ok: false,
      rule: 'hourly_rate',
      reason:
        'Work is funded as a whole amount, so only a per-step rate can be accepted. ' +
        'Change your rate to a price per step.',
    };
  }

  const price = Number(node.rate);
  const reads = await readSpendInputs(admin, offer.project_id);

  if ((node.currency ?? 'USD') !== reads.currency) {
    return {
      ok: false,
      rule: 'currency_mismatch',
      reason: `This step is budgeted in ${reads.currency} and your rate is in ${node.currency}.`,
    };
  }

  // The same arithmetic `accept_offer` performs under a row lock, over both
  // committer classes (ADR-0020). `proposedCap` is the node's price: a hold is a
  // commitment against the ceiling exactly as a campaign cap is, which is why it
  // goes through `checkSpendCap` rather than through a second sum written here.
  const verdict = checkSpendCap({
    projectBudgetCeiling: reads.projectBudgetCeiling,
    existingCampaignCaps: reads.existingCampaignCaps,
    existingEscrowHolds: reads.escrowHeld,
    proposedCap: price,
  });

  if (!verdict.allowed) {
    if (verdict.rule === 'no_ceiling_authorised') {
      return {
        ok: false,
        rule: 'no_ceiling',
        reason:
          'This step has no authorised budget behind it yet, so it cannot be funded. ' +
          'The owner has been left to set one.',
      };
    }
    return {
      ok: false,
      // `invalid_amount` lands here too, and deliberately: an unusable number is
      // a refusal to fund, and the verdict carries its own sentence either way.
      rule: 'exceeds_ceiling',
      reason: verdict.reason,
    };
  }

  return {
    ok: true,
    price,
    currency: reads.currency,
    projectId: offer.project_id,
    taskId: offer.task_id,
  };
}

/**
 * Mint the provider reference for this acceptance.
 *
 * **Refuses a provider that moves real money before it is ever called.** See
 * `provider-registry.ts`: the counsel gate in payments-billing.md is a
 * paragraph, and this is the control that makes it real. `carriesRealMoney`
 * raises on an unregistered name rather than answering `false`, so an unreviewed
 * provider is refused rather than assumed harmless.
 *
 * The key is derived from the offer, so a retried accept asks for the same
 * charge and is handed the same reference, which is what the replayed
 * `accept_offer` then finds already stored against the hold.
 */
export async function chargeForOffer(offerId: string, price: number, currency: string) {
  const provider = 'fake';
  if (carriesRealMoney(provider)) {
    throw new Error(
      `Payment provider "${provider}" moves real money. Escrow is modelled and nothing is ` +
        'charged in this build; clear the counsel gate in docs/30-modules/payments-billing.md ' +
        'before registering a provider that does.',
    );
  }
  return providerFor(provider).createCharge({
    amount: price,
    currency,
    idempotencyKey: escrowKey(offerId),
  });
}

/* ------------------------------------------------------------ projections */

const ENGAGEMENT_COLUMNS =
  'id, task_id, project_id, node_id, agreed_price, currency, accepted_at, ended_at, outcome';

interface EngagementRow {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  agreed_price: number | string;
  currency: string;
  accepted_at: string;
  ended_at: string | null;
  outcome: NodeEngagement['outcome'];
}

/**
 * The node's accepted work, newest first.
 *
 * **The projection is the access control**, exactly as it is for offers and for
 * channel connections. A node has no grant on `tasks` and gains none: the four
 * task fields are read with the service key and copied in. What this projection
 * adds that `NodeOffer` refuses is `roomId` and `threadId`, and that is the
 * admission itself rather than a leak: `room_members` already carries both for
 * this person, and their own client cannot read or post in their thread without
 * them.
 *
 * Settled engagements are returned rather than filtered out, on `readNodeOffers`'
 * reasoning: a person's own history is theirs, and a list that empties when a
 * step ends reads as though something was lost.
 */
export async function readNodeEngagements(
  admin: SupabaseClient,
  nodeId: string,
): Promise<NodeEngagement[]> {
  const { data, error } = await admin
    .from('engagements')
    .select(ENGAGEMENT_COLUMNS)
    .eq('node_id', nodeId)
    .order('accepted_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as EngagementRow[];
  if (rows.length === 0) return [];
  return projectEngagements(admin, rows);
}

/** One engagement, for the accept response. */
export async function readEngagement(
  admin: SupabaseClient,
  engagementId: string,
): Promise<NodeEngagement | null> {
  const { data, error } = await admin
    .from('engagements')
    .select(ENGAGEMENT_COLUMNS)
    .eq('id', engagementId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [projected] = await projectEngagements(admin, [data as EngagementRow]);
  return projected ?? null;
}

/**
 * Two reads for the whole list rather than two per row, which is the `readNodeOffers`
 * shape: the tasks in one `in` query and the threads in another.
 */
async function projectEngagements(
  admin: SupabaseClient,
  rows: EngagementRow[],
): Promise<NodeEngagement[]> {
  const taskIds = [...new Set(rows.map((r) => r.task_id))];

  const { data: taskRows, error: taskError } = await admin
    .from('tasks')
    .select('id, title, stage, detail, state')
    .in('id', taskIds);
  if (taskError) throw taskError;

  const { data: threadRows, error: threadError } = await admin
    .from('threads')
    .select('id, room_id, task_id')
    .in('task_id', taskIds);
  if (threadError) throw threadError;

  const taskById = new Map(
    (taskRows ?? []).map((t) => [
      t.id as string,
      {
        title: (t.title as string) ?? '',
        stage: (t.stage as string | null) ?? null,
        detail: (t.detail as string | null) ?? null,
        state: t.state as TaskState,
      },
    ]),
  );
  const threadByTask = new Map(
    (threadRows ?? []).map((t) => [
      t.task_id as string,
      { threadId: t.id as string, roomId: t.room_id as string },
    ]),
  );

  return rows.map((row) => {
    const thread = threadByTask.get(row.task_id);
    return {
      id: row.id,
      // numeric(12,2) arrives as a string over PostgREST. Converted here so a
      // client renders a number rather than sorting money as text.
      agreedPrice: Number(row.agreed_price),
      currency: row.currency,
      acceptedAt: row.accepted_at,
      endedAt: row.ended_at,
      outcome: row.outcome,
      task: taskById.get(row.task_id) ?? {
        title: '',
        stage: null,
        detail: null,
        state: 'pending' as TaskState,
      },
      roomId: thread?.roomId ?? null,
      threadId: thread?.threadId ?? null,
    };
  });
}

/**
 * Record a node's acceptance, against the project rather than against the node.
 *
 * `auditOfferDeclined`'s shape exactly, and for its reasons: `auditNode` writes
 * `project_id: null` and `subject_type: 'node'`, which is right for a claim
 * somebody makes about themselves and wrong for an act on somebody else's
 * project. `actor_id` is explicit because this runs under the service key, so
 * the `auth.uid()` idiom the SQL writers use would file a person's decision as
 * the system's.
 *
 * `accept_offer` already wrote `engagement.created`, and the offer's guard
 * trigger already wrote `offer.transitioned`. This carries what neither can: who
 * accepted, as themselves.
 *
 * Never throws.
 */
export async function auditOfferAccepted(
  admin: SupabaseClient,
  event: {
    projectId: string;
    nodeId: string;
    offerId: string;
    taskId: string;
    engagementId: string;
    price: number;
    currency: string;
  },
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const { error } = await admin.from('events').insert({
    project_id: event.projectId,
    actor_id: event.nodeId,
    actor_kind: 'node',
    verb: 'offer.accepted',
    subject_type: 'offer',
    subject_id: event.offerId,
    payload: {
      task_id: event.taskId,
      node_id: event.nodeId,
      engagement_id: event.engagementId,
      agreed_price: event.price,
      currency: event.currency,
    },
  });
  if (error) log?.error({ err: error, offerId: event.offerId }, 'offer acceptance not recorded');
}
