import type { SupabaseClient } from '@supabase/supabase-js';
import type { NodeProofArtifact, TaskState } from '@octopus/contracts';
import { nextStateAfterProofReview, reviewProof, type ProofVerdict } from '@octopus/core';
import { writeFileArtifact } from './artifact-files';

/**
 * The work half of an engagement: starting it, handing it over, reading back
 * what was handed over.
 *
 * `escrow_funded` has been where a funded step stops since slice 5, because
 * `escrow_funded -> in_progress` had no producer. These are the producers.
 *
 * ---------- The state walk, and why no migration came with it ----------
 *
 * Every arc used here has been in `private.task_transition_allowed` since
 * `20260813120000` with nothing able to walk it. Slice 6 supplies the walkers and
 * changes the map only for the reassignment path (slice 6's third push), which is
 * what guards-before-writers is supposed to produce:
 *
 *     escrow_funded -> in_progress          this file, `startWork`
 *     rejected      -> in_progress          this file, `startWork`, same button
 *     in_progress   -> proof_submitted      this file, `submitProof`
 *     proof_submitted -> in_review -> approved | rejected   the owner, in task-actions.ts
 *
 * **`proof_submitted -> in_progress` stays dropped**, and this file is the reason
 * it turned out not to be needed. The slice table booked it for "a proof
 * withdrawn or superseded before review starts", and the obvious second use was
 * the floor check bouncing a bad submission. It does not need it: the check runs
 * **before anything is written and before the task moves**, so a bounced
 * submission leaves the step exactly where it was. That is `task-actions.ts`'s
 * and `match.ts`' standing idiom, and it is worth more than the arc, because a
 * bounce that moved the row twice would put two meaningless transitions in the
 * audit trail for a person who left a field blank. Retraction has no producer
 * either, so restoring the arc for it would be the `task_deps` defect
 * ([ADR-0018](../../../../docs/40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)'s
 * grounds).
 *
 * ---------- The node reads nothing through a policy, and that is the design ----
 *
 * A thread-scoped member is **not a project member** (`20260901122000:295-324`),
 * so this person reads zero rows from `tasks`, `projects` and `artifacts`, and
 * zero objects from the artifacts bucket. Every read below is therefore
 * **service-key after a caller-scoped authorisation**, the shape `readOwnOffer`
 * and `readNodeEngagements` already use: their own `engagements` row is read as
 * them through `engagements_select_node`, and nothing else is touched until that
 * returns.
 *
 * Opening `artifacts` by engagement was considered and rejected. The storage
 * policy resolves the tenant from the **project** in path segment one of
 * `<project_id>/<artifact_id>/<filename>`, and there is no task in that path, so
 * an engagement-scoped object policy would need a per-object text join against
 * `artifacts.storage_path` or a change to a convention stated in three places and
 * backfilled across every existing object. Opening the row half alone would show
 * the node a row whose file 404s, which reads as a bug. And opening `artifacts`
 * by engagement would hand over **every** artifact on that task, including the
 * AI's drafts and the owner's own write-up, which is a disclosure decision this
 * slice does not need to make and which `20260904126000` already refused for
 * `node_profiles` and `offers`.
 */

/** States a node may start or resume work from. */
const STARTABLE: ReadonlySet<string> = new Set<TaskState>(['escrow_funded', 'rejected']);

/** The only state a hand-over may leave from. */
const SUBMITTABLE: ReadonlySet<string> = new Set<TaskState>(['in_progress']);

/**
 * Cap on what one submission may carry. Bounds the request, not the work: a node
 * with more to hand over submits again after a rejection, or says so in the
 * thread, which is what the thread is for.
 */
export const MAX_PROOF_FILES = 5;
export const MAX_PROOF_FILE_BYTES = 25 * 1024 * 1024;

/**
 * What a proof file may be.
 *
 * An allow-list rather than a deny-list, on the standing reason: a deny-list is a
 * list of the attacks somebody has already thought of. These are the things a
 * marketing deliverable actually is, and the bucket is private with every read
 * going through a signed URL, so nothing here is served from our origin.
 */
export const PROOF_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

export interface EngagementRow {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  ended_at: string | null;
}

export interface TaskRow {
  id: string;
  project_id: string;
  state: TaskState;
  title: string;
  acceptance_criteria: unknown;
}

export type ProofRefusalRule =
  'not_found' | 'ended' | 'not_startable' | 'not_submittable' | 'criteria_changed' | 'moved';

