import type { SupabaseClient } from '@supabase/supabase-js';
import type { NodeOffer } from '@octopus/contracts';

/**
 * Reading and declining offers, from the node's side.
 *
 * The matcher sweep writes offers; this is everything the person they were made
 * to can do about one, which in this slice is read them and say no. Accepting
 * lives with escrow.
 *
 * **Neither function reads or writes `tasks.state`.** The sweep is the single
 * writer there, and the read below deliberately takes only three task columns to
 * render a card. That split is what keeps a decline from racing a cascade.
 */

/**
 * Columns, as a constant, for the reason `CAMPAIGN_COLUMNS` is one: a PostgREST
 * select is a string, so a column the parser requires and the query omits is
 * invisible to the type checker and surfaces as a runtime complaint about a
 * value nobody sent. That defect has shipped twice in this repository.
 */
const OFFER_COLUMNS =
  'id, task_id, project_id, node_id, round, status, expires_at, created_at, declined_at, decline_reason';

interface OfferRow {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  round: number;
  status: NodeOffer['status'];
  expires_at: string;
  created_at: string;
  declined_at: string | null;
  decline_reason: string | null;
}

/**
 * Every offer this node has, newest first, settled ones included.
 *
 * Settled offers are returned rather than filtered out because the node's own
 * history is theirs to see, and because a list that silently empties after a
 * decline reads as though the decline lost something.
 *
 * **An expired offer is presented as expired even before the sweep settles the
 * row.** Expiry is a timestamp compared at read time (the `20260831120000:56-59`
 * rule: a status a clock must write is wrong between sweeps), so the projection
 * derives it rather than trusting the column. Without this a node could open a
 * live-looking offer, click Decline, and be told it had expired.
 */
