import type { TaskState } from '@octopus/contracts';

/**
 * What the owner is allowed to do to a step that has stopped, and from which
 * states.
 *
 * Pure and separate from the route, because this is an authorisation decision and
 * rules 7 and 11 put those in code that can be read in one screen rather than
 * inside a handler. The database refuses an illegal transition regardless; this
 * exists so the refusal is a considered answer with a reason a person can read,
 * rather than a 500 carrying a Postgres error.
 */

export type TaskAction =
  'answer' | 'retry' | 'find_expert' | 'approve_work' | 'reject_work' | 'dispute';

/**
 * `answer` means the owner did the work themselves, so the step is done.
 *
 * Allowed from both waiting states, and for the same reason in each. From
 * `needs_user` the plan asked them a question only they can answer, so answering
 * is the step. From `escalated` the plan gave the work to an expert who cannot be
 * brought in, so the owner taking it on is the step. Both land on `approved`,
 * which is what satisfies dependents, and both then walk on to `done`, because
 * an owner who did the work themselves owes nobody a payout and a step that is
 * finished should not stay cancellable. See `completes` on `Resolution`.
 */
const ANSWERABLE: ReadonlySet<string> = new Set<TaskState>(['needs_user', 'escalated']);

/**
 * `retry` means send it back through the router for another attempt.
 *
 * Only from `escalated`, and deliberately not from `needs_user`. A step waiting
 * on a person is not waiting on a failure, so re-routing it would send it
 * straight back to `needs_user` (rule 2) and achieve nothing except making it
 * look like something happened. That exact loop is what `20260815220000` was
 * written to close, and offering a button that walks back into it would reopen it
 * from the UI.
 */
const RETRYABLE: ReadonlySet<string> = new Set<TaskState>(['escalated']);

/**
 * `find_expert` means send it to the marketplace.
 *
 * Only from `escalated`, which is the state the router puts human-owned work in,
 * and which until this slice had no exit but the two above. Not from
 * `needs_user`: a step waiting on a decision only the owner can make is not work
 * an expert could take, and offering it to one would be asking a stranger to
 * choose somebody else's brand direction.
 *
 * **The owner starts this, not a sweep**, and that is the whole reason this arc
 * is a person's action rather than a background pass. Twelve tasks sit in
 * `escalated` on the live database; a sweep that claimed them all on deploy
 * would offer a cold-start pool a dozen steps at once and take away the two
 * buttons that currently work. The matcher acts only on what an owner sent.
 */
const MATCHABLE: ReadonlySet<string> = new Set<TaskState>(['escalated']);

/**
 * `approve_work` and `reject_work` are the owner's verdict on what an expert
 * handed over, and they are the last thing missing from the engagement loop.
 *
 * **Only from `proof_submitted`, and that is the honest state.** A node's
 * submission lands there and stays there until somebody looks; `in_review` means
 * "being reviewed", which is true for the instant the owner is deciding and is
 * not where a step should sit for two days waiting on them. So the route walks
 * `proof_submitted -> in_review -> approved | rejected` as two conditional
 * updates in one request, which is `accept_offer`'s idiom
 * (`offered -> claimed -> escrow_funded`) applied to a verdict: every guard fires
 * and every hop writes its own audit row, and `in_review` is transit-only for the
 * same reason `claimed` is
 * ([ADR-0019](../../../../docs/40-adr/0019-claimed-to-matching-stays-dropped.md)).
 *
 * **The AI never reaches `approved` on a human step.** `reviewProof` in
 * `packages/core` can only return the step to the node or pass it to the owner;
 * deciding that a person's work is finished, and therefore that they are owed
 * money, is not a verdict a deterministic floor check or a model gets to make.
 */
const REVIEWABLE: ReadonlySet<string> = new Set<TaskState>(['proof_submitted']);

/**
 * `dispute` means the owner says the deal has gone wrong, and the money stops.
 *
 * **Three states, and each is a different grievance the owner can still act on.**
 * `escrow_funded` is paid for and never started, `in_progress` is happening and
 * going wrong, and `payout_pending` is the last moment before the sweep sends
 * the fee. All three sit before the transfer, which is what makes disputing them
 * meaningful: `payouts.transfer_id` is write-once and money that has left cannot
 * be recalled by a state change.
 *
 * **`proof_submitted` is deliberately absent, and it is the interesting
 * omission.** Work handed over and not yet judged is not a dispute, it is a
 * review, and the owner already has `reject_work` with a required note — a
 * cheaper, more informative act that returns the step to the node with something
 * to fix. Offering "dispute" beside "send back" on the same screen would invite
 * an owner to escalate to an operator what a sentence would have solved. If the
 * rejection is then contested, `rejected -> disputed` is the node's arc.
 *
 * **`approved` is absent for the same family of reasons.** It is the state the
 * payout sweep picks up first, and an owner who changes their mind has
 * `payout_pending` one tick later. The window is narrow on purpose: approving is
 * the payout authorisation ([ADR-0013](../../../../docs/40-adr/0013-approving-a-campaign-publishes-it.md)),
 * and a long undo on an authorisation weakens what the authorisation means.
 *
 * The database enforces the same list in `public.raise_dispute`, on ADR-0011's
 * two-layer rule: this exists so a person gets a readable refusal before
 * anything is written, and that exists because it is the layer binding
 * `service_role`.
 */
const DISPUTABLE_BY_OWNER: ReadonlySet<string> = new Set<TaskState>([
  'escrow_funded',
  'in_progress',
  'payout_pending',
]);

