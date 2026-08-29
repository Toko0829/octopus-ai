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
   * `committedBudget` sums the caps of every non-terminal campaign, so the
   * headroom a person sees is the same arithmetic the approval performs rather
   * than a friendlier version of it.
   */
  budgetCeiling: z.number().nullable(),
  currency: z.string(),
  committedBudget: z.number(),
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