export type ProofRefusal = { rule: ProofRefusalRule; reason: string };

/**
 * Read the node's own engagement **as the caller**, so somebody asking about a
 * stranger's deal gets nothing rather than a refusal that confirms it exists.
 *
 * `engagements_select_node` is `node_id = auth.uid()`, so this needs no
 * `.eq('node_id', …)` to be correct. It carries one anyway, which is the
 * defense in depth this repository applies everywhere: the policy is the control,
 * the filter is what makes the query say what it means.
 */
export async function readOwnEngagement(
  db: SupabaseClient,
  engagementId: string,
  nodeId: string,
): Promise<EngagementRow | null> {
  const { data, error } = await db
    .from('engagements')
    .select('id, task_id, project_id, node_id, ended_at')
    .eq('id', engagementId)
    .eq('node_id', nodeId)
    .maybeSingle();
  if (error) throw error;
  return (data as EngagementRow | null) ?? null;
}

/** The step behind an engagement, with the service key. The node has no grant on `tasks`. */
export async function readEngagedTask(
  admin: SupabaseClient,
  taskId: string,
): Promise<TaskRow | null> {
  const { data, error } = await admin
    .from('tasks')
    .select('id, project_id, state, title, acceptance_criteria')
    .eq('id', taskId)
    .maybeSingle();
  if (error) throw error;
  return (data as TaskRow | null) ?? null;
}

/**
 * `tasks.acceptance_criteria` as a list of strings.
 *
 * Defensive because the column is `jsonb` with a `'[]'` default and has had **no
 * reader at all** since `20260816120000`, so nothing has ever checked that what
 * the planner writes is the shape everybody assumed. A row that is not an array
 * of strings reads as "this step asked for nothing", which is the safe direction:
 * it cannot manufacture a criterion nobody set, and the owner is still the
 * checker.
 */
export function acceptanceCriteria(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
}

/**
 * Everything that can be said no to before anything is written.
 *
 * Separate and pure for `task-resolution.ts`' reason: these are authorisation and
 * lifecycle decisions, and rules 7 and 11 put those in code a person can read in
 * one screen rather than inside a handler. The database refuses an illegal
 * transition regardless; this exists so the refusal is a considered answer with a
 * sentence rather than a 500 carrying a Postgres error.
 */
export function checkStartable(
  engagement: EngagementRow,
  task: TaskRow | null,
): ProofRefusal | null {
  if (engagement.ended_at !== null) {
    return { rule: 'ended', reason: 'This deal has ended, so there is nothing to work on.' };
  }
  if (!task) {
    return { rule: 'not_found', reason: 'That step no longer exists.' };
  }
  if (task.state === 'in_progress') {
    // Not a refusal worth a different word: somebody double-clicked, or came
    // back to a stale tab. The route treats this as already-done and returns the
    // engagement, which is what a replay should do.
    return null;
  }
  if (!STARTABLE.has(task.state)) {
    return {
      rule: 'not_startable',
      reason: 'That step is not waiting for you to start it any more.',
    };
  }
  return null;
}

export function checkSubmittable(
  engagement: EngagementRow,
  task: TaskRow | null,
): ProofRefusal | null {
  if (engagement.ended_at !== null) {
    return { rule: 'ended', reason: 'This deal has ended, so there is nothing to hand over.' };
  }
  if (!task) {
    return { rule: 'not_found', reason: 'That step no longer exists.' };
  }
  if (!SUBMITTABLE.has(task.state)) {
    return {
      rule: 'not_submittable',
      reason:
        task.state === 'proof_submitted' || task.state === 'in_review'
          ? 'You have already handed this one over. The owner has it.'
          : 'That step is not open for you to hand over right now.',
    };
  }
  return null;
}

/**
 * Move a task, conditional on the state it was read in.
 *
 * The whole concurrency contract, and the same one `match.ts` and
 * `escrow-reconcile.ts` use: a loser matches zero rows and performs nothing
 * rather than overwriting a winner. The races here are real rather than
 * theoretical, because there are three writers of `tasks.state` on a marketplace
 * step: this node, the owner on their panel, and the no-show sweep on a clock.
 */
