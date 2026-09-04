import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PostgrestError } from '@supabase/supabase-js';
import {
  AgentPersona,
  ArtifactEmbedPayload,
  CampaignEmbedPayload,
  EmbedState,
  ListMessagesQuery,
  Message,
  PlanEmbedPayload,
  PostMessageBody,
  QuestionEmbedPayload,
  ReplanEmbedPayload,
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
  // Artifacts were missing here while the executor was writing them, so every
  // artifact embed ever stored failed this parse and `toEmbed` returned null:
  // the card had never rendered for anybody and only the plain-text body
  // reached the room. A union that silently drops what it does not recognise is
  // the right behaviour for a corrupt row and the wrong behaviour for a variant
  // somebody forgot to add, and nothing distinguished the two.
  z.object({ ...EmbedRowBase, component: z.literal('artifact'), payload: ArtifactEmbedPayload }),
  z.object({ ...EmbedRowBase, component: z.literal('replan'), payload: ReplanEmbedPayload }),
  z.object({ ...EmbedRowBase, component: z.literal('campaign'), payload: CampaignEmbedPayload }),
]);

/**
 * Database row shape (snake_case) for the columns we select. Exported so a test
 * can pin `MESSAGE_COLUMNS` against it.
 */
export const MessageRow = z.object({
  id: z.string(),
  room_id: z.string(),
  channel_id: z.string().nullable(),
  author_id: z.string().nullable(),
  author_kind: z.enum(['user', 'agent', 'node', 'system']),
  // Defaulted rather than required, because a row written before
  // `20260912120000` has no such key at all and every fixture in this
  // repository predates it. A missing persona and an explicit null mean the
  // same thing to the reader: the single legacy voice.
  persona: AgentPersona.nullable().default(null),
  body: z.string().nullable(),
  seq: z.coerce.number().int(),
  created_at: z.string(),
  thread_id: z.string().nullable(),
  // PostgREST returns an embedded one-to-one relation as an array or object
  // depending on how it infers cardinality, so accept both rather than depend on
  // the inference staying stable across schema changes.
  action_embeds: z.union([z.array(z.unknown()), z.unknown()]).nullish(),
});
type MessageRow = z.infer<typeof MessageRow>;

