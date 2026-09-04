import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import { resolveProjectOwner } from '../lib/project-owner';
import { produceDiff } from '../lib/replan-diff';

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
 * The producer lives in `lib/replan-diff.ts`, because a question card finished
 * after its plan was approved asks for the same diff from a different door.
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
  /** See `AgentRunnerOptions.modelKeySecret`. */
  modelKeySecret?: string | null;
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
        void produceDiff(
          createServiceClient(opts.supabase),
          {
            aiServiceUrl: opts.aiServiceUrl,
            aiTimeoutMs: opts.aiTimeoutMs,
            modelKeySecret: opts.modelKeySecret ?? null,
            log: request.log,
          },
          { projectId, roomId, goal: project.goal, reason, runId },
        );

        return reply.code(202).send({ runId, status: 'accepted' });
      } catch (err) {
        request.log.error({ err, projectId, userId }, 'replan request failed');
        return fail(reply, 500, 'internal_error', 'Could not start the replan.');
      }
    },
  );
}
