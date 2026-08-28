import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ReplanEmbedPayload, type IntakeSlot } from '@octopus/contracts';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { requestReplan, type ReplanTaskInput } from '../lib/ai';
import { resolveProjectOwner } from '../lib/project-owner';

/**
 * Asking for a running plan to be changed.
 *
 * `ai-orchestrator.md` has specified replan-by-diff since Phase 0 and nothing
 * produced one, because there was no way to ask. The gap showed up as soon as the
 * project panel did: a person could see fifteen steps, disagree with three of
 * them, and have no way to say so short of abandoning the project and starting a
 * new goal, which throws away everything already delivered.
 *
 * **Owner-initiated and owner-approved, and both halves are deliberate.** This
 * route only produces a card. Applying it is `apply_plan_diff`, reached through
 * the ordinary embed-action route, so a diff crosses the same authorisation
 * boundary a plan does. Nothing in the system replans on its own: an automatic
 * diff would change a running project with no card and no approval, and a model
 * proposing something is not the same as somebody agreeing to it.
 *
 * `202`, like an agent run and for the same reason: the core does one retrieval,
 * one groundedness check and one long generation, which is tens of seconds. The
 * card arrives in the room when it is ready.
 */

const Params = z.object({ projectId: z.string().uuid() });

const Body = z.object({
  /**
   * Why the owner wants a change, in their words. Required and not defaulted: a
   * replan with no reason is a request to regenerate, which is the thing
   * replan-by-diff exists instead of.
   */
  reason: z.string().trim().min(1).max(1000),
});

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface ReplanRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
}

