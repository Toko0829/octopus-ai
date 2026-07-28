import { initContract } from '@ts-rest/core';
import { z } from 'zod';

/**
 * Typed API contract shared by apps/api (implements) and apps/web (calls).
 * Zod schemas are the single source of truth; Fastify validation + the ts-rest
 * client + OpenAPI are all derived from here. See ADR-0004 and tech-stack.md.
 */
const c = initContract();

/** Uniform error envelope. Every non-2xx response uses this shape. */
export const ApiError = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.string().datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/* ------------------------------------------------------------------ chat */

/** Mirrors the `author_kind` enum in supabase/migrations/20260728120000_chat.sql. */
export const AuthorKind = z.enum(['user', 'agent', 'node', 'system']);
export type AuthorKind = z.infer<typeof AuthorKind>;

/**
 * A chat message as returned by the API. `seq` is the monotonic ordering cursor
 * (Postgres identity column) that drives since-cursor catch-up after a reconnect
 * (see ADR-0003: a live subscription is not durable catch-up).
 */
export const Message = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  channelId: z.string().uuid().nullable(),
  authorId: z.string().uuid().nullable(),
  authorKind: AuthorKind,
  body: z.string().nullable(),
  seq: z.coerce.number().int(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

/**
 * `idempotencyKey` is client-generated (one per composed message, reused across
 * retries) and backed by a UNIQUE constraint, so a retried send returns the
 * original message instead of posting a duplicate. AGENTS.md rule 9.
 *
 * `authorId`/`authorKind` are deliberately NOT accepted from the client: the
 * server sets them from the verified JWT, and the RLS policy re-checks both.
 */
export const PostMessageBody = z.object({
  body: z.string().trim().min(1).max(4000),
  channelId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(255),
});
export type PostMessageBody = z.infer<typeof PostMessageBody>;

export const ListMessagesQuery = z.object({
  /** Exclusive cursor: return messages with `seq` strictly greater than this. */
  since: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = z.object({
  messages: z.array(Message),
  /** Highest `seq` in this page; pass back as `since` to continue. Null when empty. */
  nextCursor: z.number().int().nullable(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

const RoomParams = z.object({ roomId: z.string().uuid() });

export const contract = c.router(
  {
    health: {
      method: 'GET',
      path: '/health',
      responses: {
        200: HealthResponse,
      },
      summary: 'Liveness probe',
    },

    listMessages: {
      method: 'GET',
      path: '/rooms/:roomId/messages',
      pathParams: RoomParams,
      query: ListMessagesQuery,
      responses: {
        200: ListMessagesResponse,
        401: ApiError,
        404: ApiError,
      },
      summary: 'Since-cursor message history for reconnects and late joiners',
    },

    postMessage: {
      method: 'POST',
      path: '/rooms/:roomId/messages',
      pathParams: RoomParams,
      body: PostMessageBody,
      responses: {
        201: Message,
        /** Idempotent replay: this key was already used, original returned. */
        200: Message,
        400: ApiError,
        401: ApiError,
        403: ApiError,
        404: ApiError,
        /** Idempotency key belongs to a different author or room. */
        409: ApiError,
      },
      summary: 'Post a message (server-authoritative; Postgres trigger broadcasts it)',
    },
  },
  {
    pathPrefix: '/api',
  },
);

export type Contract = typeof contract;
