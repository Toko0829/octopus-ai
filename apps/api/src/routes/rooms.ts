import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Channel, Room, RoomMember } from '@octopus/contracts';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createServiceClient, createUserClient, type SupabaseConfig } from '../lib/supabase';

/**
 * Room structure reads: the guild rail, the channel sidebar and the member panel.
 *
 * Every query runs as the caller, so RLS decides what exists. None of these
 * handlers filter by membership themselves — `rooms_select_member` and
 * `room_members_select_member` already do, and duplicating that logic in the
 * service is how the two drift apart.
 */

const RoomParams = z.object({ roomId: z.string().uuid() });

const RoomRow = z.object({ id: z.string(), name: z.string(), project_id: z.string().nullable() });
const ChannelRow = z.object({
  id: z.string(),
  room_id: z.string(),
  name: z.string(),
  section: z.string(),
  kind: z.enum(['text', 'topic']),
  position: z.number().int(),
});
const MemberRow = z.object({
  user_id: z.string(),
  role: z.enum(['user', 'human_node', 'verified_pro', 'admin', 'ops']),
  scope: z.string(),
  expires_at: z.string().nullable(),
});
const ProfileRow = z.object({ user_id: z.string(), display_name: z.string().nullable() });

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface RoomRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function roomRoutes(app: FastifyInstance, opts: RoomRoutesOptions): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  app.get(
    '/api/rooms',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ rooms: Room[] } | FastifyReply> => {
      const db = createUserClient(opts.supabase, request.accessToken as string);
      try {
        const { data, error } = await db
          .from('rooms')
          .select('id, name, project_id')
          .order('created_at', { ascending: true });
        if (error) throw error;
        return {
          rooms: (data ?? []).map((row) => {
            const r = RoomRow.parse(row);
            return { id: r.id, name: r.name, projectId: r.project_id };
          }),
        };
      } catch (err) {
        request.log.error({ err, userId: request.user?.sub }, 'listRooms failed');
        return fail(reply, 500, 'internal_error', 'Could not load rooms.');
      }
    },
  );

  /**
   * Bootstrap a room. Authorisation is "the caller has a valid token", enforced by
   * requireAuth above; the writes then run with the service client because the
   * creator cannot insert their own membership under RLS before that membership
   * exists. Nothing from the request except the trimmed name reaches the database.
   */
  app.post(
    '/api/rooms',
    { preHandler: requireAuth },
    async (request, reply): Promise<Room | FastifyReply> => {
      const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse(request.body);
      if (!parsed.success) {
        return fail(reply, 400, 'bad_request', 'A room name of 1 to 80 characters is required.');
      }
      const userId = (request.user as NonNullable<typeof request.user>).sub;

      let admin;
      try {
        admin = createServiceClient(opts.supabase);
      } catch (err) {
        request.log.error({ err }, 'createRoom unavailable: no secret key configured');
        return fail(reply, 500, 'internal_error', 'Room creation is not configured.');
      }

      try {
        const { data: room, error } = await admin
          .from('rooms')
          .insert({ name: parsed.data.name })
          .select('id, name, project_id')
          .single();
        if (error) throw error;

        const created = RoomRow.parse(room);

        const [{ error: memberErr }, { error: channelErr }] = await Promise.all([
          admin.from('room_members').insert({ room_id: created.id, user_id: userId, role: 'user' }),
          admin
            .from('channels')
            .insert({ room_id: created.id, name: 'brief', section: 'Overview', position: 0 }),
        ]);
        if (memberErr) throw memberErr;
        if (channelErr) throw channelErr;

        request.log.info({ roomId: created.id, userId }, 'room created');
        return reply
          .code(201)
          .send({ id: created.id, name: created.name, projectId: created.project_id });
      } catch (err) {
        request.log.error({ err, userId }, 'createRoom failed');
        return fail(reply, 500, 'internal_error', 'Could not create the room.');
      }
    },
  );

  app.get(
    '/api/rooms/:roomId/channels',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ channels: Channel[] } | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { data, error } = await db
          .from('channels')
          .select('id, room_id, name, section, kind, position')
          .eq('room_id', params.data.roomId)
          .order('position', { ascending: true });
        if (error) throw error;

        // An invisible room and an empty room are indistinguishable from the
        // channel table alone, so confirm the room before reporting "none".
        if ((data ?? []).length === 0) {
          const { data: room, error: roomErr } = await db
            .from('rooms')
            .select('id')
            .eq('id', params.data.roomId)
            .maybeSingle();
          if (roomErr) throw roomErr;
          if (!room) return fail(reply, 404, 'not_found', 'Room not found.');
        }

        return {
          channels: (data ?? []).map((row) => {
            const c = ChannelRow.parse(row);
            return {
              id: c.id,
              roomId: c.room_id,
              name: c.name,
              section: c.section,
              kind: c.kind,
              position: c.position,
            };
          }),
        };
      } catch (err) {
        request.log.error({ err, userId: request.user?.sub }, 'listChannels failed');
        return fail(reply, 500, 'internal_error', 'Could not load channels.');
      }
    },
  );

  app.get(
    '/api/rooms/:roomId/members',
    { preHandler: requireAuth },
    async (request, reply): Promise<{ members: RoomMember[] } | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        const { data, error } = await db
          .from('room_members')
          .select('user_id, role, scope, expires_at')
          .eq('room_id', params.data.roomId);
        if (error) throw error;

        const rows = (data ?? []).map((row) => MemberRow.parse(row));
        if (rows.length === 0) return fail(reply, 404, 'not_found', 'Room not found.');

        // Separate query rather than a join: profiles are readable through
        // `profiles_select_co_member`, and keeping it explicit makes it obvious
        // that a missing profile degrades to a null name instead of dropping
        // the member from the list.
        const { data: profiles, error: profileErr } = await db
          .from('profiles')
          .select('user_id, display_name')
          .in(
            'user_id',
            rows.map((r) => r.user_id),
          );
        if (profileErr) throw profileErr;

        const nameById = new Map(
          (profiles ?? []).map((p) => {
            const parsed = ProfileRow.parse(p);
            return [parsed.user_id, parsed.display_name] as const;
          }),
        );

        return {
          members: rows.map((r) => ({
            userId: r.user_id,
            displayName: nameById.get(r.user_id) ?? null,
            role: r.role,
            scope: r.scope,
            expiresAt: r.expires_at,
          })),
        };
      } catch (err) {
        request.log.error({ err, userId: request.user?.sub }, 'listMembers failed');
        return fail(reply, 500, 'internal_error', 'Could not load members.');
      }
    },
  );
}
