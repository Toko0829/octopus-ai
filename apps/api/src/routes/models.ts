import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ConnectModelBody,
  MODEL_PROVIDERS,
  PatchModelRoutesBody,
  isRegisteredModelProvider,
  modelBelongsTo,
  modelEntryFor,
  type ModelConnection,
  type ModelSettingsResponse,
} from '@octopus/contracts';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import {
  auditModel,
  readModelConnections,
  readRoutes,
  revokeModelConnection,
  writeModelConnection,
  writeRoutes,
} from '../lib/model-connections';
import { verifyKey } from '../lib/model-providers';
import { requestHouseDefault } from '../lib/ai';
import { resolveRoom } from '../lib/resolve-room';

/**
 * The Models block: connect a provider's key, and say which model answers for
 * each voice (ADR-0032).
 *
 * **Two tables with two opposite postures, and the split is the whole design.**
 * `model_connections` holds a customer's paid API key and has no client policy
 * and no client grant, so it is read here as the service role behind an
 * ownership check, exactly as `connections.ts` reads `channel_connections` and
 * for a credential worth rather more. `model_routes` holds no secret, has a
 * member select policy, and is therefore read **as the caller** so Postgres
 * decides who sees it. Both facts are in one response, produced two different
 * ways, on purpose.
 *
 * **Reading is for any member; writing is the owner's.** Which model answers is
 * already visible on every message that model wrote, so hiding the routes from a
 * member would hide nothing. Connecting a key is an authorisation in the same
 * sense `connect_channel` is: it hands this system the ability to spend
 * somebody's quota.
 *
 * **A route grants nothing.** It names which endpoint composes a proposal.
 * `routeTask`, `checkSpendCap` and the plan card are untouched by everything in
 * this file, and a role with the strongest model routed to it has exactly the
 * authority it had with none.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const ConnectionParams = RoomParams.extend({ connectionId: z.string().uuid() });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface ModelRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  /**
   * Null when `MODEL_KEY_SECRET` is unset. Connecting is then refused with a
   * sentence naming the variable, rather than the service failing to boot or,
   * far worse, storing somebody's paid key under a constant.
   */
  modelKeySecret: string | null;
  /** Where "Auto" is resolved from, which is the AI service's own `/health`. */
  aiServiceUrl: string;
}

