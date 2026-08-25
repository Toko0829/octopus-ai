/**
 * What to do with a run whose worker stopped answering (ADR-0010).
 *
 * Durable execution lives on the Postgres that already holds the state, rather
 * than on a managed orchestrator, because ADR-0006 left no continuation to
 * preserve: the reasoning core is stateless and Node commits each step. The one
 * thing genuinely missing was a way to tell a task that is RUNNING from one whose
 * worker died, since a crash mid-execute leaves `ai_running` and a `running`
 * attempt row that nothing ever sweeps.
 *
 * A lease makes that observable. A live worker keeps extending it; a dead one
 * stops. `private.reclaim_expired_runs` fails the attempt and reports it, and
 * deliberately does not move the task, because the state machine has one owner
 * and it is the scheduler. This module is the decision that owner then makes.
 */

/** The state a reclaimed task should be moved to. */
export type RecoveryTarget = 'ai_running' | 'escalated';

export interface ReclaimedRun {
  taskId: string;
  runId: string;
  /** Which attempt died. 1-based, as `task_runs.attempt` is. */
  attempt: number;
}

export interface RecoveryDecision {
  taskId: string;
  runId: string;
  attempt: number;
  target: RecoveryTarget;
  reason: string;
}

/**
 * Default attempt ceiling, matching the critic's.
 *
 * Deliberately the same number, because a person reading a stuck task should not
 * have to know which of two limits stopped it. A crash and a failed check are
 * different causes with the same budget: two goes, then a human.
 */
export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Decide what happens to a run the lease sweep reclaimed.
 *
 * **A crash is retried, unlike a fabricated citation.** The critic never retries
 * that one, because asking the same maker again is how you get a second invented
 * source. A lost worker carries no such signal: we do not know why it died, and
 * "the process went away" is exactly the kind of failure a second attempt
 * plausibly fixes. So the bound is the only thing standing between a transient
 * fault and an infinite loop, and it is the reason this is a decision rather than
 * an unconditional re-dispatch.
 *
 * Escalating at the ceiling rather than failing outright is the same choice the
 * critic makes: a task nobody can run is a task somebody should look at, and
 * `FAILED` is terminal while `ESCALATED` is a person's queue.
 */
export function decideRecovery(
  run: ReclaimedRun,
  maxAttempts = MAX_RECOVERY_ATTEMPTS,
): RecoveryDecision {
  const exhausted = run.attempt >= maxAttempts;
  return {
    taskId: run.taskId,
    runId: run.runId,
    attempt: run.attempt,
    target: exhausted ? 'escalated' : 'ai_running',
    reason: exhausted
      ? `attempt ${run.attempt} of ${maxAttempts} was lost; no attempts left`
      : `attempt ${run.attempt} was lost with its worker; retrying`,
  };
}

/**
 * How long a lease should run, given how long a step actually takes.
 *
 * The lease has to outlive a slow step comfortably or a healthy worker gets
 * reclaimed mid-execute, which is the failure this whole mechanism must not
 * introduce: two workers on one task, and the idempotency keys then carrying
 * weight they were never meant to carry alone. A plan is measured at roughly 71
 * seconds on twelve threads and 230 on one (ADR-0009), and an execute step is the
 * same pipeline, so the multiplier is generous on purpose.
 *
 * The cost of being generous is only that a genuinely dead worker is noticed
 * later, and nothing is waiting on that: the task is already stuck, and being
 * stuck for another few minutes is much cheaper than being run twice.
 */
export function leaseDurationMs(stepBudgetMs: number, multiplier = 3): number {
  return Math.max(stepBudgetMs * multiplier, 60_000);
}
