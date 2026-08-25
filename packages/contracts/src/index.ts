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

/**
 * What running a step would do to the outside world. Mirrors
 * `public.task_risk_tier` and the tool risk tiers in `ai-orchestrator.md`.
 *
 * This is on the wire because it is an input to an authorisation decision, not a
 * presentation detail: the router refuses to auto-run `high_risk` whatever the
 * step's owner says, and `materialise_plan` carries it onto the task row so that
 * refusal survives the plan card it came from.
 */
export const TaskRiskTier = z.enum(['read_only', 'reversible', 'external', 'high_risk']);
export type TaskRiskTier = z.infer<typeof TaskRiskTier>;

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
  /**
   * What this step would do to the outside world, proposed by the planner and
   * then raised (never lowered) by the clamp in `services/ai`.
   *
   * Optional for the same reason `PlanEmbedPayload.goal` is: cards written before
   * this field existed do not carry it. Absent means `reversible`, which is
   * exactly what those cards already materialised as, so an old card renders and
   * approves unchanged. A tier that is *present and unrecognised* is a different
   * thing and `materialise_plan` raises on it rather than defaulting.
   */
  riskTier: TaskRiskTier.optional().default('reversible'),
  /**
   * Checkable statements about what the finished step must contain. Nothing reads
   * them yet; the marketplace's maker-checker validates a node's proof against
   * them, and generating them alongside the step is far cheaper than backfilling
   * criteria for work that has already been done.
   */
  acceptanceCriteria: z.array(z.string()).optional().default([]),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const PlanStage = z.object({
  stage: FunnelStage,
  steps: z.array(PlanStep),
});
export type PlanStage = z.infer<typeof PlanStage>;

/**
 * The five slots intake fills, named by `full-funnel-creator.md` step 1 rather
 * than invented here, so the playbook stays the specification.
 */
export const IntakeSlotKey = z.enum(['icp', 'offer', 'target_metric', 'budget_band', 'timeline']);
export type IntakeSlotKey = z.infer<typeof IntakeSlotKey>;

/**
 * One thing established about what the person wants.
 *
 * `source` separates what they said from what the model concluded, and it is
 * load-bearing rather than informational: an inferred slot is a guess about
 * someone's business that will shape a plan they act on, so the card has to be
 * able to show it as a guess. It also keeps a wrong inference attributable to the
 * model instead of to the person for "saying" something they never said.
 */
export const IntakeSlot = z.object({
  key: IntakeSlotKey,
  value: z.string().min(1).max(400),
  source: z.enum(['stated', 'inferred']),
});
export type IntakeSlot = z.infer<typeof IntakeSlot>;

/** The `payload` of an `action_embeds` row whose component is `plan`. */
export const PlanEmbedPayload = z.object({
  /**
   * The goal this plan answers, in the person's own words.
   *
   * Optional only because embeds written before it existed do not carry it;
   * everything new does. Two things need it and neither can reconstruct it.
   *
   * A **project** needs a goal, and approving a plan is what creates one. The
   * plan's `title` is the AI's restatement, which is a reasonable fallback and
   * not the same thing as what was asked.
   *
   * And the **flywheel** stores this payload as `feedback_events.subject`, the
   * labelled example of a human accepting or rejecting AI output. Without the
   * goal that label is an output with no input, which is not a training pair.
   */
  goal: z.string().optional(),
  title: z.string(),
  summary: z.string(),
  stages: z.array(PlanStage),
  citations: z.array(PlanCitation),

  /**
   * What intake established about this person: audience, offer, budget, timeline.
   *
   * Stored on the card so the EXECUTOR can reach it. Intake's slots reached the
   * planner and then died: measured on a real run where the person gave their
   * audience, 4 of 15 plan steps mentioned it and only 1 of 8 artifacts did, and
   * that one only because the planner happened to write the word into a step
   * title. So the plan knew who it was for and the work did not, and the copy
   * came back aimed at a marketer instead of at the customer.
   *
   * On the card rather than a new column because the card is already the record
   * of what was approved, `projects.source_embed_id` already points at it, and a
   * jsonb payload needs no migration to carry one more field.
   *
   * Optional, like `goal` above and for the same reason: cards written before
   * this do not have it, and absent must keep working rather than raising.
   */
  context: z.array(IntakeSlot).optional(),
});
export type PlanEmbedPayload = z.infer<typeof PlanEmbedPayload>;

export const IntakeQuestion = z.object({
  slot: IntakeSlotKey,
  question: z.string().min(1).max(240),
});
export type IntakeQuestion = z.infer<typeof IntakeQuestion>;

/**
 * The `payload` of an `action_embeds` row whose component is `question`.
 *
 * This card is also where the intake's state lives between rounds. The AI service
 * is stateless by design (ADR-0006), so something on this side has to carry the
 * slots forward, and a row that is already written, already RLS-scoped to the
 * room, and already visible to the person is a better place for it than a new
 * table nothing else would use. It also means the state and the questions it
 * produced can never disagree, because they are one row.
 */
