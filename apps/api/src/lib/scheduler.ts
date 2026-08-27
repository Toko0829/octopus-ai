import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoutableTask, SchedulerPorts } from '@octopus/core';
import { executeTask, type ExecutorDeps } from './executor';

/**
 * The IO half of the scheduler. The decisions live in `@octopus/core`, which has
 * no database access at all; this is the adapter that gives it one.
 *
 * Two things are deliberately NOT decided here:
 *
 *   * **Which tasks are ready.** That is `private.tasks_ready`, in SQL, so there
 *     is exactly one definition of ready. Rebuilding the dependency semantics in
 *     TypeScript would create a second, and they would drift.
 *   * **Whether a transition is legal.** That is the trigger on `tasks`. This
 *     adapter lets a refusal propagate as an error rather than catching it, so
 *     the scheduler records the disagreement instead of hiding it.
 *
 * Written with the service key, because every write here is trusted server work
 * and no client has UPDATE on `tasks` by design.
 */

/**
 * Supabase returns errors as plain objects, not `Error` instances, so anything
 * that stringifies one gets `[object Object]` and the reason is gone. That is not
 * hypothetical: sixteen tasks failed every tick for an hour and the log said
 * exactly that, while the real message named the missing privilege precisely.
 */
function asError(error: { message?: string; code?: string; details?: string; hint?: string }) {
  const parts = [error.message ?? 'unknown database error'];
  if (error.code) parts.push(`(${error.code})`);
  if (error.details) parts.push(error.details);
  if (error.hint) parts.push(`hint: ${error.hint}`);
  return new Error(parts.join(' '));
}

const ROUTE_TARGETS = new Set(['ai_running', 'escalated', 'needs_user']);

/**
 * `executor` is optional, and leaving it out is a supported configuration rather
 * than an oversight. Without it the scheduler routes AI tasks as far as `routing`
 * and reports `awaiting_executor`, which is what any caller that only wants to
 * classify work should get.
 */
export function createSchedulerPorts(
  admin: SupabaseClient,
  executor?: Omit<ExecutorDeps, 'admin'>,
): SchedulerPorts {
  return {
    async readyTasks(projectId: string): Promise<RoutableTask[]> {
      const { data: ids, error: readyError } = await admin.rpc('scheduler_ready_tasks', {
        p_project: projectId,
      });
      if (readyError) throw asError(readyError);

      const taskIds = (ids ?? []) as string[];
      if (taskIds.length === 0) return [];

      // The RPC returns ids only, so the routing inputs come from a second read.
      // Kept as two calls rather than widening the SQL function's return type:
      // the function answers "which are ready", and what the router needs to
      // decide is a separate question that will grow (confidence, SLA age).
      const { data, error } = await admin
        .from('tasks')
        .select('id, owner_type, risk_tier, citations, position')
        .in('id', taskIds)
        .order('position', { ascending: true });
      if (error) throw error;

      return (data ?? []).map((row) => ({
        id: row.id as string,
        ownerType: row.owner_type as RoutableTask['ownerType'],
        riskTier: row.risk_tier as RoutableTask['riskTier'],
        citations: (row.citations ?? []) as number[],
      }));
    },

    async transition(taskId: string, to: string, reason: string): Promise<void> {
      const { data, error } = await admin
        .from('tasks')
        .update({ state: to })
        .eq('id', taskId)
        .select('id, project_id')
        .maybeSingle();

      // Not caught. The state machine in Postgres is the authority, and a
      // scheduler that swallowed its refusals would keep sweeping a project that
      // is quietly stuck.
      if (error) throw asError(error);
      if (!data) throw new Error(`task ${taskId} did not transition to ${to}`);

      // The trigger already records from/to. This adds WHY, for the one hop where
      // the reason is a decision rather than a mechanic: "dependencies cleared" is
      // derivable from the graph, but "escalated because nothing cites this step"
      // is not derivable from anything after the fact.
      if (ROUTE_TARGETS.has(to)) {
        const { error: eventError } = await admin.from('events').insert({
          project_id: data.project_id,
          actor_kind: 'system',
          verb: 'task.routed',
          subject_type: 'task',
          subject_id: taskId,
          payload: { to, reason },
        });
        // Losing the explanation must not undo the routing, which has already
        // happened and is already recorded by the trigger.
        if (eventError) throw eventError;
      }
    },

    // Present only when an executor was supplied. A no-op would be worse than
    // absent: it would let the scheduler move tasks to `ai_running`, which
    // asserts work is happening. See the header of `@octopus/core`'s scheduler.
    ...(executor
      ? {
          dispatchAi: async (taskId: string) => {
            await executeTask(taskId, { admin, ...executor });
          },
        }
      : {}),
  };
}
