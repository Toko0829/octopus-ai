import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CompleteConnectionBody,
  StartConnectionBody,
  type ChannelConnection,
} from '@octopus/contracts';
import { authProviderFor, defaultScopesFor, isRegisteredAuthProvider } from '@octopus/marketing';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';
import {
  auditConnection,
  readConnections,
  revokeConnection,
  writeConnection,
} from '../lib/connections';
import { signState, verifyState, type StateConfig } from '../lib/oauth-state';

/**
 * Connecting a channel account: the writer `channel_connections` has been
 * waiting for since `20260829121000`.
 *
 * **This is the one route group where RLS defends nothing**, and it changes how
 * every handler below is written. The table holds an access token and a refresh
 * token; RLS filters rows and not columns, so a select policy would hand a
 * member the secrets. The table therefore carries no policy and no grant at all,
 * a client gets `permission denied`, and every read here must run as the service
 * role. Elsewhere in this codebase a handler reads as the caller and lets
 * Postgres decide; here **the route is the entire control**.
 *
 * So membership is established first and separately, by reading the room as the
 * caller. If RLS hides the room, the answer is 404 and nothing else runs. Only
 * then does a service-role client touch `channel_connections`, and only through
 * `lib/connections.ts`, whose column list is the other half of the control.
 *
 * **Who may do what.** Reading is for any member, which is the projection the
 * migration promised: "Meta account connected, scopes X, expires Y" is what a
 * member legitimately needs. Connecting and disconnecting are owner-only,
 * because `connect_channel` is `high_risk` in exactly the way `create_campaign`
 * is: it hands a system access to somebody's real account.
 *
 * **The callback arrives here through the BFF, not from the platform.**
 * ADR-0012: the redirect lands on the web origin where the person is signed in,
 * and the browser's session is what proves who they are. That is the second leg;
 * the signed `state` is the first. Neither alone would be enough, and a callback
 * terminating at Fastify would have only the state.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });
const ConnectionParams = RoomParams.extend({ connectionId: z.string().uuid() });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface ConnectionRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
  /** Where the browser comes back to. The web origin, per ADR-0012. */
  webUrl: string;
  /**
   * Null when `OAUTH_STATE_SECRET` is unset. Connecting is then refused with a
   * sentence naming the variable, rather than the service failing to boot or,
   * far worse, signing state with a constant anybody could forge.
   */
  state: StateConfig | null;
}

