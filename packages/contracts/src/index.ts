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

/* ----------------------------------------------------------- plan embeds */

/**
 * The six funnel stages (marketing-growth-engine.md). Fixed and ordered: the
 * plan card always renders all six, because a stage with no steps is meaningful
 * output (the corpus had nothing in scope) and hiding it would read as "this
 * plan has four parts" rather than "two stages are unsupported".
 */
export const FunnelStage = z.enum([
  'strategy',
  'content',
  'creative',
  'channels',
  'conversion',
  'measurement',
]);
export type FunnelStage = z.infer<typeof FunnelStage>;

/** Who executes a step. Mirrors `owner_type` in the workflow schema. */
export const StepOwner = z.enum(['AI', 'HUMAN', 'YOU']);
export type StepOwner = z.infer<typeof StepOwner>;

export const PlanCitation = z.object({
  sourceId: z.string(),
  label: z.string(),
  url: z.string().nullable().optional(),
  effectiveDate: z.string().nullable().optional(),
});
export type PlanCitation = z.infer<typeof PlanCitation>;

export const PlanStep = z.object({
  title: z.string(),
  detail: z.string(),
  owner: StepOwner,
  /**
   * 1-based indices into `PlanEmbedPayload.citations`. An empty array means the
   * step rests on no retrieved source, and the UI must mark it unverified rather
   * than render it identically to a grounded step (AGENTS.md rule 10).
   */
  citations: z.array(z.number().int().positive()),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanStage = z.object({
  stage: FunnelStage,
  steps: z.array(PlanStep),
});
export type PlanStage = z.infer<typeof PlanStage>;

/** The `payload` of an `action_embeds` row whose component is `plan`. */
export const PlanEmbedPayload = z.object({
  title: z.string(),
  summary: z.string(),
  stages: z.array(PlanStage),
  citations: z.array(PlanCitation),
});
export type PlanEmbedPayload = z.infer<typeof PlanEmbedPayload>;

export const EmbedState = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type EmbedState = z.infer<typeof EmbedState>;

/**
 * A verdict on an embed. `request_changes` carries a note, because the most
 * useful part of a rejection is why, and that note is the labelled signal the
 * flywheel is built from (learning-flywheel.md, mechanism 2).
 */
export const EmbedActionBody = z.object({
  action: z.enum(['approve', 'request_changes']),
  note: z.string().trim().max(2000).optional(),
});
export type EmbedActionBody = z.infer<typeof EmbedActionBody>;

export const EmbedActionResponse = z.object({
  id: z.string().uuid(),
  state: EmbedState,
});
export type EmbedActionResponse = z.infer<typeof EmbedActionResponse>;

/**
 * An interactive card attached to a message. `requiredRole` is echoed to the
 * client so the UI can disable what the caller cannot do, but the server checks
 * it again on the action route: a rule enforced only in React is not enforced.
 */
export const ActionEmbed = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  component: z.literal('plan'),
  payload: PlanEmbedPayload,
  requiredRole: z.string(),
  state: EmbedState,
  createdAt: z.string(),
});
export type ActionEmbed = z.infer<typeof ActionEmbed>;

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
  /**
   * The interactive card attached to this message, when there is one. Carried
   * on the message rather than fetched separately so the stream and its cards
   * arrive together and cannot render out of step with each other.
   */
  embed: ActionEmbed.nullable().default(null),
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

/** A room the caller belongs to. Renders as an entry in the guild rail. */
export const Room = z.object({
  id: z.string().uuid(),
  name: z.string(),
  projectId: z.string().uuid().nullable(),
  /**
   * Who owns the workspace. Exposed so the UI can hide actions the caller
   * cannot take; the server re-checks it on every action, because hiding a
   * button is presentation and not a permission.
   */
  ownerId: z.string().uuid().nullable(),
});
export type Room = z.infer<typeof Room>;

export const Channel = z.object({
  id: z.string().uuid(),
  roomId: z.string().uuid(),
  name: z.string(),
  section: z.string(),
  kind: z.enum(['text', 'topic']),
  position: z.number().int(),
});
export type Channel = z.infer<typeof Channel>;

/**
 * A room member joined to their profile. `displayName` is nullable because a
 * profile row is auto-created on signup before the person has named themselves.
 */
export const RoomMember = z.object({
  userId: z.string().uuid(),
  displayName: z.string().nullable(),
  role: z.enum(['user', 'human_node', 'verified_pro', 'admin', 'ops']),
  scope: z.string(),
  expiresAt: z.string().nullable(),
});
export type RoomMember = z.infer<typeof RoomMember>;

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

    listRooms: {
      method: 'GET',
      path: '/rooms',
      responses: {
        200: z.object({ rooms: z.array(Room) }),
        401: ApiError,
      },
      summary: 'Rooms the caller is a current member of',
    },

    createRoom: {
      method: 'POST',
      path: '/rooms',
      body: z.object({ name: z.string().trim().min(1).max(80) }),
      responses: {
        201: Room,
        400: ApiError,
        401: ApiError,
      },
      summary: 'Create a room and join it as the first member',
    },

    createAgentRun: {
      method: 'POST',
      path: '/rooms/:roomId/agent-runs',
      pathParams: RoomParams,
      body: z.object({ goal: z.string().trim().min(1).max(4000) }),
      responses: {
        /** Accepted. Follow the run over Realtime; the agent posts as a member. */
        202: z.object({ runId: z.string().uuid(), status: z.literal('accepted') }),
        400: ApiError,
        401: ApiError,
        404: ApiError,
      },
      summary: 'Start an agent run for a goal (returns immediately; never blocks on reasoning)',
    },

    listChannels: {
      method: 'GET',
      path: '/rooms/:roomId/channels',
      pathParams: RoomParams,
      responses: {
        200: z.object({ channels: z.array(Channel) }),
        401: ApiError,
        404: ApiError,
      },
      summary: 'Channels in a room',
    },

    listMembers: {
      method: 'GET',
      path: '/rooms/:roomId/members',
      pathParams: RoomParams,
      responses: {
        200: z.object({ members: z.array(RoomMember) }),
        401: ApiError,
        404: ApiError,
      },
      summary: 'Current members of a room, with profile basics',
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