export async function moveTask(
  admin: SupabaseClient,
  taskId: string,
  from: TaskState,
  to: TaskState,
): Promise<boolean> {
  const { data, error } = await admin
    .from('tasks')
    .update({ state: to })
    .eq('id', taskId)
    .eq('state', from)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * The note, as an ordinary `artifacts` row.
 *
 * **One submission writes one note row plus zero or more file rows**, all
 * `kind = 'proof'`. The note is not folded into the file rows because
 * `writeFileArtifact` writes `body: null` on purpose, so that a file artifact does
 * not render as an empty paragraph in the owner's panel, and reversing that to
 * carry text would be changing a decision for an unrelated reason.
 *
 * The criteria responses live in the note's body rather than in a column,
 * because they are the node's words about the plan's words and both are already
 * text; a column would be a second place for the same fact and a migration for a
 * shape the first reader has not yet proved.
 */
export function composeProofBody(note: string, criteria: string[], responses: string[]): string {
  const trimmed = note.trim();
  if (criteria.length === 0) return trimmed;
  const answered = criteria
    .map((criterion, i) => `- ${criterion}\n  ${(responses[i] ?? '').trim()}`)
    .join('\n');
  return `${trimmed}\n\nAgainst what this step asked for:\n${answered}`;
}

export interface ProofFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

/**
 * Write the note and the files, in that order.
 *
 * **The note first, deliberately.** If a file upload fails, the note is already
 * recorded and the node is told which file did not land, so a resubmit costs them
 * one file rather than the whole write-up. The other order loses the text on the
 * failure of an attachment, which is the same trade `ResolveStep` makes when it
 * keeps a person's writing on screen after a failed submit.
 *
 * `writeFileArtifact` removes its object if its row insert fails, so a partial
 * failure here leaves rows and objects consistent with each other; what it can
 * leave is a submission with fewer files than the node chose, which is why the
 * caller reports the count rather than assuming.
 */
export async function writeProofArtifacts(
  admin: SupabaseClient,
  input: {
    taskId: string;
    projectId: string;
    title: string;
    body: string;
    files: readonly ProofFile[];
  },
): Promise<{ noteId: string; fileIds: string[] }> {
  const { data: note, error } = await admin
    .from('artifacts')
    .insert({
      task_id: input.taskId,
      project_id: input.projectId,
      kind: 'proof',
      title: input.title,
      body: input.body,
      // Empty on purpose and rendered as such. A node's proof cites nothing by
      // construction: it is evidence that something happened in the world, not a
      // claim resting on a retrieved source. Rule 10 is about the second kind.
      citations: [],
      created_by: 'node',
    })
    .select('id')
    .maybeSingle<{ id: string }>();
  if (error || !note) {
    throw new Error(`Could not record the proof: ${error?.message ?? 'no row returned'}`);
  }

  const fileIds: string[] = [];
  for (const file of input.files) {
    const written = await writeFileArtifact(admin, {
      taskId: input.taskId,
      projectId: input.projectId,
      kind: 'proof',
      title: file.filename,
      bytes: file.bytes,
      contentType: file.contentType,
      filename: file.filename,
      createdBy: 'node',
    });
    fileIds.push(written.artifactId);
  }

  return { noteId: note.id, fileIds };
}

/**
 * Run the floor check.
 *
 * Thin on purpose: the judgement lives in `packages/core` so it can be checked
 * without a database, and so that the one place deciding whether a person's
 * hand-over counts is a pure function somebody can read in full.
 */
export function checkProof(
  note: string,
  responses: string[],
  fileCount: number,
  criteria: string[],
): { verdict: ProofVerdict; next: 'in_review' | 'in_progress' } {
  const verdict = reviewProof({ note, responses, fileCount }, { acceptanceCriteria: criteria });
  return { verdict, next: nextStateAfterProofReview(verdict) };
}

/* ------------------------------------------------------------- projections */

interface ArtifactRow {
  id: string;
  title: string | null;
  body: string | null;
  storage_path: string | null;
  created_at: string;
}

/**
 * The proof on a step, projected for the node who submitted it.
 *
 * **`kind = 'proof'` is the filter and it is load-bearing**, not a convenience:
 * without it this would hand a thread-scoped member the AI's drafts and the
 * owner's own write-up on the same task, which is precisely the disclosure the
 * projection-instead-of-policy decision exists to avoid.
 *
 * `storagePath` is not on the wire. A node who needs the file asks for a signed
 * URL by artifact id, which is the same shape the owner's panel uses and keeps
 * the bearer capability out of a list response.
 */
export async function readNodeProof(
  admin: SupabaseClient,
  taskId: string,
): Promise<NodeProofArtifact[]> {
  const { data, error } = await admin
    .from('artifacts')
    .select('id, title, body, storage_path, created_at')
    .eq('task_id', taskId)
    .eq('kind', 'proof')
    .order('created_at', { ascending: true });
  if (error) throw error;

  return ((data ?? []) as ArtifactRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    isFile: row.storage_path !== null,
    createdAt: row.created_at,
  }));
}

