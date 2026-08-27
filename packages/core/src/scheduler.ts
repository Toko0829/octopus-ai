/**
 * The scheduler: walk a project's ready tasks and move each one along.
 *
 * IO is injected as a small port interface rather than taken as a database
 * client, for the same reason the router is pure: what this decides matters more
 * than how it reads rows, and a scheduler that needs a live Postgres to test is a
 * scheduler nobody tests.
 *
 * **It does not answer "which tasks are ready".** `private.tasks_ready` does, in
 * SQL. Reimplementing the dependency semantics here would be a second definition
 * of ready, and the two would drift the first time either changed.
 *
 * ## What a tick actually does
 *
 *     pending -> ready -> routing -> { ai_running | escalated | needs_user }
 *
 * Every hop is a real transition through the guard in Postgres, so each one is
 * validated and each one writes an audit event. Collapsing them into a single
 * jump would be faster and would lose the record of a task having been routed at
 * all, which is the thing you need when asking why something escalated.
 *
 * ## The one place it deliberately stops short
 *
 * A task routed to `ai_running` only gets there **if an executor was supplied**.
 * With none, it stays in `routing` and the report says so. `ai_running` means the
 * AI is running it; moving a task there with nothing behind it would be a false
 * statement in the audit trail and would leave the task stuck in a state that
 * looks like progress.
 *
 * `escalated` and `needs_user` are not stopped short, because both genuinely mean
 * "waiting for someone" and both are true the moment they are set, whether or not
 * a marketplace exists to answer them.
 */

import { routeTask, type RoutableTask, type RouteDecision } from './router';

export interface SchedulerPorts {
  /**
   * Tasks that are PENDING with every hard dependency satisfied, in plan order.
   * Backed by `private.tasks_ready`.
   */
  readyTasks(projectId: string): Promise<RoutableTask[]>;

  /**
   * Move one task. Must fail if the transition is illegal rather than silently
   * skipping it: the guard in Postgres is the authority, and a scheduler that
   * swallowed its refusals would hide the disagreement.
   */
  transition(taskId: string, to: string, reason: string): Promise<void>;

  /**
   * Hand a task to an AI executor. Absent until one exists, which is why a tick
   * can legitimately leave tasks in `routing`.
   */
  dispatchAi?(taskId: string): Promise<void>;
}

export type TickOutcome =
  'ai_running' | 'escalated' | 'needs_user' | 'awaiting_executor' | 'failed';

export interface TickResult {
  taskId: string;
  decision: RouteDecision;
  outcome: TickOutcome;
  /** Present only when `outcome` is `failed`. */
  error?: string;
}

export interface TickReport {
  projectId: string;
  results: TickResult[];
}

/** Everything a tick did, grouped, for a log line that is readable at a glance. */
export function summarise(report: TickReport): Record<TickOutcome, number> {
  const counts: Record<TickOutcome, number> = {
    ai_running: 0,
    escalated: 0,
    needs_user: 0,
    awaiting_executor: 0,
    failed: 0,
  };
  for (const r of report.results) counts[r.outcome] += 1;
  return counts;
}

/**
 * Run one tick over a project.
 *
 * Tasks are processed independently: one that fails does not stop the rest.
 * A tick is a best-effort sweep rather than a transaction, because the alternative
 * is that a single unroutable task freezes the whole project, and the next tick
 * would find exactly the same state and freeze again.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

export async function tick(projectId: string, ports: SchedulerPorts): Promise<TickReport> {
  const tasks = await ports.readyTasks(projectId);
  const results: TickResult[] = [];

  for (const task of tasks) {
    const decision = routeTask(task);

    try {
      // pending -> ready. Separate from the routing hop so the audit trail shows
      // that dependencies cleared, which is a different fact from where it went.
      await ports.transition(task.id, 'ready', 'Dependencies satisfied.');
      await ports.transition(task.id, 'routing', 'Routing.');
      results.push(await dispatchRouted(task, decision, ports));
    } catch (err) {
      results.push({
        taskId: task.id,
        decision,
        outcome: 'failed',
        // Not `String(err)`. A port that throws a plain object (supabase-js does)
        // would stringify to "[object Object]" and take the reason with it, which
        // is how sixteen refused transitions were logged an hour without once
        // naming the privilege that was missing.
        error: describeError(err),
      });
    }
  }

  return { projectId, results };
}

/**
 * From `routing` onward: apply the router's verdict and hand the task on.
 *
 * Split out of `tick` because a tick is no longer the only thing that gets a task
 * to `routing`. An owner can send an escalated step back for another attempt, and
 * that step has to travel the identical path: same router, same reason recorded,
 * same refusal to claim `ai_running` without an executor behind it. A second copy
 * of this in the retry route would be a second definition of what routing means,
 * and the two would drift the first time either changed.
 *
 * The caller owns the hops **into** `routing`, because they differ: a tick comes
 * from `pending`, a retry comes from `escalated`.
 *
 * Throws rather than reporting `failed`, so the caller decides what a refusal
 * means. `tick` records it and moves to the next task; a route driving a single
 * task the person is watching should say so instead.
 */
export async function dispatchRouted(
  task: RoutableTask,
  decision: RouteDecision,
  ports: SchedulerPorts,
): Promise<TickResult> {
  if (decision.target === 'ai_running') {
    if (!ports.dispatchAi) {
      // Left in `routing` on purpose. See the header: claiming `ai_running` with
      // no executor would put a false statement in the audit trail.
      return { taskId: task.id, decision, outcome: 'awaiting_executor' };
    }
    await ports.transition(task.id, 'ai_running', decision.reason);
    await ports.dispatchAi(task.id);
    return { taskId: task.id, decision, outcome: 'ai_running' };
  }

  await ports.transition(task.id, decision.target, decision.reason);
  return { taskId: task.id, decision, outcome: decision.target };
}

/**
 * Send one task that has stopped back through the router.
 *
 * The scheduler only ever selects `PENDING` tasks, so nothing would ever revisit
 * a step sitting in `escalated`: without this it stays there forever, which is
 * exactly what 17 steps on the live database were doing. The owner asking for
 * another attempt is the only thing that moves them, and this is the path.
 *
 * **Retrying changes nothing on its own, and that is deliberate.** The router
 * applies the same rules to the same task, so a step escalated for want of
 * citations escalates again. It is worth taking when something else changed, such
 * as a source the corpus was missing, and the copy that offers it says so rather
 * than implying the attempt itself is the fix.
 */
export async function retryTask(task: RoutableTask, ports: SchedulerPorts): Promise<TickResult> {
  const decision = routeTask(task);
  await ports.transition(task.id, 'routing', 'The owner asked for another attempt.');
  return dispatchRouted(task, decision, ports);
}
