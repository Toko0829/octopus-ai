import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PostgrestError } from '@supabase/supabase-js';
import {
  EmbedState,
  ListMessagesQuery,
  Message,
  PlanEmbedPayload,
  PostMessageBody,
  QuestionEmbedPayload,
  type ListMessagesResponse,
} from '@octopus/contracts';
import { z } from 'zod';
import { createRequireAuth, type AuthVerifier } from '../plugins/auth';
import { createUserClient, type SupabaseConfig } from '../lib/supabase';

/**
 * Chat write path + since-cursor catch-up. Implements `postMessage` / `listMessages`
 * from @octopus/contracts.
 *
 * Server-authoritative persist-then-broadcast (docs/30-modules/chat-discord.md):
 * client -> Fastify -> RLS membership check -> INSERT -> Postgres trigger calls
 * realtime.broadcast_changes() -> topic `chat:room:{id}`. This service never pushes
 * to Realtime itself; the database is the one that fans out, which is what keeps
 * Postgres the single source of truth (AGENTS.md rule 5).
 */

/** Postgres SQLSTATEs we translate into HTTP rather than leaking as 500s. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_RLS_VIOLATION = '42501';
/** PostgREST's "expected exactly one row, got none". */
const PGRST_NO_ROWS = 'PGRST116';

const RoomParams = z.object({ roomId: z.string().uuid() });

/**
 * The embed joined onto a message, when one exists.
 *
 * `payload` is parsed rather than cast. It was written by this server, but it is
 * still JSONB the database will hand back as `unknown`, and a card rendered from
 * an unvalidated shape fails in the UI rather than here, where the row can be
 * named. A row that does not parse is dropped and the message renders plainly,
 * which degrades to a normal message instead of breaking the whole stream.
 */
const EmbedRowBase = {
  id: z.string(),
  message_id: z.string(),
  required_role: z.string(),
  state: EmbedState,
  created_at: z.string(),
};

/**
 * Discriminated on `component`, so each card's payload is validated against its
 * own shape. Widening `payload` to accept either would let a plan render from a
 * question's fields and only fail in the browser.
 */
const EmbedRow = z.discriminatedUnion('component', [
  z.object({ ...EmbedRowBase, component: z.literal('plan'), payload: PlanEmbedPayload }),
  z.object({ ...EmbedRowBase, component: z.literal('question'), payload: QuestionEmbedPayload }),
]);

/** Database row shape (snake_case) for the columns we select. */
const MessageRow = z.object({
  id: z.string(),
  room_id: z.string(),
  channel_id: z.string().nullable(),
  author_id: z.string().nullable(),
  author_kind: z.enum(['user', 'agent', 'node', 'system']),
  body: z.string().nullable(),
  seq: z.coerce.number().int(),
  created_at: z.string(),
  // PostgREST returns an embedded one-to-one relation as an array or object
  // depending on how it infers cardinality, so accept both rather than depend on
  // the inference staying stable across schema changes.
  action_embeds: z.union([z.array(z.unknown()), z.unknown()]).nullish(),
});
type MessageRow = z.infer<typeof MessageRow>;

const SELECT_COLUMNS =
  'id, room_id, channel_id, author_id, author_kind, body, seq, created_at, ' +
  'action_embeds(id, message_id, component, payload, required_role, state, created_at)';

function toEmbed(raw: unknown): Message['embed'] {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return null;

  const parsed = EmbedRow.safeParse(candidate);
  if (!parsed.success) return null;

  const common = {
    id: parsed.data.id,
    messageId: parsed.data.message_id,
    requiredRole: parsed.data.required_role,
    state: parsed.data.state,
    createdAt: parsed.data.created_at,
  };

  // Rebuilt per variant rather than spread from the parsed row, so the returned
  // value satisfies the union by construction instead of by assertion.
  return parsed.data.component === 'plan'
    ? { ...common, component: 'plan', payload: parsed.data.payload }
    : { ...common, component: 'question', payload: parsed.data.payload };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorKind: row.author_kind,
    body: row.body,
    seq: row.seq,
    createdAt: row.created_at,
    embed: toEmbed(row.action_embeds),
  };
}