/**
 * One proof file's storage path, for the signed-URL route.
 *
 * Constrained on `task_id` **and** `kind` as well as the id, so an artifact id
 * guessed or leaked from anywhere else cannot be redeemed here: the caller has
 * already been authorised for this engagement's task and for nothing else.
 */
export async function readProofStoragePath(
  admin: SupabaseClient,
  taskId: string,
  artifactId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('artifacts')
    .select('storage_path')
    .eq('id', artifactId)
    .eq('task_id', taskId)
    .eq('kind', 'proof')
    .maybeSingle<{ storage_path: string | null }>();
  if (error) throw error;
  return data?.storage_path ?? null;
}

/**
 * Record what the node did, against the project rather than against the node.
 *
 * `auditOfferAccepted`'s shape and its reasons: `actor_id` is explicit because
 * this runs under the service key, so the `auth.uid()` idiom the SQL writers use
 * would file a person's act as the system's. The transition trigger already wrote
 * `task.transitioned`; this carries what it cannot, which is who and with what.
 *
 * Never throws. A missing audit line must not undo the act it describes.
 */
export async function auditProofEvent(
  admin: SupabaseClient,
  event: {
    projectId: string;
    nodeId: string;
    taskId: string;
    engagementId: string;
    verb: 'work.started' | 'proof.submitted' | 'proof.bounced';
    payload?: Record<string, unknown>;
  },
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const { error } = await admin.from('events').insert({
    project_id: event.projectId,
    actor_id: event.nodeId,
    actor_kind: 'node',
    verb: event.verb,
    subject_type: 'task',
    subject_id: event.taskId,
    payload: { engagement_id: event.engagementId, ...(event.payload ?? {}) },
  });
  if (error)
    log?.error({ err: error, taskId: event.taskId, verb: event.verb }, 'proof event not recorded');
}

/**
 * End a node's access to a task's thread, without ending the deal.
 *
 * **`accept_offer` booked this to the approval path by name** (`20260904125000:373-379`):
 * it admits with `expires_at` null because there is no deadline to box access
 * with, and records that revocation is therefore explicit, done by the reconcile
 * sweep when an engagement ends "and the approval path in slice 6 does the same".
 *
 * **Stamped rather than deleted**, on the reconcile sweep's reasoning: the roster
 * still records that this person was here, which is what a dispute reads.
 *
 * **Scoped to this task's thread**, and the narrowness is the point. A node can
 * hold thread memberships in other rooms for other steps, so a revocation keyed
 * on the person alone would cut them out of work that is still running. The
 * thread is resolved from the task because `threads.task_id` is unique and is the
 * only durable link between a step and the room somebody was let into.
 *
 * **Idempotent by condition** (`is('expires_at', null)`), so a replay stamps
 * nothing and cannot move a revocation time that a dispute may later read.
 *
 * Never throws. The verdict is already committed by the time this runs, and
 * reporting an approval as a failure because a membership row did not update
 * would be the worse lie. What it leaves on a failure is bounded and not a
 * disclosure: a node keeps read access to a thread they were already in, on a
 * step they just finished.
 */
export async function revokeThreadAccess(
  admin: SupabaseClient,
  taskId: string,
  log: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void },
): Promise<number> {
  try {
    const { data: threadRow, error: threadError } = await admin
      .from('threads')
      .select('id')
      .eq('task_id', taskId)
      .maybeSingle();
    if (threadError) throw threadError;

    const threadId = (threadRow as { id: string } | null)?.id ?? null;
    if (!threadId) {
      log.warn(
        { taskId },
        'work was approved but its task has no thread, so no access was revoked',
      );
      return 0;
    }

    const { data: revoked, error: revokeError } = await admin
      .from('room_members')
      .update({ expires_at: new Date().toISOString() })
      .eq('thread_id', threadId)
      .eq('scope', 'thread')
      .is('expires_at', null)
      .select('user_id');
    if (revokeError) throw revokeError;
    return (revoked ?? []).length;
  } catch (err) {
    log.error({ err, taskId }, 'thread access was not revoked after approval');
    return 0;
  }
}
