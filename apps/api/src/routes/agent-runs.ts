import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createUserClient, type SupabaseConfig } from '../lib/supabase';
import { createAgentRunner } from '../lib/agent-runner';

// The run itself lives in `lib/agent-runner.ts` so the embed route can continue
// one from a finished question card. Re-exported here because the tests, and
// anything else that learned these names from this file, still find them.
export { failureNotice, planEmbedPayload } from '../lib/agent-runner';

/**
 * Starting an agent run from a chat message.
 *
 * The request thread only authorises the caller and starts the run, then returns
 * `202 + runId` (AGENTS.md rule 4). Progress reaches the client over Realtime,
 * because the agent participates by INSERTing message rows like any other member.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const StartRunBody = z.object({ goal: z.string().trim().min(1).max(4000) });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface AgentRunRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  aiServiceUrl: string;
  /** Budget for one planning turn. Defaults to the production value. */
  aiTimeoutMs?: number;
  /** See `AgentRunnerOptions.intakeMaxRounds`. */
  intakeMaxRounds?: number;
  intakeTimeoutMs?: number;
}

export async function agentRunRoutes(
  app: FastifyInstance,
  opts: AgentRunRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);
  const runner = createAgentRunner({
    supabase: opts.supabase,
    aiServiceUrl: opts.aiServiceUrl,
    aiTimeoutMs: opts.aiTimeoutMs,
    intakeMaxRounds: opts.intakeMaxRounds,
    intakeTimeoutMs: opts.intakeTimeoutMs,
    log: app.log,
  });

  app.post(
    '/api/rooms/:roomId/agent-runs',
    { preHandler: requireAuth },
    async (request, reply): Promise<FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const parsed = StartRunBody.safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'bad_request', 'A goal of 1 to 4000 characters is required.');
      }

      const { roomId } = params.data;

      // Membership is checked as the caller, so a non-member cannot make the
      // agent speak in a room they cannot see.
      const db = createUserClient(opts.supabase, request.accessToken as string);
      const { data: room, error } = await db
        .from('rooms')
        .select('id')
        .eq('id', roomId)
        .maybeSingle();
      if (error) {
        request.log.error({ err: error, roomId }, 'agent-run membership check failed');
        return fail(reply, 500, 'internal_error', 'Could not start the run.');
      }
      if (!room) return fail(reply, 404, 'not_found', 'Room not found.');

      const runId = randomUUID();

      // Deliberately not awaited: the request thread returns 202 and the client
      // follows along over Realtime.
      //
      // The caller's id travels with it because an owner's new goal closes the
      // intake cards that were about the previous one, and only the owner's
      // goal does that: the cards describe their business, and nobody else in
      // the room gets to decide they are moot.
      void runner.startRun(roomId, parsed.data.goal, runId, request.user!.sub);

      return reply.code(202).send({ runId, status: 'accepted' });
    },
  );
}