export const QuestionEmbedPayload = z.object({
  /**
   * What this card is waiting for, and it changes what the next message MEANS.
   *
   * `answers` is the ordinary case: the goal is known and we are filling slots, so
   * the reply is appended to `answers`.
   *
   * `goal` is the case where there is no usable goal yet, because the person said
   * hello or asked about something this system cannot ground. Their next message
   * **replaces** the goal rather than being filed as an answer to it. Without this
   * distinction a conversation opening with "Hello" would plan for the goal
   * "Hello" forever, with everything real buried in `answers`.
   */
  awaiting: z.enum(['goal', 'answers', 'task_answers']),
  /** The goal so far. Empty while `awaiting` is `goal`. */
  goal: z.string(),
  /**
   * The slot-bound questions this card asked. Empty is legitimate and means the
   * card is waiting for a goal rather than for slots: "what are you trying to
   * grow" fills no particular slot, and forcing it under one would put a false
   * label on the answer when it comes back.
   */
  questions: z.array(IntakeQuestion).max(4),
  /** What rounds so far established. Handed straight back to `/intake`. */
  slots: z.array(IntakeSlot),
  /** Rounds already completed, so the cap is enforceable across requests. */
  round: z.number().int().min(0).max(10),
  /** Everything the person has said since the goal, oldest first. */
  answers: z.array(z.string()),
  /**
   * Consecutive turns that produced no usable goal.
   *
   * Bounded separately from `round` because the two measure different things.
   * `round` limits how much we interrogate someone who HAS told us what they
   * want. This limits how long we keep asking someone who has not. Following the
   * thread is right; following it forever is a system that will not take no for
   * an answer, so it stops and says so.
   */
  stalls: z.number().int().min(0).max(10),
  /**
   * The tasks this card is collecting answers for, when `awaiting` is
   * `task_answers`.
   *
   * A third kind of waiting, and it is genuinely different from the other two.
   * Intake asks what someone wants before there is a plan; this asks a question
   * the **plan itself** raised, about work only they can do: a budget, a
   * positioning call, which analytics source counts. Their reply is not context
   * for a future plan, it is the deliverable for a step that already exists.
   */
  taskIds: z.array(z.string().uuid()).default([]),
});
export type QuestionEmbedPayload = z.infer<typeof QuestionEmbedPayload>;

/**
 * A deliverable the agent produced for one approved step.
 *
 * Rendered as a card so the work is readable where the person already is, rather
 * than living in a table only SQL can reach. `citations` are source LABELS, as
 * `WriteArtifactProposal` carries them: the checker's job includes catching a
 * source the maker was never given, and a label is checkable for provenance where
 * an index is only checkable for range.
 */
export const ArtifactEmbedPayload = z.object({
  taskId: z.string().uuid(),
  artifactId: z.string().uuid(),
  /** The step this delivers, in the plan's own words. */
  step: z.string().min(1).max(200),
  stage: FunnelStage.optional(),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(8000),
  citations: z.array(z.string()).default([]),
});
export type ArtifactEmbedPayload = z.infer<typeof ArtifactEmbedPayload>;

/**
 * `answered` exists because the four original states describe a **verdict**, and
 * a question has none. Recording an answered question as `approved` would put an
 * untrue sentence in the audit trail and, worse, hand the flywheel a labelled
 * example of a person approving something they were never shown.
 */
export const EmbedState = z.enum(['pending', 'approved', 'rejected', 'expired', 'answered']);
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
  /**
   * The project an approval created, when it created one.
   *
   * Null on `request_changes`, and also null when materialising failed after the
   * verdict was recorded. That second case is deliberate rather than an error
   * response: the decision stands whatever happened afterwards, so the caller is
   * told the verdict took effect and that no project came of it, instead of
   * being told the approval failed when it did not.
   */
  projectId: z.string().uuid().nullable(),
});
export type EmbedActionResponse = z.infer<typeof EmbedActionResponse>;

/**
 * An interactive card attached to a message. `requiredRole` is echoed to the
 * client so the UI can disable what the caller cannot do, but the server checks
 * it again on the action route: a rule enforced only in React is not enforced.
 */
const EmbedBase = {
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  requiredRole: z.string(),
  state: EmbedState,
  createdAt: z.string(),
};

/**
 * Discriminated on `component` rather than left as one shape with a widened
 * payload. A card whose component says `plan` and whose payload is a question is
 * a bug the client should fail on, not render half of, and a union is what makes
 * that a parse error at the boundary instead of an undefined field deep in a
 * component.
 */
export const ActionEmbed = z.discriminatedUnion('component', [
  z.object({ ...EmbedBase, component: z.literal('plan'), payload: PlanEmbedPayload }),
  z.object({ ...EmbedBase, component: z.literal('question'), payload: QuestionEmbedPayload }),
  z.object({ ...EmbedBase, component: z.literal('artifact'), payload: ArtifactEmbedPayload }),
]);
export type ActionEmbed = z.infer<typeof ActionEmbed>;

/**
 * The narrowed variants, so a component that renders one kind of card says so in
 * its own signature rather than re-narrowing a union it was handed.
 */
export type PlanActionEmbed = Extract<ActionEmbed, { component: 'plan' }>;
export type QuestionActionEmbed = Extract<ActionEmbed, { component: 'question' }>;
export type ArtifactActionEmbed = Extract<ActionEmbed, { component: 'artifact' }>;

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
