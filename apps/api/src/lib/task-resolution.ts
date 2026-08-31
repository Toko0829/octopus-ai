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

export type TaskAction = 'answer' | 'retry' | 'find_expert';

/**
 * `answer` means the owner did the work themselves, so the step is done.
 *
 * Allowed from both waiting states, and for the same reason in each. From
 * `needs_user` the plan asked them a question only they can answer, so answering
 * is the step. From `escalated` the plan gave the work to an expert who cannot be
 * brought in, so the owner taking it on is the step. Both land on `approved`,
 * which is what satisfies dependents.
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

export interface Resolution {
  /** The state to move the task to. */
  to: TaskState;
  /** Whether the owner's text is stored as the step's deliverable. */
  writesArtifact: boolean;
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
    return { ok: true, resolution: { to: 'approved', writesArtifact: true } };
  }

  if (action === 'find_expert') {
    if (!MATCHABLE.has(state)) {
      return {
        ok: false,
        reason: 'Only a step that stopped because it needed an expert can be sent to one.',
      };
    }
    return { ok: true, resolution: { to: 'matching', writesArtifact: false } };
  }

  if (!RETRYABLE.has(state)) {
    return {
      ok: false,
      reason: 'Only a step that stopped because it needed an expert can be tried again.',
    };
  }
  return { ok: true, resolution: { to: 'routing', writesArtifact: false } };
}
