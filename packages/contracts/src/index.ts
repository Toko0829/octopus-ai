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

/* --------------------------------------------------------------- marketing */

/**
 * Where a campaign runs. Mirrors `public.marketing_channel`.
 *
 * It lives here rather than in `packages/marketing` because it now crosses a
 * wire: the campaign card carries it and the action route reads it back.
 * `packages/marketing` re-exports this one rather than declaring its own, which
 * is the whole reason it was moved instead of copied. Its own header named this
 * slice as the moment that would happen.
 *
 * There is deliberately no `fake` member. A channel is a place in the world; a
 * provider is how we talk to one, and `channel_connections.provider` is where
 * `fake` lives.
 */
export const MarketingChannel = z.enum(['meta', 'google', 'email', 'organic_social']);
export type MarketingChannel = z.infer<typeof MarketingChannel>;

/**
 * Mirrors `public.campaign_state`. On the wire for display only: every
 * transition is decided in Postgres by `private.guard_campaign_transition`, so
 * nothing a client sends can move a campaign.
 */
export const CampaignState = z.enum([
  'draft',
  'ready',
  'publishing',
  'live',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);
export type CampaignState = z.infer<typeof CampaignState>;

export const PlanCitation = z.object({
  sourceId: z.string(),
  label: z.string(),
  url: z.string().nullable().optional(),
  effectiveDate: z.string().nullable().optional(),
});
export type PlanCitation = z.infer<typeof PlanCitation>;

export const PlanStep = z.object({
  /**
   * Names this step inside its own plan, so another step can depend on it.
   *
   * Optional because cards written before dependencies existed carry no ids, and
   * because a step nothing depends on never needs one. It is a join key rather
   * than a display value: `materialise_plan` builds an id -> task uuid map from
   * it, which is why the shape is constrained on the Python side that mints it.
   */
  id: z.string().optional(),
  /**
   * Ids of steps whose output this step consumes, and the only edges that exist.
   * They become `task_deps` rows with `dep_kind = 'hard'` when the plan is
   * approved, which is what makes the scheduler hold this step back until they
   * are approved.
   *
   * Stated by the planner and sanitised in `services/ai` before it gets here:
   * anything unresolvable is already dropped, because an invented edge blocks
   * work for a reason that does not exist while a missing one merely lets two
   * things run at once. `materialise_plan` still refuses a reference it cannot
   * resolve, since a card can also arrive from an older service or a hand edit.
   */
  dependsOn: z.array(z.string()).optional().default([]),
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

/* --------------------------------------------------------- replan embeds */

/**
 * One change a replan proposes. The set is small on purpose: everything an owner
 * wants from a replan is work added, work called off, or work whose description
 * was wrong, and each is separately reviewable on a card.
 */
export const ReplanAddStep = z.object({
  op: z.literal('add_step'),
  stage: FunnelStage,
  /** Names the step within this diff, so another added step can depend on it. */
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  owner: StepOwner,
  citations: z.array(z.number().int().positive()).default([]),
  riskTier: TaskRiskTier.optional().default('reversible'),
  acceptanceCriteria: z.array(z.string()).optional().default([]),
  /**
   * May name another step this diff adds, by its `id`, or an existing task, by
   * its UUID. The two spaces cannot collide: a step id is at most 32 characters
   * of lowercase, digits and hyphens, and a UUID is 36.
   */
  dependsOn: z.array(z.string()).optional().default([]),
});
export type ReplanAddStep = z.infer<typeof ReplanAddStep>;

export const ReplanCancelTask = z.object({
  op: z.literal('cancel_task'),
  taskId: z.string().uuid(),
  /**
   * The step's title as it stood when the diff was written, so the card reads on
   * its own. A person approving "cancel 3f2a-..." is approving a UUID.
   *
   * Filled in by Node from the DAG it already sent to the core, never asked of the
   * model: it is a fact about a row, and asking for it would create a second
   * source of truth that can disagree with the first. Optional so a card written
   * before this parses, and because the title is a convenience rather than the
   * reference: `taskId` is what `apply_plan_diff` acts on.
   */
  taskTitle: z.string().optional(),
  /**
   * Required, and not decoration. Cancelling is the one change that destroys
   * planned work, so the audit trail has to say why; `apply_plan_diff` writes it
   * into the `task.replan_cancelled` event, which the state transition itself
   * cannot know.
   */
  reason: z.string(),
});
export type ReplanCancelTask = z.infer<typeof ReplanCancelTask>;

/**
 * Correct the description of a step that is still going to happen.
 *
 * **The absent fields are the safety property.** State, owner and risk tier
 * cannot be edited here. Changing who runs a step, or what it is permitted to
 * touch, is a different piece of work and goes through cancel plus add, so the
 * person sees both halves and approves them. Routing an authorisation decision
 * through the op that looks least like one is what rules 7 and 11 forbid, and
 * `apply_plan_diff` enforces it by naming three columns rather than taking a
 * payload, so there is no flag anybody can pass to widen it.
 */
export const ReplanModifyTask = z.object({
  op: z.literal('modify_task'),
  taskId: z.string().uuid(),
  /** As on `cancel_task`: filled in by Node so the card reads on its own. */
  taskTitle: z.string().optional(),
  detail: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  /** Adds edges and cannot remove them: a removable edge unblocks a step whose
   * prerequisite was never done. */
  addDependsOn: z.array(z.string()).optional().default([]),
});
export type ReplanModifyTask = z.infer<typeof ReplanModifyTask>;

export const ReplanOp = z.discriminatedUnion('op', [
  ReplanAddStep,
  ReplanCancelTask,
  ReplanModifyTask,
]);
export type ReplanOp = z.infer<typeof ReplanOp>;

/** The `payload` of an `action_embeds` row whose component is `replan`. */
export const ReplanEmbedPayload = z.object({
  projectId: z.string().uuid(),
  /** What the owner asked for, in their words, so the card says why it exists. */
  reason: z.string().optional(),
  summary: z.string(),
  ops: z.array(ReplanOp).min(1),
  citations: z.array(PlanCitation).default([]),
});
export type ReplanEmbedPayload = z.infer<typeof ReplanEmbedPayload>;

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
 * A campaign proposed for the owner's authorisation, and the first card whose
 * approval commits money rather than work.
 *
 * **`budgetCap` is null when the card is posted, and that is the design.** The
 * reasoning core proposes what to run and where, never how much to spend: a
 * number it invented would be indistinguishable on the card from one somebody
 * authorised, and this is the surface where that distinction is the entire
 * point. The owner types the cap before approving, and the action route writes
 * their number into this payload as it records the verdict, so the card the
 * flywheel stores and the payload `materialise_campaign` reads both carry the
 * figure the person actually agreed to.
 *
 * `projectId` is named in the payload rather than resolved from the card's room,
 * which is why `materialise_campaign` re-checks tenancy: the action route
 * verifies membership of the card's room, and that says nothing about the
 * project this payload points at.
 */
export const CampaignEmbedPayload = z.object({
  projectId: z.string().uuid(),
  /** The plan step this campaign delivers. Its approval is what closes the step. */
  taskId: z.string().uuid(),
  name: z.string().min(1).max(200),
  objective: z.string().max(500).optional(),
  channel: MarketingChannel,
  /** Null until the owner enters one. Never proposed by the model. */
  budgetCap: z.number().finite().nonnegative().nullable().default(null),
  /** Must match the project's currency; `materialise_campaign` refuses otherwise. */
  currency: z.string().length(3),
  /** Why this channel, in the card's own words, grounded in the citations below. */
  summary: z.string().min(1).max(800),
  citations: z.array(PlanCitation).default([]),
});
export type CampaignEmbedPayload = z.infer<typeof CampaignEmbedPayload>;

/**
 * `answered` exists because the four original states describe a **verdict**, and
 * a question has none. Recording an answered question as `approved` would put an
 * untrue sentence in the audit trail and, worse, hand the flywheel a labelled
 * example of a person approving something they were never shown.
 */
/**
 * Mirrors `public.embed_state`.
 *
 * `reported` and `dismissed` were missing here while the database had them, and
 * the omission was not cosmetic: `messages.ts` parses every stored embed against
 * this enum, so an artifact card written with `state: 'reported'` failed the
 * parse and was dropped on read. `ArtifactCard` had therefore never rendered for
 * anybody, and the only thing that reached the room was the plain-text fallback.
 *
 * Six values, because each records a different thing that happened rather than a
 * verdict borrowed from a neighbouring one: a question is `answered`, a
 * deliverable is `reported`, and a card someone walked away from is `dismissed`.
 */
export const EmbedState = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'answered',
  'reported',
  'dismissed',
]);
export type EmbedState = z.infer<typeof EmbedState>;

/**
 * A verdict on an embed. `request_changes` carries a note, because the most
 * useful part of a rejection is why, and that note is the labelled signal the
 * flywheel is built from (learning-flywheel.md, mechanism 2).
 */
export const EmbedActionBody = z.object({
  action: z.enum(['approve', 'request_changes']),
  note: z.string().trim().max(2000).optional(),
  /**
   * The spend the owner authorises, for a campaign card only. The route refuses
   * it on any other component rather than ignoring it, because a number silently
   * dropped on the way to an authorisation is the failure this field exists to
   * make impossible.
   *
   * Required to approve a campaign: a campaign approved with no cap would mean
   * "authorised, nothing authorised". Zero is legal and meaningful, since email
   * and organic social genuinely spend nothing.
   */
  budgetCap: z.number().finite().nonnegative().optional(),
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
  /**
   * The campaign an approved campaign card created, on the same terms as
   * `projectId` above: null on `request_changes`, and null when the commit
   * failed after the verdict was recorded.
   */
  campaignId: z.string().uuid().nullable().default(null),
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
  z.object({ ...EmbedBase, component: z.literal('replan'), payload: ReplanEmbedPayload }),
  z.object({ ...EmbedBase, component: z.literal('campaign'), payload: CampaignEmbedPayload }),
]);
export type ActionEmbed = z.infer<typeof ActionEmbed>;

/**
 * The narrowed variants, so a component that renders one kind of card says so in
 * its own signature rather than re-narrowing a union it was handed.
 */
export type PlanActionEmbed = Extract<ActionEmbed, { component: 'plan' }>;
export type QuestionActionEmbed = Extract<ActionEmbed, { component: 'question' }>;
export type ArtifactActionEmbed = Extract<ActionEmbed, { component: 'artifact' }>;
export type ReplanActionEmbed = Extract<ActionEmbed, { component: 'replan' }>;
export type CampaignActionEmbed = Extract<ActionEmbed, { component: 'campaign' }>;

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
   * The thread this message belongs to, or null for the channel-level stream.
   *
   * The column has existed since `20260901121000`, which deliberately left this
   * schema untouched and said the reader "lands with the slice that has
   * something to read". Slice 5 is that slice: a node is admitted to exactly one
   * thread and posts into it, so the owner's stream now interleaves messages
   * from two conversations and a client that could not tell them apart would
   * render a node's work as if it were said to the whole room.
   *
   * **The owner reads both and the node reads one**, which is RLS rather than
   * this field: `private.member_scope_covers` gives a thread-scoped member only
   * messages carrying their own `thread_id`. This is what lets the owner's
   * client mark which is which.
   */
  threadId: z.string().uuid().nullable().default(null),
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
  /**
   * Post into a thread rather than the room stream.
   *
   * **`authorKind` is deliberately still not accepted**, and this field is why
   * it needs saying again. The server derives `author_kind` from the caller's
   * own `room_members` row: a live `human_node` membership scoped to this thread
   * makes it `'node'`, and everything else makes it `'user'`. A client that
   * could name its own kind could file a message as a node's in somebody's audit
   * trail, so the value is read from the database rather than from the request,
   * exactly as `authorId` is. `messages_insert_own` re-checks both independently
   * (`20260904127000`).
   *
   * `channelId` is derived from the thread when this is given, because a thread
   * already knows which channel it lives in and a request naming both could name
   * two different ones.
   */
  threadId: z.string().uuid().optional(),
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

/* --------------------------------------------------------------- workflow */

/**
 * What a plan became once it was approved: a project, its tasks, and what those
 * tasks produced. These mirror the enums in `supabase/migrations/20260813120000_workflow_dag.sql`
 * and `20260813160000_artifacts.sql` rather than restating a subset, because a
 * client that silently drops a state it does not recognise shows a person a
 * shorter project than they have.
 */
export const ProjectStatus = z.enum([
  'draft',
  'planning',
  'active',
  'paused',
  'completed',
  'cancelled',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const TaskOwnerType = z.enum(['ai', 'human', 'user']);
export type TaskOwnerType = z.infer<typeof TaskOwnerType>;

/**
 * The full per-task machine from business-projects-workflow.md, marketplace half
 * included. Those states have no code behind them yet and are listed anyway: the
 * machine is specified in full, and a union that omits them would reject a row
 * the database can legally produce the day the matcher lands.
 */
export const TaskState = z.enum([
  'pending',
  'ready',
  'routing',
  'ai_running',
  'ai_self_check',
  'escalated',
  'needs_user',
  'matching',
  'offered',
  'claimed',
  'escrow_funded',
  'in_progress',
  'proof_submitted',
  'in_review',
  'approved',
  'payout_pending',
  'paid',
  'done',
  'rejected',
  'disputed',
  'failed',
  'cancelled',
  'blocked',
]);
export type TaskState = z.infer<typeof TaskState>;

export const ArtifactKind = z.enum(['draft', 'analysis', 'asset', 'proof', 'answer']);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/**
 * What a task produced. `body` is inline text and `storagePath` is a file; a row
 * always has one of the two, enforced by a check constraint, because an artifact
 * with neither is a task that reported success and produced nothing.
 *
 * `citations` are document titles resolved at write time, not indices, so the
 * checker can catch a source the maker was never given. An empty list is
 * meaningful and is rendered as such: rule 10 says uncited work cannot pass as
 * grounded.
 */
export const Artifact = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  kind: ArtifactKind,
  title: z.string().nullable(),
  body: z.string().nullable(),
  storagePath: z.string().nullable(),
  citations: z.array(z.string()),
  createdBy: AuthorKind,
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof Artifact>;

/**
 * A short-lived capability to download one file artifact.
 *
 * The URL is a **bearer credential**: anyone holding it can fetch the object
 * until it expires, without presenting a token. That is why it is minted per
 * request rather than stored, why the window is minutes rather than days, and
 * why it is never written to a log. `expiresAt` is on the wire so the client can
 * tell "this link is stale" apart from "this file is gone", which are different
 * things to say to a person.
 */
export const ArtifactFileUrl = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type ArtifactFileUrl = z.infer<typeof ArtifactFileUrl>;

/**
 * One step of an approved plan. `ownerType` is what the planner proposed;
 * `state` is where the router and the scheduler actually put it, and the two
 * disagreeing is information rather than a bug (rule 1 of the router outranks
 * `ownerType` for high-risk work).
 */
export const Task = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  detail: z.string().nullable(),
  stage: z.string().nullable(),
  ownerType: TaskOwnerType,
  state: TaskState,
  riskTier: TaskRiskTier,
  position: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What this step delivered. Empty while it has not run or has not passed review. */
  artifacts: z.array(Artifact).default([]),
  /**
   * Who took this step, at what price, when. Null unless a node accepted it and
   * the deal is still live.
   *
   * **This is the counterparty opening, and it is deliberately four fields.**
   * `offers` stays closed to the owner because an offer names every node who was
   * *asked*, including the ones who said no; an engagement names the one who
   * took the work and is being paid from the owner's authorised budget, which
   * the owner is entitled to know. What is here is what answers "who took my
   * step and what will it cost": a display name, the frozen price, the currency
   * and the date.
   *
   * What is **not** here is the node's rate card, their jurisdictions, their
   * availability or their trust score. None of those is a fact about this deal,
   * and `node_profiles` stays closed to the owner accordingly. The projection is
   * the access control (`20260904126000`).
   *
   * `agreedPrice` is frozen at acceptance and never follows the node's current
   * rate, so a panel rendering it is showing what was agreed rather than what
   * the node charges today.
   *
   * **It survives the deal ending, but only when the deal was completed.** The
   * projection reads live engagements and completed ones, because a step that was
   * delivered and paid for should still say who did it — otherwise paying
   * somebody would be what erased their name, right before slice 8 asks the owner
   * to rate them. `cancelled` and `reassigned` deals stay absent, so this line
   * still never names somebody beside a step they are not doing.
   */
  engagement: z
    .object({
      /**
       * The deal's own id, which the rating route is keyed on.
       *
       * Not the task's: a step that was taken, abandoned past its deadline and
       * reassigned has **two** engagements with two different experts at two
       * possibly different prices, and a rating belongs to the deal it is about
       * rather than to the step both happened on.
       */
      engagementId: z.string().uuid(),
      nodeDisplayName: z.string().nullable(),
      agreedPrice: z.number(),
      currency: z.string(),
      acceptedAt: z.string(),
      /**
       * When the escrow was released to this node, or null while the deal is
       * still running.
       *
       * The engagement's own `ended_at`, admitted only for `outcome =
       * 'completed'`, so it cannot report a cancelled deal as a payment. It is
       * **not** read from `payouts`: that would be a second read that could
       * disagree with the row beside it, and the fact the panel needs is "this
       * was settled", which the deal already knows.
       */
      paidAt: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type Task = z.infer<typeof Task>;

/**
 * A project as the list view needs it: enough to say what it is and how far it
 * has got, without shipping every task body to render a row.
 *
 * `waitingOnYou` and `escalated` are counted out separately rather than left
 * inside `states`, because they are the only two numbers that ask the reader to
 * do something, and burying them in a map of twenty-three states is how a
 * summary stops summarising.
 */
export const ProjectSummary = z.object({
  id: z.string().uuid(),
  goal: z.string(),
  status: ProjectStatus,
  createdAt: z.string(),
  taskCount: z.number().int(),
  /** Tasks in a terminal-good state (`approved`, `done`, `paid`). */
  doneCount: z.number().int(),
  waitingOnYou: z.number().int(),
  escalated: z.number().int(),
  artifactCount: z.number().int(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

/**
 * A campaign as the project panel needs it.
 *
 * **The ad tree now exists and is still not here.** The publish sweep writes the
 * root entity (`20260829150000`), so the old reason for its absence, that nothing
 * published, has expired. The new reason is narrower: the tree is one row deep
 * until creative generation lands, so surfacing it would add a field that
 * restates `state` and an external id nobody can act on. `state` already carries
 * `publishing`, `live` and `failed` to the panel with no change at all, which is
 * the whole of what a reader needs today. It gets a shape when there is something
 * under the root worth rendering.
 */
export const CampaignSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  channel: MarketingChannel,
  state: CampaignState,
  /** What the owner authorised. Null is possible only on rows this API did not write. */
  budgetCap: z.number().nullable(),
  currency: z.string(),
  createdAt: z.string(),
  /**
   * What the campaign actually did, summed from `campaign_outcomes`.
   *
   * **Null means nothing has been measured yet, and it is never rendered as
   * zero.** A zero is a claim that a day was measured and found to have none,
   * and confusing that with "we have not read this yet" on a spend figure is the
   * kind of wrong-answer-shaped-like-a-right-one this domain keeps producing. The
   * panel says "No numbers yet" for null.
   *
   * **Summed over `source = 'pull_metrics'` only.** A `manual` correction is a
   * second row for the same window rather than a replacement, so including both
   * sources would count a corrected day twice. The slice that writes the first
   * manual row owns the supersedence rule, which is the same guards-land-with-
   * their-writer ordering the marketing tables already follow.
   *
   * No derived ratios (CPA, CTR, ROAS) and no `revenueToDate`. Counts are
   * counted, and revenue attribution means something different on every channel,
   * so it lands with the first real provider rather than being averaged into
   * existence now.
   */
  spendToDate: z.number().nullable(),
  impressionsToDate: z.number().int().nullable(),
  clicksToDate: z.number().int().nullable(),
  conversionsToDate: z.number().int().nullable(),
  /** `max(period_end)` measured. The panel phrases it as "measured through". */
  lastMeasuredAt: z.string().nullable(),
  /**
   * The owner's cost-per-conversion ceiling, and an input rather than a derived
   * ratio, which is why it may sit beside the ban above: nothing here computes a
   * CPA, this is the figure a person typed for the optimizer to judge against.
   *
   * **Null means "no ceiling set; the optimizer does not judge this campaign",
   * which INVERTS `budgetCap`'s null.** An unset spend authorisation blocks; an
   * unset judgement threshold abstains. Setting it authorises the automatic
   * pause (ADR-0014).
   */
  cpaCeiling: z.number().nullable(),
  /**
   * Why spend stopped, when `state` is `paused`. The panel branches on
   * `cpa_breach` to explain the pause and offer resume, so this is the enum the
   * check constraint enforces rather than free text.
   */
  pauseReason: z.enum(['kill_switch', 'cpa_breach', 'user', 'optimizer']).nullable(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

export const ProjectDetail = z.object({
  id: z.string().uuid(),
  goal: z.string(),
  status: ProjectStatus,
  createdAt: z.string(),
  /** The room the project's plan card was posted in. Null only for legacy rows. */
  roomId: z.string().uuid().nullable(),
  /**
   * What the owner has authorised for the whole venture, and what is already
   * committed against it.
   *
   * **Null means nothing is authorised, never unlimited.** That is the column's
   * documented stance and the one `checkSpendCap` enforces; a panel that read it
   * as "no limit set" would describe an open account.
   *
   * **`committedBudget` sums BOTH committer classes** since slice 5: the caps of
   * every non-terminal campaign, and every escrow hold still `held`
   * ([ADR-0020](../../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)).
   * The headroom a person sees is therefore the same arithmetic both the
   * campaign approval and the offer acceptance perform, rather than a friendlier
   * version of it. A panel counting only campaigns would show headroom that the
   * next acceptance refuses to spend, which is the kind of wrong answer that
   * looks like a bug in the check rather than in the display.
   */
  budgetCeiling: z.number().nullable(),
  currency: z.string(),
  committedBudget: z.number(),
  /**
   * How much of `committedBudget` is escrow rather than campaign budget.
   *
   * Broken out rather than folded away, because the two are committed for
   * different reasons and settle on different clocks: a campaign cap frees up
   * when the campaign ends, and a hold frees up when the step is finished or
   * cancelled. An owner looking at a number they cannot reduce needs to know
   * which half is which. The panel phrases it as "of which held in escrow".
   */
  escrowHeld: z.number(),
  tasks: z.array(Task),
  campaigns: z.array(CampaignSummary).default([]),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

/**
 * Setting the ceiling is an authorisation, so it is owner-only and audited.
 *
 * `null` clears it, which blocks every future campaign approval and deliberately
 * touches no campaign already authorised: withdrawing permission to commit more
 * is not the same act as cancelling what is already committed, and conflating
 * them here would stop spend nobody asked to stop.
 */
export const SetProjectBudgetBody = z.object({
  budgetCeiling: z.number().finite().nonnegative().nullable(),
});
export type SetProjectBudgetBody = z.infer<typeof SetProjectBudgetBody>;

/**
 * Setting a campaign's CPA ceiling is the authorisation for the automatic pause
 * (ADR-0014), so it is owner-only and audited, on the budget body's pattern.
 *
 * **Positive where the budget is non-negative, and the difference is the
 * point.** A budget of 0 is a coherent authorisation ("spend nothing"); a
 * ceiling of 0 would pause on the first recorded cent whatever the conversions
 * say, which is a kill switch wearing the shape of a threshold. The check
 * constraint refuses it too, so the two cannot drift. `null` clears the
 * ceiling, which stops the optimizer judging this campaign and touches nothing
 * else: withdrawing the instruction to judge is not an instruction to resume.
 */
export const SetCampaignCpaCeilingBody = z.object({
  cpaCeiling: z.number().finite().positive().nullable(),
});
export type SetCampaignCpaCeilingBody = z.infer<typeof SetCampaignCpaCeilingBody>;

/* ----------------------------------------------- channel connections */

/** Mirrors `public.channel_connection_status`. */
export const ChannelConnectionStatus = z.enum(['active', 'expired', 'revoked']);
export type ChannelConnectionStatus = z.infer<typeof ChannelConnectionStatus>;

/**
 * A connected account, **as a member is allowed to see it**.
 *
 * This is the projection `20260829121000` promised and deliberately did not
 * build: `channel_connections` holds `access_token` and `refresh_token`, RLS
 * filters rows and not columns, and so the table carries no client policy and no
 * client grant at all. A member's legitimate view, "Meta connected, scopes X,
 * expires Y", could therefore only ever be an API projection.
 *
 * **The absence of the token fields is the security property**, not an
 * abbreviation for the panel's convenience. Because this type is what the route
 * returns, adding a token to the response later is a change somebody has to make
 * on purpose, in this file, where it reads as what it is. Keep it that way: if a
 * future column needs showing, add the column, never the credential.
 */
export const ChannelConnection = z.object({
  id: z.string().uuid(),
  /** The registry key in `packages/marketing`, not a channel. `fake` lives here. */
  provider: z.string(),
  channel: MarketingChannel,
  /** The platform's own account id. Null until a provider reveals one. */
  externalAccountId: z.string().nullable(),
  /** What the platform granted, which is not always what was asked for. */
  grantedScopes: z.array(z.string()),
  status: ChannelConnectionStatus,
  /** Null when the provider issues a token that does not age out. */
  tokenExpiresAt: z.string().nullable(),
  connectedAt: z.string(),
});
export type ChannelConnection = z.infer<typeof ChannelConnection>;

/**
 * Beginning an authorisation. The provider and channel are the only things the
 * caller chooses; everything that makes the round trip safe (the signed state,
 * the redirect URI, the scopes asked for) is decided server-side, because a
 * client that could name its own redirect URI could send the code somewhere else.
 */
export const StartConnectionBody = z.object({
  provider: z.string().min(1),
  channel: MarketingChannel,
});
export type StartConnectionBody = z.infer<typeof StartConnectionBody>;

export const StartConnectionResponse = z.object({
  /** Where to send the browser. Opaque to the client. */
  authorizeUrl: z.string().url(),
});
export type StartConnectionResponse = z.infer<typeof StartConnectionResponse>;

/**
 * Finishing one. `error` carries the platform's own refusal, which for a person
 * clicking Cancel is `access_denied` and arrives with no code at all, so both
 * are optional and the route refuses a body carrying neither.
 */
export const CompleteConnectionBody = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});
export type CompleteConnectionBody = z.infer<typeof CompleteConnectionBody>;

/* ----------------------------------------------- the node's own record */

/** Mirrors `public.kyc_status`. No `expired`: a lapse is availability, not identity. */
export const KycStatus = z.enum(['unverified', 'pending', 'verified', 'rejected', 'suspended']);
export type KycStatus = z.infer<typeof KycStatus>;

/** Mirrors `public.node_availability`. No `busy`: that is the engagement's business. */
export const NodeAvailability = z.enum(['available', 'paused', 'offboarded']);
export type NodeAvailability = z.infer<typeof NodeAvailability>;

/** Mirrors `public.credential_kind`. */
export const CredentialKind = z.enum(['lawyer', 'accountant', 'notary']);
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * A skill a node claims, and whether anybody has confirmed it.
 *
 * `verified` is always false today and is on the wire anyway, because the
 * surface says "claimed, not verified" beside every row and a field that appears
 * later would let that sentence quietly stop being true.
 */
export const NodeSkill = z.object({
  tag: z.string(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
});
export type NodeSkill = z.infer<typeof NodeSkill>;

/**
 * A licence a node claims.
 *
 * `evidencePath` is deliberately **not** here. `node_credentials.verified` is
 * write-once true and requires dated evidence, which requires a bucket that does
 * not exist, so nothing in this slice verifies a licence and nothing uploads a
 * document. The column stays unread rather than half-read.
 */
export const NodeCredential = z.object({
  id: z.string().uuid(),
  kind: CredentialKind,
  jurisdiction: z.string(),
  issuer: z.string().nullable(),
  licenceNumber: z.string().nullable(),
  verified: z.boolean(),
  revokedAt: z.string().nullable(),
});
export type NodeCredential = z.infer<typeof NodeCredential>;

/**
 * Everything a node may see about themselves, **and nothing about anybody else**.
 *
 * Two absences carry the design. There is no verification log: the subject of a
 * `node_verifications` row is refused it by grant rather than shown zero rows
 * (`20260831123000:104-119`), because a face-search result names a third party
 * the node may be a duplicate of. And there is no counterparty: `node_profiles`
 * has no policy for anyone but the subject, and `private.shares_room_with`
 * requires room scope on both sides, so an admitted node currently sees nobody
 * at all. Both are stated in docs/30-modules/human-nodes-marketplace.md and
 * opened by the engagement slice, not by this type.
 *
 * `trustScore` and `completedEngagements` are readable and server-written. They
 * appear on no request body anywhere, which is the point: a node who could set
 * their own trust score is a fraudster with a ranking dial.
 */
export const NodeProfile = z.object({
  userId: z.string().uuid(),
  kycStatus: KycStatus,
  availability: NodeAvailability,
  trustScore: z.number().nullable(),
  completedEngagements: z.number().int(),
  serviceJurisdictions: z.array(z.string()),
  languages: z.array(z.string()),
  rate: z.number().nullable(),
  ratePeriod: z.enum(['hour', 'task']).nullable(),
  currency: z.string(),
  skills: z.array(NodeSkill),
  credentials: z.array(NodeCredential),
});
export type NodeProfile = z.infer<typeof NodeProfile>;

/**
 * What a node may change about themselves.
 *
 * The allow-list **is** the control, and it is expressed as a closed object
 * rather than as a filter in the handler for the reason the connection
 * projection is a named type: a field added here reads as what it is, where a
 * field forgotten in a handler's pick list reads as nothing at all.
 * `kycStatus`, `trustScore`, `completedEngagements` and `suspendedReason` are
 * absent on purpose and `.strict()` refuses a body carrying one rather than
 * ignoring it, so an attempt is a 400 somebody can see rather than a silent
 * no-op that looks like it worked.
 *
 * `rate` and `ratePeriod` move together because the table requires it
 * (`node_profiles_rate_has_period` is `(rate is null) = (rate_period is null)`),
 * and sending one without the other is a 400 rather than a 23514.
 */
export const PatchNodeBody = z
  .object({
    serviceJurisdictions: z.array(z.string().min(1)).min(1).optional(),
    languages: z.array(z.string().min(1)).min(1).optional(),
    rate: z.number().positive().nullable().optional(),
    ratePeriod: z.enum(['hour', 'task']).nullable().optional(),
    currency: z.string().length(3).optional(),
    availability: NodeAvailability.optional(),
  })
  .strict();
export type PatchNodeBody = z.infer<typeof PatchNodeBody>;

/** One claim at a time, so each write is a single statement needing no transaction. */
export const AddNodeSkillBody = z.object({ tag: z.string().min(1) });
export type AddNodeSkillBody = z.infer<typeof AddNodeSkillBody>;

export const AddNodeCredentialBody = z.object({
  kind: CredentialKind,
  jurisdiction: z.string().min(1),
  issuer: z.string().min(1).optional(),
  licenceNumber: z.string().min(1).optional(),
});
export type AddNodeCredentialBody = z.infer<typeof AddNodeCredentialBody>;

/**
 * Submitting an identity check.
 *
 * `sessionRef` is the provider's own reference for the flow the person just
 * completed, the exact counterpart of an OAuth authorization code. The client
 * does not choose an outcome and cannot: for the built-in fake the reference is
 * minted on its own screen, and for a real provider it comes back from theirs.
 */
export const SubmitNodeVerificationBody = z.object({
  provider: z.string().min(1),
  sessionRef: z.string().min(1),
});
export type SubmitNodeVerificationBody = z.infer<typeof SubmitNodeVerificationBody>;

/* ----------------------------------------------- offers, as the node sees them */

/** Mirrors `public.offer_status`. `accepted` is declared and unreachable until escrow. */
export const OfferStatus = z.enum(['open', 'declined', 'expired', 'withdrawn', 'accepted']);
export type OfferStatus = z.infer<typeof OfferStatus>;

/**
 * One offer, projected for the node it was made to.
 *
 * **The projection is the access control, and it is asserted rather than
 * reviewed**, exactly as the channel-connection projection is: the node has no
 * RLS grant on `tasks` or `projects` and gains none here, so the three task
 * fields below are read service-side and copied in. What is absent is the
 * interesting part and each absence is deliberate.
 *
 * **No task id and no project id.** They would be useless to a node who cannot
 * read either table, and handing out an internal key invites the next surface to
 * try.
 *
 * **Nothing identifying the owner.** `20260901122000` narrowed
 * `private.shares_room_with` to require room scope on both sides, closing the
 * owner-sees-node and node-sees-owner halves together, and the engagement slice
 * is where that pair is opened deliberately. A name on an offer card would
 * reopen it here by accident, one slice early.
 *
 * **No rate and no budget**, because nothing has been agreed. `agreed_price` is
 * a fact about a deal, and slice 5's `engagements` is where a deal first exists.
 */
export const NodeOffer = z.object({
  id: z.string().uuid(),
  status: OfferStatus,
  round: z.number().int().nonnegative(),
  expiresAt: z.string(),
  createdAt: z.string(),
  declinedAt: z.string().nullable(),
  declineReason: z.string().nullable(),
  task: z.object({
    title: z.string(),
    stage: z.string().nullable(),
    detail: z.string().nullable(),
  }),
});
export type NodeOffer = z.infer<typeof NodeOffer>;

export const ListNodeOffersResponse = z.object({ offers: z.array(NodeOffer) });
export type ListNodeOffersResponse = z.infer<typeof ListNodeOffersResponse>;

/**
 * Declining an offer.
 *
 * The reason is optional and free text, and it is stored rather than merely
 * counted because "the brief is too vague" and "this is outside what I do" are
 * different problems for the owner: the first is fixable now, the second says
 * the match was wrong. `.strict()` for the `PatchNodeBody` reason, so an attempt
 * to send a status or an id is a 400 rather than a silently ignored field.
 */
export const DeclineOfferBody = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();
export type DeclineOfferBody = z.infer<typeof DeclineOfferBody>;

/* -------------------------------------------- engagements, as the node sees them */

/**
 * **Accepting takes no body at all, and that is now a decision rather than a
 * slice boundary.** This comment replaces one that said an accept body did not
 * exist because escrow did not; escrow exists, and the body is still empty.
 *
 * Everything an acceptance depends on is read from rows the caller cannot name:
 * the price from `node_profiles.rate`, the ceiling from `projects`, the step
 * from the offer. A node accepts the offer as it stands or declines it. There is
 * no counter-offer, no quantity and no negotiated price, because
 * `engagements.agreed_price` is frozen from the profile and a field here would
 * be a caller naming what they are paid.
 *
 * The charge reference is not a field either: the route mints it through the
 * payment provider before calling the rpc, so a client cannot supply one.
 */

/**
 * One accepted deal, projected for the node.
 *
 * **This is the first projection in the marketplace that exposes `roomId` and
 * `threadId`, and the change is deliberate rather than incidental.** `NodeOffer`
 * hides every internal id, because a node who has not accepted has no grant on
 * anything and an id would only invite the next surface to try. After acceptance
 * the two ids ARE the admission: `room_members` carries them, RLS is written
 * against them, and the node's own client needs both to read and post in their
 * thread. Handing them over is what the membership already permits.
 *
 * Still absent: the project, the other steps, the plan, the owner's other work.
 * A node is admitted to one thread and to nothing else.
 */
export const NodeEngagement = z.object({
  id: z.string().uuid(),
  agreedPrice: z.number(),
  currency: z.string(),
  acceptedAt: z.string(),
  endedAt: z.string().nullable(),
  outcome: z.enum(['completed', 'reassigned', 'cancelled', 'disputed_resolved']).nullable(),
  /** The step, as the offer card showed it. Read service-side; the node has no grant on `tasks`. */
  task: z.object({
    title: z.string(),
    stage: z.string().nullable(),
    detail: z.string().nullable(),
    /**
     * Where the work has got to. `tasks.state` is the only state an engagement
     * has ([ADR-0016](../../../docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md)),
     * so this is not a second machine, it is the same one read from the same row.
     */
    state: TaskState,
    /**
     * What this step asks for, from `tasks.acceptance_criteria`.
     *
     * **Disclosed because the node cannot do the work without it**, which is the
     * test every field in this projection has to pass. It is also what the
     * hand-over form is built from: one response field per criterion, checked by
     * `reviewProof` for being non-empty and by nobody for being any good. Empty
     * on a step planned before `20260816120000`, and the form degrades to a note.
     */
    acceptanceCriteria: z.array(z.string()),
  }),
  /** The room and thread the node was admitted to. Null only if the thread was deleted. */
  roomId: z.string().uuid().nullable(),
  threadId: z.string().uuid().nullable(),
});
export type NodeEngagement = z.infer<typeof NodeEngagement>;

export const ListNodeEngagementsResponse = z.object({
  engagements: z.array(NodeEngagement),
});
export type ListNodeEngagementsResponse = z.infer<typeof ListNodeEngagementsResponse>;

/**
 * What accepting returns.
 *
 * The engagement rather than the offer, because the offer is now settled and the
 * thing the node needs next is the room and thread they were just admitted to.
 * A replayed accept returns the same row with the same ids, so a client that
 * retried a request whose response it never saw lands in the same place.
 */
export const AcceptOfferResponse = z.object({ engagement: NodeEngagement });
export type AcceptOfferResponse = z.infer<typeof AcceptOfferResponse>;

/**
 * What a node hands over when they say the work is done.
 *
 * **Arrives as multipart form fields**, because the same request carries the
 * files, and `writeFileArtifact` was written around uploading the object and the
 * row together so a failure leaves neither. The alternative, a JSON submit plus
 * a separate signed upload URL, reintroduces exactly the orphan that writer
 * exists to prevent.
 *
 * `responses` is **positional against `tasks.acceptance_criteria`**, in the order
 * they are stored on the task. The task row is authoritative and the route pairs
 * them: a length that does not match the criteria the node was shown is refused
 * rather than padded, because the plan may have been changed by a diff while the
 * form was open and silently answering a question nobody asked is worse than
 * asking somebody to reload.
 */
export const SubmitProofFields = z.object({
  /** What was done, in the node's own words. The owner reads this first. */
  note: z.string().trim().min(1).max(8000),
  /** One per acceptance criterion, positionally. Empty strings are refused by the checker. */
  responses: z.array(z.string().max(2000)).max(8).default([]),
});
export type SubmitProofFields = z.infer<typeof SubmitProofFields>;

/**
 * A proof the node submitted, projected back to them.
 *
 * **Read with the service key, not through a policy**, and that is the whole
 * design. A thread-scoped member is not a project member (`20260901122000`), so
 * they read zero rows from `artifacts` and zero objects from its bucket. Opening
 * those by engagement was considered and rejected in slice 6: the storage policy
 * resolves the tenant from the **project** in path segment one, so an
 * engagement-scoped version would need a per-object text join or a change to a
 * path convention stated in three places, and opening the row half alone would
 * show a node a row whose file 404s. Opening `artifacts` by engagement would also
 * hand over every artifact on that task, including the AI's drafts and the
 * owner's own write-up, which is a disclosure decision that slice does not need
 * to make.
 *
 * So the projection is the access control, exactly as it is for `NodeOffer` and
 * `NodeEngagement`: the node's own engagement is read **as the caller** through
 * `engagements_select_node`, and only then does the service key read the rows
 * this shape describes. No task id, no project id, no citations.
 */
export const NodeProofArtifact = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  /** The write-up. Null on a row that is a file. */
  body: z.string().nullable(),
  /** True when this row is a file, so the console offers a download rather than text. */
  isFile: z.boolean(),
  createdAt: z.string(),
});
export type NodeProofArtifact = z.infer<typeof NodeProofArtifact>;

export const ListNodeProofResponse = z.object({ proof: z.array(NodeProofArtifact) });
export type ListNodeProofResponse = z.infer<typeof ListNodeProofResponse>;

/**
 * What starting or submitting returns: the engagement, re-read.
 *
 * The engagement rather than a bare `{ ok: true }`, on `AcceptOfferResponse`'s
 * reasoning: `task.state` is the only state an engagement has, it is what the
 * console renders, and it is exactly what just changed. A client that retried a
 * request whose response it never saw reads the same row and lands in the same
 * place.
 */
export const NodeEngagementResponse = z.object({
  engagement: NodeEngagement,
  /**
   * Present only on a submit that the floor check bounced. The node needs to see
   * why they are still at `in_progress` rather than concluding the button failed.
   */
  bounced: z
    .object({
      reasons: z.array(z.string()),
      /** Which criteria were left blank, by index, so the form can point at the field. */
      unaddressed: z.array(z.number().int().nonnegative()),
    })
    .optional(),
});
export type NodeEngagementResponse = z.infer<typeof NodeEngagementResponse>;

/* ------------------------------------------------------------------------- *
 * Disputes and ratings, and the operator's view of a dispute
 *
 * Mirrors `public.disputes`, `public.ratings` and the `/api/ops` reads. The
 * vocabularies here are the SQL check constraints in `20260908122000` and
 * `20260908127000`; if one of those constraints changes, this is the other place
 * to change.
 * ------------------------------------------------------------------------- */

/**
 * The five ways a dispute ends. The four in admin-ops.md plus `rejection_upheld`,
 * which that list predates because it answers a dispute only a node can raise.
 */
export const DisputeResolution = z.enum([
  'released',
  'refunded',
  'partial',
  'reassigned',
  'rejection_upheld',
]);
export type DisputeResolution = z.infer<typeof DisputeResolution>;

/** Which side raised it. Both parties can, from different states. */
export const DisputeRaisedRole = z.enum(['owner', 'node']);
export type DisputeRaisedRole = z.infer<typeof DisputeRaisedRole>;

/**
 * A dispute as either party sees it on their own surface.
 *
 * **`open` is derived, not stored** (`resolved_at is null`), matching the table:
 * ADR-0016 keeps `tasks.state` as the only machine, so a status field here would
 * be a second one that could disagree with it.
 */
export const Dispute = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  engagementId: z.string().uuid(),
  raisedRole: DisputeRaisedRole,
  reason: z.string(),
  /** Where the task was when it was raised. A resolution is unreadable without it. */
  fromState: TaskState,
  resolution: DisputeResolution.nullable(),
  /** The deal's currency, both. Null on the resolutions that move no money. */
  releaseAmount: z.number().nullable(),
  refundAmount: z.number().nullable(),
  resolutionNote: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Dispute = z.infer<typeof Dispute>;

/** What the owner sends to freeze a step, and the node to contest a rejection. */
export const RaiseDisputeBody = z.object({
  reason: z.string().trim().min(1).max(4000),
});
export type RaiseDisputeBody = z.infer<typeof RaiseDisputeBody>;

/**
 * What an operator sends to end one.
 *
 * **Only the release amount is entered**, on a partial and nowhere else. The
 * refund is derived as `hold − release` and shown before the operator confirms:
 * two fields that must sum to a third are two ways to type a number that does
 * not add up.
 */
export const ResolveDisputeBody = z.object({
  resolution: DisputeResolution,
  /** Required. `ops_actions.reason` is not null, so an unexplained decision cannot be recorded. */
  reason: z.string().trim().min(1).max(4000),
  releaseAmount: z.number().positive().optional(),
});
export type ResolveDisputeBody = z.infer<typeof ResolveDisputeBody>;

/**
 * One side's score on a finished deal.
 *
 * `direction` is derived by `public.submit_rating` from the engagement rather
 * than sent, so a caller cannot mislabel a score. It appears here because both
 * consoles render it.
 */
export const Rating = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  direction: z.enum(['owner_of_node', 'node_of_owner']),
  score: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  createdAt: z.string(),
});
export type Rating = z.infer<typeof Rating>;

export const SubmitRatingBody = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});
export type SubmitRatingBody = z.infer<typeof SubmitRatingBody>;

/** A row in the operator's queue. */
export const OpsDisputeSummary = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  taskTitle: z.string(),
  taskState: z.string().nullable(),
  raisedRole: DisputeRaisedRole,
  reason: z.string(),
  fromState: z.string(),
  resolution: DisputeResolution.nullable(),
  releaseAmount: z.number().nullable(),
  refundAmount: z.number().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type OpsDisputeSummary = z.infer<typeof OpsDisputeSummary>;

/**
 * Everything an operator needs to decide one, without leaving the page.
 *
 * **The roster includes ended memberships**, and that is the point rather than
 * an oversight: thread access is stamped with `expires_at` rather than deleted,
 * "so the roster still records that this person was here, which is what a
 * dispute reads" (`20260906124000`). This is the reader that was written for.
 *
 * **`ledger` is the first client-visible read of `ledger_entries` in this
 * system.** That table has RLS with no policy and no client grant at all; these
 * rows reach the browser only through `/api/ops`, as `service_role`, behind the
 * `profiles.role` check in `require-ops.ts`.
 */
export const OpsDisputeDetail = z.object({
  dispute: Dispute.extend({
    projectId: z.string().uuid(),
    raisedBy: z.string().uuid(),
    raisedByName: z.string().nullable(),
    evidence: z.string().nullable(),
  }),
  task: z
    .object({
      id: z.string().uuid(),
      title: z.string(),
      state: z.string(),
      stage: z.string().nullable(),
    })
    .nullable(),
  engagement: z
    .object({
      id: z.string().uuid(),
      nodeId: z.string().uuid(),
      nodeName: z.string().nullable(),
      agreedPrice: z.number(),
      currency: z.string(),
      acceptedAt: z.string(),
      deadlineAt: z.string().nullable(),
      endedAt: z.string().nullable(),
      outcome: z.string().nullable(),
    })
    .nullable(),
  /** Every hold on the step, including the one a partial settlement minted. */
  holds: z.array(
    z.object({
      id: z.string().uuid(),
      amount: z.number(),
      currency: z.string(),
      state: z.string(),
      createdAt: z.string(),
    }),
  ),
  payouts: z.array(
    z.object({
      id: z.string().uuid(),
      state: z.string(),
      amount: z.number(),
      currency: z.string(),
      transferId: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  ledger: z.array(
    z.object({
      account: z.string(),
      debit: z.number(),
      credit: z.number(),
      currency: z.string(),
      refId: z.string().uuid(),
      createdAt: z.string(),
    }),
  ),
  roster: z.array(
    z.object({
      userId: z.string().uuid(),
      name: z.string().nullable(),
      role: z.string(),
      scope: z.string(),
      /** Non-null means this person's access was ended. Shown, never filtered. */
      expiresAt: z.string().nullable(),
    }),
  ),
});
export type OpsDisputeDetail = z.infer<typeof OpsDisputeDetail>;

/** The role echo the `/ops` page gates on. */
export const OpsIdentity = z.object({
  userId: z.string().uuid(),
  role: z.enum(['ops', 'admin']),
});
export type OpsIdentity = z.infer<typeof OpsIdentity>;

/**
 * **Neither the `/api/node` routes nor the `/api/ops` routes appear in the
 * ts-rest router below, and that is deliberate rather than an omission.** The
 * router is partial: it covers the
 * surfaces the browser client is generated from, and the node console calls its
 * three endpoints through the same BFF with the schemas above as the shared
 * shape. Adding them means deciding what the generated client should do about a
 * group whose entire authorisation model is "the caller is always the subject",
 * which is a decision worth taking on its own rather than as a side effect of
 * shipping acceptance. Every route still validates against these schemas in
 * `apps/api`, so there is one source of truth either way.
 *
 * The ops routes are out for a second reason on top of that one. Their
 * authorisation is `profiles.role`, read from the database rather than carried
 * by the token, and a generated client implies a caller who can hold that role
 * — which every browser client can not. Leaving them as schemas keeps the type
 * shared and the reachability an API-layer question, which is where
 * `require-ops.ts` answers it.
 */

const ProjectParams = z.object({ projectId: z.string().uuid() });

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

    listProjects: {
      method: 'GET',
      path: '/rooms/:roomId/projects',
      pathParams: RoomParams,
      responses: {
        200: z.object({ projects: z.array(ProjectSummary) }),
        401: ApiError,
        404: ApiError,
      },
      summary: 'Projects approved in a room, newest first, with progress counts',
    },

    getProject: {
      method: 'GET',
      path: '/projects/:projectId',
      pathParams: ProjectParams,
      responses: {
        200: ProjectDetail,
        401: ApiError,
        404: ApiError,
      },
      summary: 'One project with its tasks and everything they produced',
    },

    setProjectBudget: {
      method: 'PATCH',
      path: '/projects/:projectId',
      pathParams: ProjectParams,
      body: SetProjectBudgetBody,
      responses: {
        200: ProjectDetail,
        400: ApiError,
        401: ApiError,
        /** Only the owner authorises spend; a member is told so rather than shown nothing. */
        403: ApiError,
        404: ApiError,
      },
      summary: "Set or clear the project's authorised budget ceiling (owner only)",
    },

    setCampaignCpaCeiling: {
      method: 'PATCH',
      path: '/projects/:projectId/campaigns/:campaignId',
      pathParams: z.object({
        projectId: z.string().uuid(),
        campaignId: z.string().uuid(),
      }),
      body: SetCampaignCpaCeilingBody,
      responses: {
        200: ProjectDetail,
        400: ApiError,
        401: ApiError,
        /** Setting a ceiling authorises the pause, so it is owner-only like the budget. */
        403: ApiError,
        404: ApiError,
      },
      summary: "Set or clear a campaign's cost-per-conversion ceiling (owner only, ADR-0014)",
    },

    resumeCampaign: {
      method: 'POST',
      path: '/projects/:projectId/campaigns/:campaignId/resume',
      pathParams: z.object({
        projectId: z.string().uuid(),
        campaignId: z.string().uuid(),
      }),
      // The path names the whole act. ts-rest requires a body on a mutation, so
      // this one is declared empty rather than invented.
      body: z.object({}).optional(),
      responses: {
        200: ProjectDetail,
        401: ApiError,
        403: ApiError,
        404: ApiError,
        /**
         * Not paused, never published, or the platform refused in a way only the
         * owner can fix (reconnect, or the campaign is gone there). The body's
         * message says which.
         */
        409: ApiError,
        /** The platform did not accept the call yet; trying again shortly is the fix. */
        503: ApiError,
      },
      summary: 'Resume a paused campaign (owner only; a still-breached ceiling re-pauses it)',
    },

    getArtifactFileUrl: {
      method: 'GET',
      path: '/projects/:projectId/artifacts/:artifactId/file-url',
      pathParams: z.object({
        projectId: z.string().uuid(),
        artifactId: z.string().uuid(),
      }),
      responses: {
        200: ArtifactFileUrl,
        401: ApiError,
        /**
         * Invisible, absent, and "this artifact is text rather than a file" are
         * all 404, matching how a non-member gets 404 on a room: the API does
         * not confirm the existence of something it will not show you.
         */
        404: ApiError,
      },
      summary: 'A short-lived signed URL for one file artifact',
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