export async function readNodeOffers(
  admin: SupabaseClient,
  nodeId: string,
  now: Date = new Date(),
): Promise<NodeOffer[]> {
  const { data, error } = await admin
    .from('offers')
    .select(OFFER_COLUMNS)
    .eq('node_id', nodeId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const rows = (data ?? []) as OfferRow[];
  if (rows.length === 0) return [];

  // Read service-side. The node has no grant on `tasks` and gains none here; the
  // three fields below are what a person needs to judge whether they want the
  // work, and nothing on this list identifies the owner.
  const { data: taskRows, error: taskError } = await admin
    .from('tasks')
    .select('id, title, stage, detail')
    .in(
      'id',
      rows.map((r) => r.task_id),
    );
  if (taskError) throw taskError;

  const taskById = new Map(
    (taskRows ?? []).map((t) => [
      t.id as string,
      {
        title: (t.title as string) ?? '',
        stage: (t.stage as string | null) ?? null,
        detail: (t.detail as string | null) ?? null,
      },
    ]),
  );

  return rows.map((row) => ({
    id: row.id,
    status: presentedStatus(row, now),
    round: row.round,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
    task: taskById.get(row.task_id) ?? { title: '', stage: null, detail: null },
  }));
}

/** `open` past its deadline is `expired`, whether or not a sweep has run. */
function presentedStatus(row: OfferRow, now: Date): NodeOffer['status'] {
  if (row.status === 'open' && new Date(row.expires_at).getTime() <= now.getTime()) {
    return 'expired';
  }
  return row.status;
}

export type DeclineOutcome =
  | { kind: 'declined'; offer: NodeOffer; taskId: string; projectId: string; round: number }
  | { kind: 'replayed'; offer: NodeOffer; taskId: string }
  | { kind: 'expired' }
  | { kind: 'settled' }
  | { kind: 'not_found' };

/**
 * Decline one offer, if it is the caller's and still open.
 *
 * The write is a single conditional UPDATE carrying every precondition, so two
 * clicks racing cannot both win and no read-then-write window exists:
 * `expires_at > now()` is evaluated by Postgres against its own clock rather
 * than ours, which matters because a node's browser and this process disagree by
 * seconds and the deadline is the difference between a decline and an expiry.
 *
 * A zero-row result is then diagnosed by reading the row back, so the caller can
 * be told which of the four things happened rather than a generic refusal. That
 * ordering, write first and diagnose second, is what keeps the happy path one
 * statement.
 */
export async function declineOffer(
  admin: SupabaseClient,
  input: { offerId: string; nodeId: string; reason: string | null },
): Promise<DeclineOutcome> {
  const now = new Date();

  const { data: moved, error } = await admin
    .from('offers')
    .update({
      status: 'declined',
      declined_at: now.toISOString(),
      decline_reason: input.reason,
    })
    .eq('id', input.offerId)
    .eq('node_id', input.nodeId)
    .eq('status', 'open')
    .gt('expires_at', now.toISOString())
    .select(OFFER_COLUMNS)
    .maybeSingle();
  if (error) throw error;

  if (moved) {
    const row = moved as OfferRow;
    return {
      kind: 'declined',
      offer: await projectOne(admin, row, now),
      taskId: row.task_id,
      projectId: row.project_id,
      round: row.round,
    };
  }

  const { data: existing, error: readError } = await admin
    .from('offers')
    .select(OFFER_COLUMNS)
    .eq('id', input.offerId)
    .eq('node_id', input.nodeId)
    .maybeSingle();
  if (readError) throw readError;

  // Not theirs and not existing are the same answer, the 404-not-403 idiom every
  // route in this file uses: the API does not confirm the existence of something
  // it will not show.
  if (!existing) return { kind: 'not_found' };

  const row = existing as OfferRow;

  // Already declined by them: a replay. Hand back what they wrote rather than
  // refusing, the same way a repeated skill claim returns the original row.
  if (row.status === 'declined') {
    return { kind: 'replayed', offer: await projectOne(admin, row, now), taskId: row.task_id };
  }

  // Still open means the deadline was the failing clause.
  if (row.status === 'open') return { kind: 'expired' };

  return { kind: 'settled' };
}

async function projectOne(admin: SupabaseClient, row: OfferRow, now: Date): Promise<NodeOffer> {
  const { data: task, error } = await admin
    .from('tasks')
    .select('title, stage, detail')
    .eq('id', row.task_id)
    .maybeSingle();
  if (error) throw error;

  return {
    id: row.id,
    status: presentedStatus(row, now),
    round: row.round,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    declinedAt: row.declined_at,
    declineReason: row.decline_reason,
    task: {
      title: (task?.title as string) ?? '',
      stage: (task?.stage as string | null) ?? null,
      detail: (task?.detail as string | null) ?? null,
    },
  };
}

/**
 * Record a node's decline, against the project rather than against the node.
 *
 * Deliberately not `auditNode`, whose whole shape is wrong here: it writes
 * `project_id: null` and `subject_type: 'node'`, which is right for a claim
 * somebody makes about themselves and wrong for an act on somebody else's
 * project. A decline is a fact about a step, and the person who will one day
 * read this trail is the owner asking why their step went round the houses.
 *
 * `actor_id` is explicit for the reason `auditNode` gives: this runs under the
 * service key, so the `auth.uid()` idiom the SQL writers use would read null and
 * file a person's decision as the system's.
 *
 * The guard trigger has already written `offer.transitioned` for the same act.
 * This carries what the trigger cannot: who, and in their own words, why.
 *
 * Never throws.
 */
export async function auditOfferDeclined(
  admin: SupabaseClient,
  event: {
    projectId: string;
    nodeId: string;
    offerId: string;
    taskId: string;
    round: number;
    reason: string | null;
  },
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const { error } = await admin.from('events').insert({
    project_id: event.projectId,
    actor_id: event.nodeId,
    actor_kind: 'node',
    verb: 'offer.declined',
    subject_type: 'offer',
    subject_id: event.offerId,
    payload: {
      task_id: event.taskId,
      node_id: event.nodeId,
      round: event.round,
      reason: event.reason,
    },
  });
  if (error) log?.error({ err: error, offerId: event.offerId }, 'offer decline not recorded');
}
