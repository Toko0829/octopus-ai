import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import {
  AiServiceError,
  requestPlan,
  type PlanResponse,
  type ProposePlanProposal,
} from '../lib/ai';
import { PlanEmbedPayload } from '@octopus/contracts';

/**
 * Agent runs: the Node half of ADR-0006's "Python proposes, Node executes".
 *
 * The request thread only authorises the caller and starts the run, then returns
 * `202 + runId` (AGENTS.md rule 4). Progress reaches the client over Realtime,
 * because the agent participates by INSERTing message rows like any other member.
 *
 * NOT YET DURABLE. The step below runs in-process, so a crash or deploy mid-run
 * loses it. ADR-0001 puts this on Trigger.dev v3, which needs credentials this
 * project does not have yet. The seam is shaped for that move: `startRun` is one
 * function with a run id, no shared state, and no reliance on the request being
 * open. Until then, treat a lost run as possible and re-trigger.
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
}

export async function agentRunRoutes(
  app: FastifyInstance,
  opts: AgentRunRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /**
   * Post as the agent. This is the only path by which anything the reasoning core
   * says becomes visible, and it deliberately lives here rather than in Python.
   */
  async function postAsAgent(roomId: string, body: string, runId: string, index: number) {
    const admin = createServiceClient(opts.supabase);
    const { error } = await admin.from('messages').insert({
      room_id: roomId,
      author_id: null,
      author_kind: 'agent',
      body,
      // Deterministic per run and position, so a retried run cannot post twice.
      idempotency_key: `agent-run:${runId}:${index}`,
    });
    if (error && error.code !== '23505') throw error;
  }

  /**
   * Post a plan: one message, plus the embed carrying its structure.
   *
   * The message body is the plain-text fallback, so the plan is still legible
   * anywhere the card does not render (a notification, a client that does not
   * know this embed type, the audit trail). The card is an enhancement of a
   * readable message rather than the only way to read it.
   *
   * `required_role: 'owner'` is written here and re-checked when the action is
   * taken. The UI is told about it so it can disable what the caller cannot do,
   * but that is a courtesy, not the control.
   */
  async function postPlan(
    roomId: string,
    plan: ProposePlanProposal,
    citations: PlanResponse['citations'],
    runId: string,
    index: number,
  ) {
    const admin = createServiceClient(opts.supabase);
    const idempotencyKey = `agent-run:${runId}:${index}`;

    const { data: message, error: messageError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body: `${plan.title}\n\n${plan.summary}`,
        idempotency_key: idempotencyKey,
      })
      .select('id')
      .maybeSingle();

    if (messageError) {
      // A replayed run hits the idempotency constraint, which means the plan was
      // already posted. Nothing more to do, and certainly not a second embed.
      if (messageError.code === '23505') return;
      throw messageError;
    }
    if (!message) return;

    const payload = {
      title: plan.title,
      summary: plan.summary,
      stages: plan.stages,
      citations: citations.map((citation) => ({
        sourceId: citation.source_id,
        label: citation.label,
        url: citation.url ?? null,
        effectiveDate: citation.effective_date ?? null,
      })),
    };

    // Validated before it is stored, not on the way out. A payload that cannot
    // satisfy the contract is a bug here; writing it anyway would move the
    // failure to every future read and to the browser, where it is far harder to
    // attribute.
    const parsed = PlanEmbedPayload.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`refusing to store an invalid plan payload: ${parsed.error.message}`);
    }

    const { error: embedError } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'plan',
      payload: parsed.data,
      required_role: 'owner',
      state: 'pending',
    });
    if (embedError && embedError.code !== '23505') throw embedError;
  }

  async function postSystemNotice(roomId: string, body: string, runId: string) {
    try {
      const admin = createServiceClient(opts.supabase);
      await admin.from('messages').insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'system',
        body,
        idempotency_key: `agent-run:${runId}:failed`,
      });
    } catch (err) {
      app.log.error({ err, runId, roomId }, 'could not post agent failure notice');
    }
  }

  async function startRun(roomId: string, goal: string, runId: string) {
    try {
      const plan = await requestPlan(
        opts.aiServiceUrl,
        { roomId, goal, agentRunId: runId },
        opts.aiTimeoutMs,
      );

      app.log.info(
        {
          agentRunId: runId,
          roomId,
          core: plan.core,
          grounded: plan.grounded,
          proposals: plan.proposals.length,
          reasoning: plan.reasoning_summary,
        },
        'agent run planned',
      );

      for (const [index, proposal] of plan.proposals.entries()) {
        // Every kind is handled explicitly. The core cannot widen its own powers
        // by inventing one: an unknown kind fails the schema parse above, before
        // reaching this switch.
        switch (proposal.kind) {
          case 'post_message':
            await postAsAgent(roomId, proposal.body, runId, index);
            break;
          case 'propose_plan':
            await postPlan(roomId, proposal, plan.citations, runId, index);
            break;
        }
      }
    } catch (err) {
      // A failed run must be visible in the room. Silence would look identical
      // to the agent deciding not to reply (AGENTS.md rule 16).
      app.log.error({ err, agentRunId: runId, roomId }, 'agent run failed');
      const reason =
        err instanceof AiServiceError
          ? 'The reasoning service did not respond.'
          : 'Something went wrong.';
      await postSystemNotice(roomId, `The agent could not complete this run. ${reason}`, runId);
    }
  }

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
      void startRun(roomId, parsed.data.goal, runId);

      return reply.code(202).send({ runId, status: 'accepted' });
    },
  );
}