export async function modelRoutes(app: FastifyInstance, opts: ModelRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /** The whole block, however it was reached. Read after every write. */
  async function settingsFor(
    request: Parameters<typeof resolveRoom>[0],
    roomId: string,
  ): Promise<ModelSettingsResponse> {
    const admin = createServiceClient(opts.supabase);
    const caller = createUserClient(opts.supabase, request.accessToken as string);
    const [connections, routes, houseDefault] = await Promise.all([
      readModelConnections(admin, roomId),
      // As the caller: this table has a member policy, so RLS is the control
      // rather than the ownership check above, which is this codebase's normal
      // posture and the reason the two reads use two clients.
      readRoutes(caller, roomId),
      requestHouseDefault(opts.aiServiceUrl),
    ]);
    return { connections, routes, houseDefault };
  }

  /** What a member may see. The projection carries no key, by construction. */
  app.get(
    '/api/rooms/:roomId/models',
    { preHandler: requireAuth },
    async (request, reply): Promise<ModelSettingsResponse | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');

      const room = await resolveRoom(request, reply, opts.supabase, params.data.roomId, fail);
      if (!room) return reply;

      try {
        return await settingsFor(request, params.data.roomId);
      } catch (err) {
        request.log.error({ err, roomId: params.data.roomId }, 'model settings read failed');
        return fail(reply, 500, 'internal_error', 'Could not load the model settings.');
      }
    },
  );

  /**
   * Connect a provider with the workspace's own key. Owner-only.
   *
   * **The key is checked against the provider before it is stored**, which is
   * why this is a route rather than a form field. A wrong key stored happily
   * fails four minutes into an agent run, in a system notice, where a person
   * cannot tell a typo from an outage. Here the paste is still on screen.
   *
   * Nothing is written on either failure path. A key we could not verify would
   * make the block say "connected" for something that may never work.
   */
  app.post(
    '/api/rooms/:roomId/models/connections',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const body = ConnectModelBody.safeParse(request.body);
      if (!body.success) {
        return fail(reply, 400, 'bad_request', 'Choose a provider and paste a key.');
      }
      const { roomId } = params.data;
      const { provider, apiKey } = body.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, opts.supabase, roomId, fail);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can connect a model.');
      }

      // Belt and braces with the Zod enum above: an unregistered name must never
      // reach the writer, and the registry is the thing that decides.
      if (!isRegisteredModelProvider(provider)) {
        return fail(reply, 400, 'bad_request', 'That provider is not one we support.');
      }

      // Before the provider is even called: there is no point spending somebody's
      // rate limit to verify a key we have nowhere to put.
      if (!opts.modelKeySecret) {
        return fail(
          reply,
          503,
          'not_configured',
          'This server cannot store a model key yet. MODEL_KEY_SECRET is not set.',
        );
      }

      const checked = await verifyKey(provider, apiKey);
      if (!checked.ok) {
        if (checked.reason === 'invalid_key') {
          return fail(reply, 400, 'invalid_key', 'That key was refused by the provider.');
        }
        return fail(
          reply,
          502,
          'provider_unreachable',
          `Could not reach ${MODEL_PROVIDERS[provider].label} to check that key. Nothing was saved.`,
        );
      }

      try {
        const admin = createServiceClient(opts.supabase);
        const connection = await writeModelConnection(admin, {
          roomId,
          connectedBy: userId,
          provider,
          apiKey,
          secret: opts.modelKeySecret,
          now: new Date(),
        });

        await auditModel(
          admin,
          {
            verb: 'model.connected',
            roomId,
            actorId: userId,
            subjectType: 'model_connection',
            subjectId: connection.id,
            // Provider and hint only. The key is never in an event payload, and
            // the hint is four characters that complete into nothing.
            payload: { provider: connection.provider, keyHint: connection.keyHint },
          },
          request.log,
        );

        // The provider and the id, never the key and never its length: a log line
        // is the easiest place in this system for a credential to end up.
        request.log.info({ roomId, provider, id: connection.id }, 'model provider connected');
        return reply.code(201).send({ connection });
      } catch (err) {
        request.log.error({ err, roomId, provider }, 'could not store the model key');
        return fail(reply, 500, 'internal_error', 'Could not save that key.');
      }
    },
  );

  /** Disconnect. Owner-only, a revocation rather than a delete, and it clears the routes. */
  app.delete(
    '/api/rooms/:roomId/models/connections/:connectionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = ConnectionParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId and connectionId must be UUIDs.');
      }
      const { roomId, connectionId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, opts.supabase, roomId, fail);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can disconnect a model.');
      }

      try {
        const admin = createServiceClient(opts.supabase);
        const connection = await revokeModelConnection(admin, roomId, connectionId, new Date());
        if (!connection) {
          // Either it never existed in this room or it was already revoked. Both
          // are 409 rather than 404, on the connections reasoning: the caller's
          // next move is the same, and distinguishing them would confirm which
          // ids exist in a room.
          return fail(reply, 409, 'conflict', 'That provider is not connected.');
        }

        await auditModel(
          admin,
          {
            verb: 'model.revoked',
            roomId,
            actorId: userId,
            subjectType: 'model_connection',
            subjectId: connection.id,
            payload: { provider: connection.provider },
          },
          request.log,
        );

        request.log.info({ roomId, connectionId, userId }, 'model provider disconnected');
        return reply.code(200).send({ connection });
      } catch (err) {
        request.log.error({ err, roomId, connectionId }, 'could not revoke the model key');
        return fail(reply, 500, 'internal_error', 'Could not disconnect that provider.');
      }
    },
  );

  /**
   * Set or clear routes. Owner-only.
   *
   * **PATCH rather than PUT** because the BFF proxy exports GET, POST, PATCH and
   * DELETE and no PUT, which is the room-profile precedent. It is also the
   * honest verb: the body carries the roles that changed, not all six.
   *
   * Every entry is validated against three separate things, and each catches a
   * different mistake. `modelBelongsTo` catches a model the provider does not
   * offer. The connection check catches routing a role to a provider whose key
   * was never pasted or has been revoked. The images check catches pointing a
   * text role at an image model, which would fail deep inside a run with a
   * shape error nobody could read.
   */
  app.patch(
    '/api/rooms/:roomId/models/routes',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const body = PatchModelRoutesBody.safeParse(request.body);
      if (!body.success) {
        return fail(reply, 400, 'bad_request', 'Send between one and six routes.');
      }
      const { roomId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, opts.supabase, roomId, fail);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can choose the models.');
      }

      try {
        const admin = createServiceClient(opts.supabase);
        const connected = new Set(
          (await readModelConnections(admin, roomId))
            .filter((c) => c.status === 'active')
            .map((c) => c.provider),
        );

        for (const route of body.data.routes) {
          // Clearing a role is always allowed, including for a provider that is
          // no longer connected: going back to Auto must never be blocked by the
          // state that made somebody want to.
          if (route.provider === null || route.model === null) continue;

          if (!modelBelongsTo(route.provider, route.model)) {
            return fail(reply, 400, 'bad_request', 'That model is not one that provider offers.');
          }
          if (!connected.has(route.provider)) {
            return fail(
              reply,
              409,
              'not_connected',
              'Connect this provider before routing a role to it.',
            );
          }
          const entry = modelEntryFor(route.model);
          const wantsImages = route.role === 'creative';
          if (entry && entry.images !== wantsImages) {
            return fail(
              reply,
              400,
              'bad_request',
              wantsImages
                ? 'The creative role needs an image model.'
                : 'That is an image model, and this role writes text.',
            );
          }
        }

        await writeRoutes(admin, roomId, userId, body.data.routes, new Date());

        await auditModel(
          admin,
          {
            verb: 'model.route_set',
            roomId,
            actorId: userId,
            // A batch of routes has no id of its own, so the room is the subject.
            subjectType: 'room',
            subjectId: roomId,
            payload: {
              routes: body.data.routes.map((r) => ({
                role: r.role,
                provider: r.provider,
                model: r.model,
              })),
            },
          },
          request.log,
        );

        // The projection read back rather than the request echoed, so the client
        // renders what was stored and a partly-applied batch is visible at once.
        return reply.code(200).send(await settingsFor(request, roomId));
      } catch (err) {
        request.log.error({ err, roomId }, 'could not set the model routes');
        return fail(reply, 500, 'internal_error', 'Could not save those choices.');
      }
    },
  );
}