/**
 * The node's side of the same arc, and the only action in this system a node
 * takes **against** the owner.
 *
 * One state, `rejected`, because that is the only point where a person has told
 * a node no. Without it a node whose work was wrongly sent back has no recourse
 * but to stop responding, which the no-show sweep then reads as their failure
 * and reassigns the step away from them — losing them both the work and the fee
 * for a decision they disagreed with and could not contest.
 *
 * Exported for the node routes, which check it the way the owner routes check
 * the set above.
 */
export const DISPUTABLE_BY_NODE: ReadonlySet<string> = new Set<TaskState>(['rejected']);

export interface Resolution {
  /** The state to move the task to. */
  to: TaskState;
  /** Whether the owner's text is stored as the step's deliverable. */
  writesArtifact: boolean;
  /**
   * Whether the step is finished by this action, and should walk on from
   * `approved` to `done`.
   *
   * **`approved` is not terminal, and that is the whole reason this flag
   * exists.** Two actions here land on it and they mean different things.
   * `answer` is the owner doing the work themselves: nobody is owed anything and
   * the step is over, so leaving it at `approved` left finished work cancellable
   * by a later replan and recorded in the audit trail as abandoned. `approve_work`
   * lands on the same state and is emphatically **not** finished: it is the
   * payout authorisation, `PAYABLE_TASK_STATES` reads exactly that state, and
   * walking it to `done` here would take the step out from under the sweep that
   * pays the expert.
   *
   * Required rather than optional, so a seventh action has to answer the question
   * rather than inherit an answer.
   */
  completes: boolean;
}

export type ResolutionOutcome =
  { ok: true; resolution: Resolution } | { ok: false; reason: string };

/**
 * Deciding a resolution, with the refusals worded for the person reading them.
 *
 * A refusal here is not an error condition. Somebody clicking a button on a step
 * that moved underneath them is ordinary, and the honest answer names the state
 * it is in now rather than saying the request was invalid.
 */
export function resolveTask(state: TaskState, action: TaskAction, text: string): ResolutionOutcome {
  if (action === 'answer') {
    if (!ANSWERABLE.has(state)) {
      return {
        ok: false,
        reason:
          'That step is not waiting on you any more, so there is nothing to record against it.',
      };
    }
    // An empty deliverable is the failure the artifacts check constraint exists to
    // refuse, caught here so the person is told rather than shown a database error.
    if (!text.trim()) {
      return { ok: false, reason: 'Tell me what you did, and I will record it against the step.' };
    }
    // The owner did it themselves, so nobody is owed anything and the step is
    // over. `completes` walks it past `approved` to a terminal state.
    return { ok: true, resolution: { to: 'approved', writesArtifact: true, completes: true } };
  }

  if (action === 'approve_work' || action === 'reject_work') {
    if (!REVIEWABLE.has(state)) {
      return {
        ok: false,
        reason:
          state === 'in_review'
            ? 'Somebody is already recording a verdict on that step.'
            : 'That step has nothing waiting for your review.',
      };
    }
    if (action === 'approve_work') {
      // **Not `completes`, and this is the one place that distinction earns its
      // keep.** Approving an expert's work is the payout authorisation: the
      // sweep selects on `approved`, and finishing the step here would pay
      // nobody and strand the escrow.
      return { ok: true, resolution: { to: 'approved', writesArtifact: false, completes: false } };
    }
    // **A rejection must say why**, unlike an approval. Sending work back with no
    // reason gives the node nothing to act on, and the arc they take next
    // (`rejected -> in_progress`) is them doing it again: without a note they
    // would be guessing at what to change while their fee sits in escrow.
    if (!text.trim()) {
      return {
        ok: false,
        reason:
          'Say what needs to change. Sending work back with no reason gives them nothing to fix.',
      };
    }
    return { ok: true, resolution: { to: 'rejected', writesArtifact: true, completes: false } };
  }

  if (action === 'dispute') {
    if (!DISPUTABLE_BY_OWNER.has(state)) {
      return {
        ok: false,
        reason:
          state === 'proof_submitted'
            ? 'That work is waiting for your review. Send it back with a note if it is not right, and raise a dispute only if that is contested.'
            : 'That step is not at a point where a dispute would stop anything.',
      };
    }
    // **A dispute must say what is wrong**, for the reason a rejection must.
    // This one is stronger: the text freezes somebody's fee, an operator reads it
    // to decide, and the other party has to be able to answer it. A dispute with
    // no grievance is a freeze nobody can resolve.
    if (!text.trim()) {
      return {
        ok: false,
        reason:
          'Say what has gone wrong. An operator reads this to decide, and so does the expert.',
      };
    }
    // `to` is `disputed`, and `writesArtifact` is false: the grievance is a
    // column on `disputes`, not a deliverable on the step. The route calls
    // `raise_dispute` rather than moving the task itself, because the freeze and
    // the record have to be one transaction.
    return { ok: true, resolution: { to: 'disputed', writesArtifact: false, completes: false } };
  }

  if (action === 'find_expert') {
    if (!MATCHABLE.has(state)) {
      return {
        ok: false,
        reason: 'Only a step that stopped because it needed an expert can be sent to one.',
      };
    }
    return { ok: true, resolution: { to: 'matching', writesArtifact: false, completes: false } };
  }

  if (!RETRYABLE.has(state)) {
    return {
      ok: false,
      reason: 'Only a step that stopped because it needed an expert can be tried again.',
    };
  }
  return { ok: true, resolution: { to: 'routing', writesArtifact: false, completes: false } };
}