export async function replanRoutes(app: FastifyInstance, opts: ReplanRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.post(
    '/api/projects/:projectId/replan',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = Params.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'Bad project id.');
      const body = Body.safeParse(request.body);
      if (!body.success) {
        return fail(reply, 400, 'bad_request', 'Say what you want changed.');
      }

      const { projectId } = params.data;
      const { reason } = body.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        // Read as the caller. A project they cannot see is a 404 rather than a
        // 403, the idiom rooms already use: the API does not confirm the
        // existence of something it will not show.
        const { data: project, error: projectErr } = await db
          .from('projects')
          .select('id, goal, status')
          .eq('id', projectId)
          .maybeSingle<{ id: string; goal: string; status: string }>();
        if (projectErr) throw projectErr;
        if (!project) return fail(reply, 404, 'not_found', 'Project not found.');

        if (project.status === 'completed' || project.status === 'cancelled') {
          return fail(reply, 409, 'conflict', 'This project has finished.');
        }

        // Owner only. A diff cancels planned work and adds work that will spend
        // somebody's time, which is the owner's call in exactly the way approving
        // the plan was. A human node in the room must not make it.
        const { ownerId, roomId } = await resolveProjectOwner(db, projectId);
        if (!ownerId || ownerId !== userId || !roomId) {
          return fail(reply, 403, 'forbidden', 'Only the workspace owner can change the plan.');
        }

        const runId = randomUUID();

        // Not awaited: the request returns 202 and the card arrives in the room.
        void produceDiff({
          projectId,
          roomId,
          goal: project.goal,
          reason,
          runId,
          accessToken: request.accessToken as string,
          log: request.log,
        });

        return reply.code(202).send({ runId, status: 'accepted' });
      } catch (err) {
        request.log.error({ err, projectId, userId }, 'replan request failed');
        return fail(reply, 500, 'internal_error', 'Could not start the replan.');
      }
    },
  );

  interface DiffInput {
    projectId: string;
    roomId: string;
    goal: string;
    reason: string;
    runId: string;
    accessToken: string;
    log: FastifyInstance['log'];
  }

  async function produceDiff(input: DiffInput): Promise<void> {
    const admin = createServiceClient(opts.supabase);
    const { projectId, roomId, goal, reason, runId, log } = input;

    try {
      // The DAG travels to the core rather than being read by it: the task graph
      // is Node's (ADR-0006), and the core reaches Postgres for retrieval only.
      const { data: taskRows, error: tasksErr } = await admin
        .from('tasks')
        .select('id, title, detail, stage, state, owner_type')
        .eq('project_id', projectId)
        .order('position');
      if (tasksErr) throw tasksErr;

      const tasks = (taskRows ?? []) as Array<{
        id: string;
        title: string;
        detail: string | null;
        stage: string | null;
        state: string;
        owner_type: 'ai' | 'human' | 'user';
      }>;
      if (tasks.length === 0) {
        await postNotice(admin, roomId, runId, 'That project has no steps to change.', log);
        return;
      }

      // Existing edges, so the core can tell whether an edge it is about to
      // propose closes a cycle rather than leaving the acyclicity trigger to
      // discover it under the owner's approval click.
      const { data: depRows, error: depsErr } = await admin
        .from('task_deps')
        .select('task_id, depends_on_task_id')
        .in(
          'task_id',
          tasks.map((t) => t.id),
        );
      if (depsErr) throw depsErr;

      const depsByTask = new Map<string, string[]>();
      for (const dep of (depRows ?? []) as Array<{
        task_id: string;
        depends_on_task_id: string;
      }>) {
        const list = depsByTask.get(dep.task_id) ?? [];
        list.push(dep.depends_on_task_id);
        depsByTask.set(dep.task_id, list);
      }

      const OWNER_TO_WIRE = { ai: 'AI', human: 'HUMAN', user: 'YOU' } as const;
      const wireTasks: ReplanTaskInput[] = tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        detail: task.detail ?? '',
        stage: task.stage,
        state: task.state,
        owner: OWNER_TO_WIRE[task.owner_type],
        dependsOn: depsByTask.get(task.id) ?? [],
      }));

      // What intake established, carried from the plan card the project came
      // from. Same block the planner and the executor receive, and governed by
      // the same rule: it may make a step concrete and it may never be cited.
      const context = await readContext(admin, projectId, log);
      const titles = new Map(tasks.map((t) => [t.id, t.title]));

      const response = await requestReplan(
        opts.aiServiceUrl,
        { projectId, roomId, goal, reason, tasks: wireTasks, context, agentRunId: runId },
        opts.aiTimeoutMs,
      );

      for (const proposal of response.proposals) {
        if (proposal.kind === 'post_message') {
          await postNotice(admin, roomId, runId, proposal.body, log);
          continue;
        }
        if (proposal.kind !== 'propose_replan') {
          // The core widening its own powers by returning a proposal kind this
          // path was not written for should be loud, not quietly ignored.
          log.error({ kind: proposal.kind, projectId }, 'unexpected proposal kind from /replan');
          continue;
        }

        const payload = ReplanEmbedPayload.safeParse({
          projectId: proposal.project_id,
          reason,
          summary: proposal.summary,
          ops: proposal.ops.map((op) =>
            op.op === 'add_step'
              ? {
                  op: op.op,
                  stage: op.stage,
                  id: op.id,
                  title: op.title,
                  detail: op.detail,
                  owner: op.owner,
                  citations: op.citations,
                  // Renamed rather than spread. Both defaulted fields would
                  // survive a spread as their defaults, and a diff whose edges
                  // all silently vanished still applies cleanly, which is the
                  // failure nobody would notice.
                  riskTier: op.risk_tier,
                  acceptanceCriteria: op.acceptance_criteria,
                  dependsOn: op.depends_on,
                }
              : op.op === 'cancel_task'
                ? {
                    op: op.op,
                    taskId: op.task_id,
                    // The step's title, so the card reads on its own rather than
                    // asking somebody to approve a UUID. Taken from the DAG this
                    // function already read, not from the model: it is a fact
                    // about a row, and asking for it would invite a second version
                    // of it that can disagree.
                    taskTitle: titles.get(op.task_id),
                    reason: op.reason,
                  }
                : {
                    op: op.op,
                    taskId: op.task_id,
                    taskTitle: titles.get(op.task_id),
                    detail: op.detail,
                    acceptanceCriteria: op.acceptance_criteria,
                    addDependsOn: op.add_depends_on,
                  },
          ),
          citations: response.citations.map((c) => ({
            sourceId: c.source_id,
            label: c.label,
            url: c.url ?? null,
            effectiveDate: c.effective_date ?? null,
          })),
        });

        if (!payload.success) {
          log.error({ err: payload.error, projectId }, 'replan payload failed its own contract');
          await postNotice(
            admin,
            roomId,
            runId,
            'I put together a change and could not store it. The plan is unchanged.',
            log,
          );
          continue;
        }

        const { data: message, error: messageErr } = await admin
          .from('messages')
          .insert({
            room_id: roomId,
            author_id: null,
            author_kind: 'agent',
            body: proposal.summary,
            idempotency_key: `replan:${runId}`,
          })
          .select('id')
          .single<{ id: string }>();
        if (messageErr) throw messageErr;

        const { error: embedErr } = await admin.from('action_embeds').insert({
          message_id: message.id,
          room_id: roomId,
          component: 'replan',
          payload: payload.data,
          // Owner only, re-checked server-side by the action route. The UI reads
          // this too, but the check that matters is not the UI's.
          required_role: 'owner',
          state: 'pending',
        });
        if (embedErr && embedErr.code !== '23505') throw embedErr;

        log.info({ projectId, runId, ops: proposal.ops.length }, 'replan card posted');
      }
    } catch (err) {
      log.error({ err, projectId, runId }, 'replan failed; the plan is unchanged');
      await postNotice(
        admin,
        roomId,
        runId,
        'I could not work out a change to the plan just now. Nothing has been altered, ' +
          'so the project is still running as it was.',
        log,
      );
    }
  }

  /** The plan card's intake slots, or nothing. Never fatal: absent context degrades
   * to a diff written without knowing the audience, which is what every diff would
   * have had otherwise. */
  async function readContext(
    admin: ReturnType<typeof createServiceClient>,
    projectId: string,
    log: FastifyInstance['log'],
  ): Promise<IntakeSlot[]> {
    try {
      const { data: project } = await admin
        .from('projects')
        .select('source_embed_id')
        .eq('id', projectId)
        .maybeSingle<{ source_embed_id: string | null }>();
      if (!project?.source_embed_id) return [];
      const { data: embed } = await admin
        .from('action_embeds')
        .select('payload')
        .eq('id', project.source_embed_id)
        .maybeSingle<{ payload: { context?: IntakeSlot[] } }>();
      return embed?.payload?.context ?? [];
    } catch (err) {
      log.warn({ err, projectId }, 'could not read plan context for replan');
      return [];
    }
  }

  /** Say something in the room. A replan that produced nothing must still say so:
   * silence is indistinguishable from the request never having arrived. */
  async function postNotice(
    admin: ReturnType<typeof createServiceClient>,
    roomId: string,
    runId: string,
    body: string,
    log: FastifyInstance['log'],
  ): Promise<void> {
    const { error } = await admin.from('messages').insert({
      room_id: roomId,
      author_id: null,
      author_kind: 'agent',
      body,
      idempotency_key: `replan-notice:${runId}`,
    });
    if (error && error.code !== '23505') {
      log.error({ err: error, roomId }, 'could not post replan notice');
    }
  }
}