function fail(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

export interface MessageRoutesOptions {
  verify: AuthVerifier;
  supabase: SupabaseConfig;
}

export async function messageRoutes(
  app: FastifyInstance,
  opts: MessageRoutesOptions,
): Promise<void> {
  const requireAuth = createRequireAuth(opts.verify);

  /**
   * Membership is not re-implemented here; we ask Postgres. A non-member's select
   * returns zero rows under `rooms_select_member`, which we report as 404 rather
   * than 403 so the API does not confirm that a room the caller cannot see exists.
   */
  async function roomVisibleTo(
    db: ReturnType<typeof createUserClient>,
    roomId: string,
  ): Promise<boolean> {
    const { data, error } = await db.from('rooms').select('id').eq('id', roomId).maybeSingle();
    if (error) throw error;
    return data !== null;
  }

  app.get(
    '/api/rooms/:roomId/messages',
    { preHandler: requireAuth },
    async (request, reply): Promise<ListMessagesResponse | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      }
      const query = ListMessagesQuery.safeParse(request.query);
      if (!query.success) {
        return fail(reply, 400, 'bad_request', 'Invalid `since` or `limit`.');
      }

      const { roomId } = params.data;
      const { since, limit } = query.data;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        if (!(await roomVisibleTo(db, roomId))) {
          return fail(reply, 404, 'not_found', 'Room not found.');
        }

        let q = db
          .from('messages')
          .select(SELECT_COLUMNS)
          .eq('room_id', roomId)
          .order('seq', { ascending: true })
          .limit(limit);
        if (since !== undefined) q = q.gt('seq', since);

        const { data, error } = await q;
        if (error) throw error;

        const messages = (data ?? []).map((row) => toMessage(MessageRow.parse(row)));
        return {
          messages,
          nextCursor: messages.length > 0 ? (messages[messages.length - 1] as Message).seq : null,
        };
      } catch (err) {
        request.log.error({ err, roomId, userId: request.user?.sub }, 'listMessages failed');
        return fail(reply, 500, 'internal_error', 'Could not load messages.');
      }
    },
  );

  app.post(
    '/api/rooms/:roomId/messages',
    { preHandler: requireAuth },
    async (request, reply): Promise<Message | FastifyReply> => {
      const params = RoomParams.safeParse(request.params);
      if (!params.success) {
        return fail(reply, 400, 'bad_request', 'roomId must be a UUID.');
      }
      const parsedBody = PostMessageBody.safeParse(request.body);
      if (!parsedBody.success) {
        return fail(
          reply,
          400,
          'bad_request',
          parsedBody.error.issues[0]?.message ?? 'Invalid body.',
        );
      }

      const { roomId } = params.data;
      const { body, channelId, idempotencyKey } = parsedBody.data;
      const user = request.user as NonNullable<typeof request.user>;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        if (!(await roomVisibleTo(db, roomId))) {
          return fail(reply, 404, 'not_found', 'Room not found.');
        }

        // A channel from another room would otherwise be accepted: the RLS policy
        // gates the room, not the channel/room pairing.
        if (channelId) {
          const { data: channel, error: channelErr } = await db
            .from('channels')
            .select('id')
            .eq('id', channelId)
            .eq('room_id', roomId)
            .maybeSingle();
          if (channelErr) throw channelErr;
          if (!channel) {
            return fail(reply, 400, 'bad_request', 'channelId does not belong to this room.');
          }
        }

        // author_id/author_kind come from the verified JWT, never the request body.
        // The `messages_insert_own` policy independently re-checks both.
        const { data, error } = await db
          .from('messages')
          .insert({
            room_id: roomId,
            channel_id: channelId ?? null,
            author_id: user.sub,
            author_kind: 'user',
            body,
            idempotency_key: idempotencyKey,
          })
          .select(SELECT_COLUMNS)
          .single();

        if (!error) {
          return reply.code(201).send(toMessage(MessageRow.parse(data)));
        }

        const pgErr = error as PostgrestError;

        // Retry of a send we already accepted: return the original, do not duplicate.
        if (pgErr.code === PG_UNIQUE_VIOLATION) {
          const { data: existing, error: lookupErr } = await db
            .from('messages')
            .select(SELECT_COLUMNS)
            .eq('idempotency_key', idempotencyKey)
            .maybeSingle();

          if (lookupErr && lookupErr.code !== PGRST_NO_ROWS) throw lookupErr;

          if (existing) {
            const row = MessageRow.parse(existing);
            // Same key, different author or room: someone else's key. Refuse rather
            // than hand back a message that is not theirs.
            if (row.author_id === user.sub && row.room_id === roomId) {
              return reply.code(200).send(toMessage(row));
            }
          }
          return fail(reply, 409, 'conflict', 'idempotencyKey has already been used.');
        }

        // RLS refused the insert: the caller is not a current member of this room.
        if (pgErr.code === PG_RLS_VIOLATION) {
          request.log.warn({ roomId, userId: user.sub }, 'rls denied message insert (non-member)');
          return fail(reply, 403, 'forbidden', 'You are not a member of this room.');
        }

        throw error;
      } catch (err) {
        request.log.error({ err, roomId, userId: user.sub }, 'postMessage failed');
        return fail(reply, 500, 'internal_error', 'Could not post message.');
      }
    },
  );
}
