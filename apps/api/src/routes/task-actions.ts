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
import { readEligiblePool } from '../lib/match';
import { revokeThreadAccess } from '../lib/proof';
import { skillsForStage } from '@octopus/marketplace';

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
 *
 * **`find_expert` is the third action, and it is the marketplace's front door.**
 * It is a person's click rather than a sweep's decision on purpose: twelve steps
 * sit in `escalated` on the live database, and a sweep claiming them all on
 * deploy would offer a cold-start pool a dozen steps at once while taking away
 * the two buttons that already work. The matcher acts only on what an owner
 * sent, and everything after the click (rank, offer, cascade, expire) is the
 * ticker's.
 *
 * **Both refusals here happen before the task moves**, which is the property
 * worth stating: a step whose stage maps to no skill, or whose skills nobody
 * eligible claims, stays exactly where it is with all three buttons intact. The
 * alternative, moving it to `matching` and letting the sweep bounce it back,
 * would spend an arc and post a system message to tell the owner something this
 * route already knew.
 */

const Params = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
});

const Body = z.object({
  action: z.enum(['answer', 'retry', 'find_expert', 'approve_work', 'reject_work']),
  /**
   * What the owner did, or what needs to change. Required for `answer` and for
   * `reject_work`, ignored for the rest. `resolveTask` decides which, so the two
   * rules live in one readable function rather than in this schema and again in
   * the handler.
   */
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
      if (!body.success) {
        return fail(reply, 400, 'bad_request', 'Say whether to answer, retry, or find an expert.');
      }

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
          .select('id, project_id, title, stage, owner_type, state, risk_tier, citations')
          .eq('id', taskId)
          .eq('project_id', projectId)
          .maybeSingle();
        if (taskErr) throw taskErr;
        if (!taskRow) return fail(reply, 404, 'not_found', 'Step not found.');

        const task = taskRow as {
          id: string;
          project_id: string;
          title: string;
          stage: string | null;
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

        if (action === 'find_expert') {
          // What kind of expert. `tasks` carries no `required_skills`, so the
          // stage map in `packages/marketplace` answers it from the one field the
          // planner does fill in. An unmapped stage is a real answer rather than
          // a guess: offering somebody's step to whoever happens to match is
          // worse than saying plainly that we do not know.
          const skills = skillsForStage(task.stage);
          if (skills.length === 0) {
            return fail(
              reply,
              409,
              'conflict',
              'I do not know what kind of expert this step needs, so I cannot search for one. ' +
                'You can do it yourself or try again.',
            );
          }

          // **A step nobody can be paid for must not be sent out.** Since slice
          // 5 an expert who accepts is funded from `projects.budget_ceiling`, and
          // `accept_offer` refuses a null ceiling. Without this check the refusal
          // lands on the node, at the last possible moment, for a problem only
          // the owner can fix and which nothing would have told them about: they
          // would see a step sitting at "Offered to an expert" and never learn
          // why nobody took it.
          //
          // Same class as the two refusals below it, and refused for the same
          // reason they are: before the task moves, so the step keeps all three
          // buttons and is told what to do.
          const { data: budgetRow, error: budgetErr } = await db
            .from('projects')
            .select('budget_ceiling')
            .eq('id', projectId)
            .maybeSingle();
          if (budgetErr) throw budgetErr;
          if ((budgetRow as { budget_ceiling: number | null } | null)?.budget_ceiling == null) {
            return fail(
              reply,
              409,
              'conflict',
              'Set the project budget before searching: an expert who accepts is paid from it.',
            );
          }

          // Check there is somebody to ask BEFORE burning the arc. The pool read
          // is the same one the sweep runs, imported rather than rewritten, so
          // the precheck and the search can never disagree about who is eligible.
          const pool = await readEligiblePool(admin, skills);
          if (pool.length === 0) {
            return fail(
              reply,
              409,
              'conflict',
              'No expert with the right skills is available yet, so this step stays with you. ' +
                'You can do it yourself, try again, or search later.',
            );
          }

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

          // The owner's act, with their id on it. The sweep's own events are
          // `system`, because everything it does afterwards is machinery carrying
          // out this decision rather than making one.
          const { error: eventErr } = await admin.from('events').insert({
            project_id: task.project_id,
            actor_id: userId,
            actor_kind: 'user',
            verb: 'task.match_requested',
            subject_type: 'task',
            subject_id: task.id,
            payload: { stage: task.stage, skills, pool_size: pool.length },
          });
          if (eventErr) {
            request.log.error({ err: eventErr, taskId }, 'match request event was not written');
          }

          // No inline tick. The offer goes out on the next pass, within one tick
          // interval, and the panel already reads "Finding an expert" the moment
          // this returns. Approving a plan runs a tick inline because a person is
          // watching a card commit; nobody is watching a stranger decide.
          request.log.info({ taskId, userId, skills }, 'owner sent a step to the marketplace');
          return reply.code(200).send({ state: outcome.resolution.to, ranExecutor: false });
        }

        // **The owner's verdict on an expert's work**, and the only action here
        // that walks two arcs. `proof_submitted -> in_review -> approved | rejected`,
        // as two conditional updates in one request, which is `accept_offer`'s
        // idiom: every guard fires, every hop writes its own `task.transitioned`
        // row, and `in_review` is transit-only rather than a state a step sits in
        // while nobody is looking at it.
        if (action === 'approve_work' || action === 'reject_work') {
          const opened = await admin
            .from('tasks')
            .update({ state: 'in_review' })
            .eq('id', task.id)
            .eq('state', 'proof_submitted')
            .select('id');
          if (opened.error) throw opened.error;
          if ((opened.data ?? []).length === 0) {
            return fail(reply, 409, 'conflict', 'That step moved while you were deciding.');
          }

          if (action === 'reject_work') {
            // Their note is the deliverable of the rejection: it is what the node
            // reads and works from, so it is stored rather than only logged.
            const { error: noteErr } = await admin.from('artifacts').insert({
              task_id: task.id,
              project_id: task.project_id,
              kind: 'answer',
              title: `Sent back: ${task.title}`,
              body: text,
              citations: [],
              created_by: 'user',
            });
            if (noteErr) throw noteErr;
          }

          const settled = await admin
            .from('tasks')
            .update({ state: outcome.resolution.to })
            .eq('id', task.id)
            .eq('state', 'in_review')
            .select('id');
          if (settled.error) throw settled.error;
          if ((settled.data ?? []).length === 0) {
            return fail(reply, 409, 'conflict', 'That step moved while you were deciding.');
          }

          const { error: eventErr } = await admin.from('events').insert({
            project_id: task.project_id,
            actor_id: userId,
            actor_kind: 'user',
            verb: action === 'approve_work' ? 'work.approved' : 'work.rejected',
            subject_type: 'task',
            subject_id: task.id,
            payload: { note: action === 'reject_work' ? text : null },
          });
          if (eventErr) {
            request.log.error({ err: eventErr, taskId }, 'review verdict event was not written');
          }

          if (action === 'approve_work') {
            // **Discharges the obligation `accept_offer` booked** (`20260904125000:373-379`):
            // it admits a node with `expires_at` null because there is no deadline
            // to box access with, and says revocation is explicit, done by the
            // reconcile sweep when an engagement ends "and the approval path in
            // slice 6 does the same".
            //
            // **The engagement is deliberately NOT ended here.** The panel reads
            // live engagements only, so ending it would erase "who did this" at
            // the moment the owner is about to pay them, and
            // `private.engaged_counterparty` is time-boxed on `ended_at is null`,
            // so it would close the owner's read of the node's name before the
            // payout. `outcome = 'completed'` belongs to the payout slice,
            // alongside `held -> released`.
            //
            // Conditional on `expires_at is null` and scoped to this task's
            // thread, so it cannot touch a membership the node holds elsewhere,
            // and a replay is a no-op. A failure is logged and never thrown: the
            // verdict is committed, and refusing to report an approval that
            // happened would be the worse lie.
            await revokeThreadAccess(admin, task.id, request.log);
          }

          request.log.info({ taskId, userId, action }, 'owner recorded a verdict on expert work');
          return reply.code(200).send({ state: outcome.resolution.to, ranExecutor: false });
        }

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
