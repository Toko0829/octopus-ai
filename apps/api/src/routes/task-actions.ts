import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { TaskState } from '@octopus/contracts';
import type { RoutableTask } from '@octopus/core';
import { retryTask } from '@octopus/core';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { createSchedulerPorts } from '../lib/scheduler';
import { resolveProjectOwner } from '../lib/project-owner';
import { resolveTask, type TaskAction } from '../lib/task-resolution';

/**
 * Unsticking a step from the project panel.
 *
 * Two states leave a step waiting on a person, and until now only one of them had
 * a way out, through a chat message. `NEEDS_USER` could be answered by typing into
 * the room; `ESCALATED` could not be answered at all, because its only arc was to
 * a marketplace that does not exist. Measured on the live database: **17 steps
 * across four projects that nobody could move, ever.**
 *
 * Answering through the room also had a cost of its own. A question card claims
 * every message the owner writes until it is dealt with, so a person typing a new
 * request while steps were waiting had it silently filed as an answer to those
 * steps. Two such cards had been holding rooms hostage for nearly two days.
 * **Naming the step removes that ambiguity entirely**: this route answers one
 * task by id, so nothing has to guess what a sentence was for.
 *
 * `20260827120000` added the two arcs this needs, mirroring the ones `NEEDS_USER`
 * already had.
 */

const Params = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
});

const Body = z.object({
  action: z.enum(['answer', 'retry']),
  /** What the owner did. Required for `answer`, ignored for `retry`. */
  text: z.string().trim().max(8000).optional(),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface TaskActionRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
}

export async function taskActionRoutes(
  app: FastifyInstance,
  opts: TaskActionRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.post(
    '/api/projects/:projectId/tasks/:taskId/resolution',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'Bad project or task id.');
      const body = Body.safeParse(request.body);
      if (!body.success) return fail(reply, 400, 'bad_request', 'Say whether to answer or retry.');

      const { projectId, taskId } = params.data;
      const action: TaskAction = body.data.action;
      const text = body.data.text ?? '';
      const userId = (request.user as NonNullable<typeof request.user>).sub;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        // Read as the caller, so RLS decides whether this task exists for them.
        // A task in a project they cannot see is a 404, the same idiom rooms use:
        // the API does not confirm the existence of something it will not show.
        const { data: taskRow, error: taskErr } = await db
          .from('tasks')
          .select('id, project_id, title, owner_type, state, risk_tier, citations')
          .eq('id', taskId)
          .eq('project_id', projectId)
          .maybeSingle();
        if (taskErr) throw taskErr;
        if (!taskRow) return fail(reply, 404, 'not_found', 'Step not found.');

        const task = taskRow as {
          id: string;
          project_id: string;
          title: string;
          owner_type: RoutableTask['ownerType'];
          state: string;
          risk_tier: RoutableTask['riskTier'];
          citations: number[] | null;
        };

        // **Owner only, checked here rather than inferred.** Resolving what a step
        // needs is the owner's call: it records their work as the deliverable, or
        // spends compute retrying. A human node in the room must not do either.
        // Read as the caller, so a room they cannot see yields no owner and the
        // check fails closed. A null owner means nobody, never anybody.
        const { ownerId } = await resolveProjectOwner(db, projectId);
        if (!ownerId || ownerId !== userId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can resolve a step.');
        }

        const outcome = resolveTask(task.state as TaskState, action, text);
        if (!outcome.ok) return fail(reply, 409, 'conflict', outcome.reason);

        const admin = createServiceClient(opts.supabase);

        if (outcome.resolution.writesArtifact) {
          // Their write-up IS the deliverable, stored exactly as the chat answer
          // path stores one: `created_by: 'user'`, and **no citations**, because a
          // person's own work rests on no retrieved source and attaching one would
          // attribute their judgement to the corpus. The checker never sees it: a
          // human doing the work is not a maker to be checked.
          const { error: artifactErr } = await admin.from('artifacts').insert({
            task_id: task.id,
            project_id: task.project_id,
            kind: 'answer',
            title: task.title,
            body: text,
            citations: [],
            created_by: 'user',
          });
          if (artifactErr) throw artifactErr;

          // Conditional on the state we read, so two clicks racing cannot both
          // complete the step. Reading a state and then writing it is a race.
          const { data: moved, error: moveErr } = await admin
            .from('tasks')
            .update({ state: outcome.resolution.to })
            .eq('id', task.id)
            .eq('state', task.state)
            .select('id');
          if (moveErr) throw moveErr;
          if (!moved || moved.length === 0) {
            return fail(reply, 409, 'conflict', 'That step moved while you were writing.');
          }

          request.log.info({ taskId, userId, action }, 'owner resolved a step');
          return reply.code(200).send({ state: outcome.resolution.to, ranExecutor: false });
        }

        // Retry. The scheduler only selects PENDING tasks, so nothing would ever
        // revisit this one; `retryTask` drives the same path a tick drives rather
        // than leaving it parked in `routing`, which would swap one dead end for
        // another.
        const ports = createSchedulerPorts(admin, {
          aiServiceUrl: opts.aiServiceUrl,
          aiTimeoutMs: opts.aiTimeoutMs,
          log: request.log,
        });
        const routable: RoutableTask = {
          id: task.id,
          ownerType: task.owner_type,
          riskTier: task.risk_tier,
          citations: task.citations ?? [],
        };
        const result = await retryTask(routable, ports);
        request.log.info({ taskId, userId, outcome: result.outcome }, 'owner retried a step');
        return reply.code(200).send({ state: result.outcome, ranExecutor: true });
      } catch (err) {
        request.log.error({ err, taskId, userId, action }, 'resolveStep failed');
        return fail(reply, 500, 'internal_error', 'Could not update that step.');
      }
    },
  );
}