export async function connectionRoutes(
  app: FastifyInstance,
  opts: ConnectionRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);
  const redirectUri = new URL('/connections/callback', opts.webUrl).toString();

  /**
   * Membership and ownership in one read, as the caller.
   *
   * Returns 404 rather than 403 for a room the caller cannot see, matching every
   * other route here: a non-member is not told the room exists.
   */
  async function resolveRoom(
    request: FastifyRequest,
    reply: FastifyReply,
    roomId: string,
  ): Promise<{ ownerId: string | null } | null> {
    const db = createUserClient(opts.supabase, request.accessToken as string);
    const { data: room, error } = await db
      .from('rooms')
      .select('owner_id')
      .eq('id', roomId)
      .maybeSingle<{ owner_id: string | null }>();

    if (error) {
      request.log.error({ err: error, roomId }, 'room read failed');
      void fail(reply, 500, 'internal_error', 'Could not load the workspace.');
      return null;
    }
    if (!room) {
      void fail(reply, 404, 'not_found', 'Workspace not found.');
      return null;
    }
    return { ownerId: room.owner_id };
  }

  /** What a member may see. Any member; the tokens are not in the projection. */
  app.get(
    '/api/rooms/:roomId/connections',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ connections: ChannelConnection[] } | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');

      const room = await resolveRoom(request, reply, params.data.roomId);
      if (!room) return reply;

      try {
        const admin = createServiceClient(opts.supabase);
        return { connections: await readConnections(admin, params.data.roomId) };
      } catch (err) {
        request.log.error({ err, roomId: params.data.roomId }, 'connection read failed');
        return fail(reply, 500, 'internal_error', 'Could not load connected accounts.');
      }
    },
  );

  /**
   * Begin an authorisation.
   *
   * The client chooses the provider and the channel and nothing else. The
   * redirect URI is composed here rather than accepted, because a caller who
   * could name it could send somebody's authorisation code to an address of
   * their choosing, which is the whole game. The scopes come from the registry
   * for the same reason: what we ask for is a reviewed decision in a file.
   */
  app.post(
    '/api/rooms/:roomId/connections/start',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const body = StartConnectionBody.safeParse(request.body);
      if (!body.success)
        return fail(reply, 400, 'bad_request', 'provider and channel are required.');

      if (!opts.state) {
        // Named, so the fix is one line of configuration rather than a hunt.
        return fail(
          reply,
          503,
          'not_configured',
          'Connecting an account needs OAUTH_STATE_SECRET to be set on the API.',
        );
      }

      const { roomId } = params.data;
      const { provider, channel } = body.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, roomId);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can connect an account.');
      }

      // Refused before anything is signed. An unregistered provider is one
      // nobody reviewed, and the registry raises rather than falling back.
      if (!isRegisteredAuthProvider(provider)) {
        return fail(
          reply,
          400,
          'bad_request',
          `"${provider}" is not a provider we can connect to.`,
        );
      }

      const state = signState(
        { roomId, userId, provider, channel },
        opts.state,
        Date.now(),
        randomUUID(),
      );

      const authorizeUrl = authProviderFor(provider).authorizeUrl({
        state,
        redirectUri,
        scopes: defaultScopesFor(provider),
      });

      request.log.info({ roomId, provider, channel, userId }, 'channel authorisation started');
      return reply.code(200).send({ authorizeUrl });
    },
  );

  /**
   * Finish one.
   *
   * Order is the safety property, and it is the opposite of the convenient one:
   * the state is verified before the code is looked at, because until the
   * signature checks out every field in the request is attacker-supplied.
   */
  app.post(
    '/api/rooms/:roomId/connections/callback',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const body = CompleteConnectionBody.safeParse(request.body);
      if (!body.success) return fail(reply, 400, 'bad_request', 'state is required.');
      if (!opts.state) {
        return fail(reply, 503, 'not_configured', 'Connecting an account is not configured.');
      }

      const { roomId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, roomId);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can connect an account.');
      }

      // The state carries the provider and channel it was issued for, so they
      // are read back off it rather than taken from the request. A callback that
      // let the caller restate them would let somebody swap a connection for
      // `fake` into one for a provider they never authorised.
      const unverified = decodeClaims(body.data.state);
      if (!unverified) {
        return fail(reply, 400, 'bad_request', 'That authorisation state is unreadable.');
      }

      const verdict = verifyState(
        body.data.state,
        opts.state,
        { roomId, userId, provider: unverified.provider, channel: unverified.channel },
        Date.now(),
      );
      if (!verdict.ok) {
        request.log.warn(
          { roomId, userId, rule: verdict.rule },
          'channel authorisation state refused',
        );
        return fail(reply, 400, 'bad_request', verdict.reason);
      }
      const { provider, channel } = verdict.claims;

      // The person said no. An ordinary outcome of asking, answered as one:
      // nothing is written, and the message is theirs rather than an error.
      if (body.data.error) {
        request.log.info({ roomId, provider, reason: body.data.error }, 'authorisation declined');
        return fail(
          reply,
          409,
          'access_denied',
          'That account was not connected, because the authorisation was declined.',
        );
      }
      if (!body.data.code) {
        return fail(reply, 400, 'bad_request', 'That authorisation returned no code.');
      }

      const exchanged = await authProviderFor(provider).exchangeCode({
        code: body.data.code,
        redirectUri,
      });
      if (!exchanged.ok) {
        request.log.warn(
          { roomId, provider, kind: exchanged.error.kind },
          'code exchange refused by the provider',
        );
        return fail(
          reply,
          exchanged.error.kind === 'access_denied' ? 409 : 502,
          exchanged.error.kind,
          exchanged.error.message,
        );
      }

      try {
        const admin = createServiceClient(opts.supabase);
        const connection = await writeConnection(admin, {
          roomId,
          connectedBy: userId,
          provider,
          channel,
          credential: exchanged.value,
          now: new Date(),
        });

        await auditConnection(
          admin,
          {
            verb: 'channel.connected',
            actorId: userId,
            connectionId: connection.id,
            // The scopes and the account, never the token. An audit trail that
            // recorded the credential would reintroduce, in a table with no
            // policy of its own, exactly what the projection exists to withhold.
            payload: {
              roomId,
              provider,
              channel,
              externalAccountId: connection.externalAccountId,
              grantedScopes: connection.grantedScopes,
            },
          },
          request.log,
        );

        request.log.info({ roomId, provider, channel, id: connection.id }, 'channel connected');
        return reply.code(201).send({ connection });
      } catch (err) {
        request.log.error({ err, roomId, provider }, 'could not store the connection');
        return fail(reply, 500, 'internal_error', 'Could not save that connection.');
      }
    },
  );

  /** Disconnect. Owner-only, and a revocation rather than a delete. */
  app.delete(
    '/api/rooms/:roomId/connections/:connectionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = ConnectionParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId and connectionId must be UUIDs.');
      }
      const { roomId, connectionId } = params.data;
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      const room = await resolveRoom(request, reply, roomId);
      if (!room) return reply;
      if (room.ownerId !== userId) {
        return fail(reply, 403, 'forbidden', 'Only the workspace owner can disconnect an account.');
      }

      try {
        const admin = createServiceClient(opts.supabase);
        const connection = await revokeConnection(admin, roomId, connectionId, new Date());
        if (!connection) {
          // Either it never existed in this room or it was already revoked. Both
          // are 409 rather than 404: the caller's next move is the same, and
          // distinguishing them would confirm which ids exist in a room.
          return fail(reply, 409, 'conflict', 'That account is not connected.');
        }

        await auditConnection(
          admin,
          {
            verb: 'channel.revoked',
            actorId: userId,
            connectionId: connection.id,
            payload: { roomId, provider: connection.provider, channel: connection.channel },
          },
          request.log,
        );

        request.log.info({ roomId, connectionId, userId }, 'channel disconnected');
        return reply.code(200).send({ connection });
      } catch (err) {
        request.log.error({ err, roomId, connectionId }, 'could not revoke the connection');
        return fail(reply, 500, 'internal_error', 'Could not disconnect that account.');
      }
    },
  );
}

/**
 * Read the provider and channel out of an **unverified** state, so they can be
 * handed to `verifyState` as the expectation it checks the signature against.
 *
 * Named `unverified` at the call site and used for nothing else, because that is
 * the whole risk: these values decide only *which* provider the signature is
 * then required to match, and `verifyState` refuses if the signed payload says
 * anything different. Nothing is trusted here; a forged pair simply fails the
 * comparison a moment later.
 */
function decodeClaims(token: string): { provider: string; channel: string } | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as {
      provider?: unknown;
      channel?: unknown;
    };
    if (typeof parsed.provider !== 'string' || typeof parsed.channel !== 'string') return null;
    return { provider: parsed.provider, channel: parsed.channel };
  } catch {
    return null;
  }
}