// `thread_id` joins the pinned select here rather than in `20260901121000`,
// which added the column and deliberately left this string alone: "the reader
// lands with the slice that has something to read." Slice 5 admits a node to a
// thread, so the owner's stream now interleaves two conversations and a client
// that could not tell them apart would render a node's work as if it had been
// said to the whole room.
//
// `persona` joins it with `20260912120000`, and unlike `thread_id` it has a
// reader on the day it lands: the stream names the voice that wrote each agent
// message, so a select that forgot the column would render every specialist as
// the legacy Octopus with nothing failing anywhere. Exported so a test can pin
// it against `MessageRow`, the way `PROJECT_COLUMNS` is pinned: a select string
// that drifts from the schema fails at runtime only.
export const MESSAGE_COLUMNS =
  'id, room_id, channel_id, author_id, author_kind, persona, body, seq, created_at, thread_id, ' +
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
  //
  // **Exhaustive, and the `never` is the point.** The artifact card went
  // unrendered for everybody because a variant was missing from the union above,
  // and the tail of this function used to end in a bare `return ... 'artifact'`,
  // which would have quietly mislabelled a fourth component as an artifact rather
  // than failing. Adding a component to `EmbedRow` without adding an arm here is
  // now a compile error.
  const embed = parsed.data;
  switch (embed.component) {
    case 'plan':
      return { ...common, component: 'plan', payload: embed.payload };
    case 'question':
      return { ...common, component: 'question', payload: embed.payload };
    case 'artifact':
      return { ...common, component: 'artifact', payload: embed.payload };
    case 'replan':
      return { ...common, component: 'replan', payload: embed.payload };
    case 'campaign':
      return { ...common, component: 'campaign', payload: embed.payload };
    default: {
      const unreachable: never = embed;
      return unreachable;
    }
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    channelId: row.channel_id,
    authorId: row.author_id,
    authorKind: row.author_kind,
    persona: row.persona,
    // Always null for now, and honestly so: `messages.model` is a column that
    // does not exist yet, so no message in this system was written by a model
    // anybody chose. The contract carries the field from the slice that added
    // the registry, and the column and the reader land together with the Node
    // wiring, at which point this line reads `row.model`.
    model: null,
    body: row.body,
    seq: row.seq,
    createdAt: row.created_at,
    threadId: row.thread_id,
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
          .select(MESSAGE_COLUMNS)
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
      const { body, channelId, threadId, idempotencyKey } = parsedBody.data;
      const user = request.user as NonNullable<typeof request.user>;
      const db = createUserClient(opts.supabase, request.accessToken as string);

      try {
        if (!(await roomVisibleTo(db, roomId))) {
          return fail(reply, 404, 'not_found', 'Room not found.');
        }

        // **The thread decides the channel when one is given.** A thread already
        // knows which channel it lives in (`threads.channel_id`, kept honest by
        // the composite foreign key), so a request naming both could name two
        // different ones and the table would then have to arbitrate. Derived
        // rather than validated, which removes the disagreement instead of
        // catching it.
        //
        // Read as the caller: `threads_select_member` is
        // `private.member_scope_covers(room_id, id)`, so a thread the caller is
        // not admitted to simply is not there and this is a 400 rather than a
        // 403 that confirms it exists.
        let effectiveChannelId = channelId ?? null;
        if (threadId) {
          const { data: thread, error: threadErr } = await db
            .from('threads')
            .select('id, channel_id')
            .eq('id', threadId)
            .eq('room_id', roomId)
            .maybeSingle();
          if (threadErr) throw threadErr;
          if (!thread) {
            return fail(reply, 400, 'bad_request', 'threadId does not belong to this room.');
          }
          effectiveChannelId = (thread as { channel_id: string }).channel_id;
        } else if (channelId) {
          // A channel from another room would otherwise be accepted: the RLS policy
          // gates the room, not the channel/room pairing.
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

        // **`author_kind` is derived from the caller's own membership row, never
        // from the request.** A live `human_node` membership scoped to the thread
        // being posted into makes this `'node'`; everything else stays `'user'`.
        //
        // Read as the caller, so `room_members_select_member` decides what is
        // visible and a thread-scoped member reads exactly their own row
        // (`20260901123000`). `messages_insert_own` then re-checks the same fact
        // from the same table independently (`20260904127000`), which is the
        // defense in depth rule 6 asks for rather than a route somebody could
        // later call with a different thread.
        //
        // **The node posts through their own grant**, like every other member
        // (rule 5). The alternative, a server-mediated `POST /api/node/messages`
        // writing with the secret key, would be a second write path to keep in
        // step with this one on the idempotency contract, the pairing checks and
        // the broadcast payload. Argued in `20260904127000`'s header.
        let authorKind: 'user' | 'node' = 'user';
        if (threadId) {
          const { data: membership, error: memberErr } = await db
            .from('room_members')
            .select('role, scope, thread_id')
            .eq('room_id', roomId)
            .eq('user_id', user.sub)
            .maybeSingle();
          if (memberErr) throw memberErr;
          const m = membership as { role: string; scope: string; thread_id: string | null } | null;
          if (m && m.role === 'human_node' && m.scope === 'thread' && m.thread_id === threadId) {
            authorKind = 'node';
          }
        }

        // author_id/author_kind come from the verified JWT and from the database,
        // never the request body. The `messages_insert_own` policy independently
        // re-checks both.
        const { data, error } = await db
          .from('messages')
          .insert({
            room_id: roomId,
            channel_id: effectiveChannelId,
            thread_id: threadId ?? null,
            author_id: user.sub,
            author_kind: authorKind,
            body,
            idempotency_key: idempotencyKey,
          })
          .select(MESSAGE_COLUMNS)
          .single();

        if (!error) {
          return reply.code(201).send(toMessage(MessageRow.parse(data)));
        }

        const pgErr = error as PostgrestError;

        // Retry of a send we already accepted: return the original, do not duplicate.
        if (pgErr.code === PG_UNIQUE_VIOLATION) {
          const { data: existing, error: lookupErr } = await db
            .from('messages')
            .select(MESSAGE_COLUMNS)
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
