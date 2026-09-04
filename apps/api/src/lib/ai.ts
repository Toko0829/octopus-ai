import { z } from 'zod';
import { IntakeQuestion, IntakeSlot, TaskRiskTier } from '@octopus/contracts';
import { toWire, type GenerationTarget } from './model-routing';

/**
 * Client for the Python AI service (ADR-0006).
 *
 * The service **proposes**; this side executes. Everything it returns is treated
 * as untrusted data: the response is parsed against a schema before use, and a
 * proposal is a request for an action, never the action itself. A compromised or
 * simply wrong reasoning core can therefore produce a bad suggestion, but it
 * cannot write a row, spend money, or post as someone else.
 *
 * The shapes below mirror `services/ai/src/octopus_ai/schemas.py`. They will be
 * generated from that service's OpenAPI document once generation is wired
 * (ADR-0004); until then this is the one hand-maintained seam, kept deliberately
 * small for that reason.
 *
 * **Nothing in this file logs a request body, and that is now load-bearing.**
 * Since ADR-0032 a body can carry `generation.api_key`, a customer's live
 * provider credential, decrypted for the length of one call. There is no logger
 * in this module at all, which is the cheapest way to keep it true: adding one
 * that takes a body is how a key reaches a log aggregator. Errors here name a
 * status, a timeout or a schema failure, never what was sent.
 */

export const PostMessageProposal = z.object({
  kind: z.literal('post_message'),
  body: z.string().min(1).max(4000),
});
export type PostMessageProposal = z.infer<typeof PostMessageProposal>;

const PlanStep = z.object({
  /**
   * Snake_case like the two below, mirroring the Python schema, and renamed where
   * the payload is built. Both are optional because a core that predates
   * dependencies must keep working, and because most steps depend on nothing.
   */
  id: z.string().max(32).optional(),
  depends_on: z.array(z.string().max(32)).max(8).optional().default([]),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(600),
  owner: z.enum(['AI', 'HUMAN', 'YOU']),
  citations: z.array(z.number().int().positive()),
  /**
   * Snake_case because this mirrors the Python schema, and renamed to `riskTier`
   * where the payload is built. Defaulted rather than required for the same
   * reason the core defaults it: a core that omits the field must not take down a
   * card, and the clamp on the other side has already had its say.
   */
  risk_tier: TaskRiskTier.optional().default('reversible'),
  acceptance_criteria: z.array(z.string()).max(3).optional().default([]),
});

const PlanStage = z.object({
  stage: z.enum(['strategy', 'content', 'creative', 'channels', 'conversion', 'measurement']),
  steps: z.array(PlanStep).max(3),
});

/**
 * A structured full-funnel plan. Parsed here with the same rigour as any other
 * untrusted input: the core may propose a plan, but the bounds on it are this
 * side's to enforce, not the prompt's to honour.
 */
export const ProposePlanProposal = z.object({
  kind: z.literal('propose_plan'),
  title: z.string().min(1).max(140),
  summary: z.string().min(1).max(800),
  stages: z.array(PlanStage).min(1).max(6),
});
export type ProposePlanProposal = z.infer<typeof ProposePlanProposal>;

/**
 * What a task produced. Citations are source LABELS rather than indices, unlike
 * `PlanStep`: the checker's job includes catching a source the maker was never
 * given, and an index is checkable for range but not for provenance.
 */
export const WriteArtifactProposal = z.object({
  kind: z.literal('write_artifact'),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(8000),
  citations: z.array(z.string()),
});
export type WriteArtifactProposal = z.infer<typeof WriteArtifactProposal>;

/**
 * Discriminated so an unknown `kind` fails the parse loudly rather than being
 * silently dropped. The core widening its own powers by inventing a proposal
 * kind should break the run, not quietly do nothing.
 */
/**
 * One change a replan proposes. Snake_case throughout, mirroring the Python
 * schema, and renamed where the card payload is built.
 */
const ReplanAddStepProposal = z.object({
  op: z.literal('add_step'),
  stage: z.enum(['strategy', 'content', 'creative', 'channels', 'conversion', 'measurement']),
  id: z.string().max(32),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(600),
  owner: z.enum(['AI', 'HUMAN', 'YOU']),
  citations: z.array(z.number().int().positive()).default([]),
  risk_tier: TaskRiskTier.optional().default('reversible'),
  acceptance_criteria: z.array(z.string()).max(3).optional().default([]),
  depends_on: z.array(z.string().max(64)).max(8).optional().default([]),
});

const ReplanCancelTaskProposal = z.object({
  op: z.literal('cancel_task'),
  task_id: z.string().uuid(),
  reason: z.string().min(1).max(400),
});

const ReplanModifyTaskProposal = z.object({
  op: z.literal('modify_task'),
  task_id: z.string().uuid(),
  detail: z.string().min(1).max(600).optional(),
  acceptance_criteria: z.array(z.string()).max(3).optional(),
  add_depends_on: z.array(z.string().max(64)).max(8).optional().default([]),
});

/**
 * A diff against a running project.
 *
 * `ops` is capped here as well as in the core, on this side's own rule: the core
 * may propose, and the bounds on what it proposes are this side's to enforce
 * rather than the prompt's to honour. Ten is the number a person will actually
 * read, and a card nobody reads is not an authorisation.
 */
export const ProposeReplanProposal = z.object({
  kind: z.literal('propose_replan'),
  project_id: z.string().uuid(),
  summary: z.string().min(1).max(800),
  ops: z
    .array(
      z.discriminatedUnion('op', [
        ReplanAddStepProposal,
        ReplanCancelTaskProposal,
        ReplanModifyTaskProposal,
      ]),
    )
    .min(1)
    .max(10),
});
export type ProposeReplanProposal = z.infer<typeof ProposeReplanProposal>;

/**
 * A campaign the core proposes for the owner's authorisation.
 *
 * **There is no budget field, and its absence is the design.** The core says what
 * to run and where; how much to spend is the owner's to type onto the card. A
 * number a model produced and a number a person authorised are indistinguishable
 * once they are both `budget_cap` on a row, and this is the one surface where
 * that difference is the entire point. Adding the field "for convenience" later
 * would remove the property silently, so it is stated here rather than left to be
 * inferred from the fact that nothing sets it.
 *
 * `citations` are 1-based indices into the response's own `citations`, matching
 * `ProposePlanProposal` rather than `WriteArtifactProposal`'s labels: this card
 * renders the sources beside the claim, so an index the reader can follow is what
 * it needs.
 */
export const ProposeCampaignProposal = z.object({
  kind: z.literal('propose_campaign'),
  task_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  objective: z.string().max(500).optional(),
  channel: z.enum(['meta', 'google', 'email', 'organic_social']),
  summary: z.string().min(1).max(800),
  citations: z.array(z.number().int().positive()).max(8).default([]),
});
export type ProposeCampaignProposal = z.infer<typeof ProposeCampaignProposal>;

/**
 * Draw this, `count` times, at this ratio.
 *
 * **The first proposal whose execution produces bytes**, and the only one that
 * reaches a vendor a second time inside one step. The core says what to draw and
 * never draws it: `services/ai` holds no storage key and no Supabase write path,
 * so the bytes are minted in `image-gen.ts` on the workspace's own Google key and
 * land in the private artifacts bucket (ADR-0033).
 *
 * `prompt` is untrusted (rule 8) and bounded on both sides of the seam. It is a
 * data field in a JSON body and reaches no URL and no header.
 *
 * **`count` is capped at three here as well as in the schema that produced it.**
 * Each image is a separate billed call on somebody else's account, authorised by
 * one approval of one step, so the ceiling is re-checked on the side that spends
 * rather than trusted from the side that asks (rule 6).
 */
export const GenerateImageProposal = z.object({
  kind: z.literal('generate_image'),
  prompt: z.string().min(1).max(1000),
  count: z.number().int().min(1).max(3).default(1),
  aspect: z.enum(['1:1', '4:5', '9:16', '16:9']).default('1:1'),
});
export type GenerateImageProposal = z.infer<typeof GenerateImageProposal>;

export const Proposal = z.discriminatedUnion('kind', [
  PostMessageProposal,
  ProposePlanProposal,
  WriteArtifactProposal,
  ProposeReplanProposal,
  ProposeCampaignProposal,
  GenerateImageProposal,
]);
export type Proposal = z.infer<typeof Proposal>;

export const Citation = z.object({
  source_id: z.string(),
  label: z.string(),
  url: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
});
export type Citation = z.infer<typeof Citation>;

export const PlanResponse = z.object({
  proposals: z.array(Proposal),
  grounded: z.boolean(),
  citations: z.array(Citation),
  reasoning_summary: z.string(),
  core: z.string(),
  /**
   * Which provider and model actually answered (ADR-0032 decision 4).
   *
   * **Optional and nullable so an older AI service still parses**, which is the
   * only kind of tolerance this file grants: a service deployed before the
   * connector slice returns neither field, and refusing its perfectly good plan
   * over a missing attribution would make a rolling deploy an outage.
   *
   * That tolerance is bounded by `assertAttributed` below. It is safe when we
   * asked for nothing in particular; it is a contract break when we sent a
   * target, because a service that ignored the target and answered on the house
   * key would look exactly like this.
   */
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

/**
 * What each request carries about which model should answer it.
 *
 * Optional on every input, and absent means **Auto**: the service uses its own
 * key, which is what every call did before connectors existed and what most rooms
 * will keep doing. The resolution is `resolveGeneration`'s; this is only the
 * carriage.
 */
interface GenerationInput {
  generation?: GenerationTarget | null;
}

/**
 * The request body's generation fields, or nothing at all.
 *
 * **Spread into a body rather than written as `generation: x ?? null`**, so a
 * call with no target sends a body byte-identical to the one it sent before this
 * existed. That is not tidiness: it is what makes "the house path is unchanged"
 * a claim a diff can settle rather than an assurance.
 */
function generationFields(target: GenerationTarget | null | undefined): Record<string, unknown> {
  return target ? { generation: toWire(target) } : {};
}

/**
 * A service that was handed a target and generated something must say what.
 *
 * **The one place tolerance stops.** `provider` and `model` are optional on the
 * schema so an older service parses, and that same optionality would let an older
 * service silently answer every routed call on the house OpenAI key: the plan
 * would be good, the room would show no model, and the workspace would be paying
 * for a connector it was not using. Asked and unanswered is a contract break;
 * never asked is not.
 *
 * **`grounded` is the discriminator, and getting that wrong turns a correct
 * refusal into a failed run.** A refusal calls no provider at all, so it reports
 * no model, and that null is the truth rather than a stale deployment; found by
 * driving the stack rather than by any test here. Every generated answer on both
 * sides of the seam is `grounded: true`, so demanding attribution of those alone
 * has no false positives and still catches an old service the first time it
 * answers anything at all on a routed room.
 *
 * The labelled ungrounded tier is `grounded: false` and does carry attribution,
 * so it is not checked. That costs nothing: an old service cannot route that tier
 * either, and the grounded path on the same deployment catches it first.
 */
function assertAttributed(response: PlanResponse, target: GenerationTarget | null | undefined) {
  if (target && response.grounded && !response.model) {
    throw new AiServiceError(
      'AI service was given a model target and produced a grounded answer without naming a ' +
        'model, so it is older than the connector contract and would be running on the house key.',
      'contract',
    );
  }
}

export interface PlanInput extends GenerationInput {
  roomId: string;
  goal: string;
  /**
   * What intake established: audience, offer, budget, timeline.
   *
   * Sent alongside the goal rather than folded into it, and that is measured
   * rather than stylistic. Folding them in broke retrieval: "Get signups for
   * travelers." returned nothing at all, because a niche audience word dominates
   * a short query at a cross-encoder and appears nowhere in a corpus of marketing
   * principles. The same word survived a longer phrasing and was then refused by
   * the groundedness gate, which read the person's own particulars as a topic the
   * sources were obliged to cover. The goal searches; this tailors.
   */
  context?: IntakeSlot[];
  agentRunId: string;
  projectId?: string | null;
  /**
   * The target for the labelled ungrounded answer, when the gate refuses.
   *
   * Its own field because it is its own role: a workspace can route the Fallback
   * answers somewhere other than the Strategist, and `/plan` is the one endpoint
   * that may take either path within a single request. The service falls back to
   * `generation` when this is absent, and to the house default when both are.
   * Every rule 10 constraint is unchanged by it (ADR-0021): still `post_message`
   * only, still `grounded=False`, still refused in code on a regulated topic
   * before any provider is called.
   */
  generationFallback?: GenerationTarget | null;
}

/**
 * Why a call to the reasoning core failed, as a value rather than as prose.
 *
 * The distinction reaches a person, which is the whole reason it is typed.
 * `architecture.md` requires that "a timeout is reported as a timeout", because
 * telling someone the service did not respond when it did, slowly, sends the next
 * person to debug it in exactly the wrong direction. That was written as settled
 * and the code did not do it: every failure here was flattened into one sentence
 * at the point it was posted, so the distinction existed in the logs and was lost
 * in the room.
 *
 * `timeout` is also the only one of these that is not a fault. The service is
 * healthy and the work genuinely takes longer than this environment allows, which
 * has a remedy the others do not: give it more time or more cores.
 */
export type AiFailureKind = 'timeout' | 'unreachable' | 'status' | 'contract';

export class AiServiceError extends Error {
  constructor(
    message: string,
    readonly kind: AiFailureKind = 'unreachable',
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

/**
 * Ask the reasoning core for proposals.
 *
 * Times out rather than hanging: this runs inside an agent step, and a step that
 * never returns is a run that never completes.
 *
 * The budget covers a full grounded turn on the slowest supported configuration:
 * embed, hybrid search, cross-encoder rerank, then generation. With a local
 * embedder (ADR-0008) the embed step runs on CPU rather than as an API call, so
 * 30s was tight enough that a normal turn could trip it and surface as "the
 * reasoning service did not respond" while the service was in fact healthy.
 * The service warms its model at startup, so this covers steady-state work, not
 * a cold load.
 *
 * Reranking now runs in-process on a CPU cross-encoder (ADR-0009), so this
 * budget scales with the cores given to the AI service: roughly 71s per goal on
 * 12 threads and 230s on one. 90s therefore fits a well-provisioned instance and
 * not a small one, which is why AI_REQUEST_TIMEOUT_MS exists.
 *
 * **Raised from 90s when connectors landed** (ADR-0032), and the paragraph that
 * used to be here argued the opposite, so it is worth saying why it changed
 * rather than quietly deleting it. It read: the default is deliberately not
 * raised to cover the slowest case, because a long default only delays reporting
 * a hung service. That was written when every generation went to the house
 * OpenAI key, which answers in seconds and does no thinking.
 *
 * A connected reasoning model breaks the premise. Claude Sonnet 5 spends
 * thousands of tokens thinking before it emits the first character of a plan,
 * and `services/ai` now allows 240s for a single provider call. A Node budget
 * under that hangs up on Python mid-answer, which surfaces as "the reasoning
 * service did not respond" while it is working correctly, and is exactly the
 * failure the 30s-to-90s paragraph above was written about.
 *
 * So the ordering is the rule: this must stay comfortably above
 * `request_timeout_s` in the AI service, because the outer budget should only
 * ever fire when the inner one has already failed to. 300s is retrieval on a
 * modest instance plus one slow generation, with margin.
 *
 * The cost is accepted rather than dismissed: a genuinely hung service now takes
 * five minutes to report instead of ninety seconds. Agent runs are asynchronous
 * (202 + runId), so that is a longer wait on a rare fault, against every
 * connector plan failing on a common one.
 */
export const DEFAULT_PLAN_TIMEOUT_MS = 300_000;

export async function requestPlan(
  baseUrl: string,
  input: PlanInput,
  timeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
): Promise<PlanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        room_id: input.roomId,
        goal: input.goal,
        context: input.context ?? [],
        trace: {
          agent_run_id: input.agentRunId,
          project_id: input.projectId ?? null,
          room_id: input.roomId,
        },
        ...generationFields(input.generation),
        ...(input.generationFallback
          ? { generation_fallback: toWire(input.generationFallback) }
          : {}),
      }),
    });

    if (!res.ok) {
      throw new AiServiceError(`AI service returned ${res.status}`, 'status');
    }

    const parsed = PlanResponse.safeParse(await res.json());
    if (!parsed.success) {
      // A shape we do not recognise is a contract break, not something to
      // muddle through with.
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    // Checked against the grounded target only. A plan that took the ungrounded
    // path answered on `generation_fallback`, and the service names whichever one
    // actually ran, so demanding attribution here would be demanding it of a call
    // this side did not necessarily route.
    assertAttributed(parsed.data, input.generation);
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface ReplanTaskInput {
  taskId: string;
  title: string;
  detail: string;
  stage: string | null;
  state: string;
  owner: 'AI' | 'HUMAN' | 'YOU';
  dependsOn: string[];
}

export interface ReplanInput extends GenerationInput {
  projectId: string;
  roomId: string;
  goal: string;
  reason: string;
  tasks: ReplanTaskInput[];
  context?: IntakeSlot[];
  agentRunId: string;
}

/**
 * Ask the core for a diff against a running project.
 *
 * **The DAG travels in the request rather than being read by the core.** The task
 * graph is Node's (ADR-0006), and the core reaches Postgres for retrieval only.
 * Sending it also means the diff is answered against exactly the state this
 * process saw, which is what makes the staleness check in `apply_plan_diff`
 * meaningful rather than a race with a second reader.
 *
 * Shares the plan timeout, because it does the same expensive things: one
 * retrieval, one groundedness check, one long generation.
 */
export async function requestReplan(
  baseUrl: string,
  input: ReplanInput,
  timeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
): Promise<PlanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/replan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        project_id: input.projectId,
        goal: input.goal,
        reason: input.reason,
        // Renamed rather than spread, for the reason the plan mapping records:
        // a field with a default that silently arrives absent is the failure
        // mode that leaves everything looking merely empty.
        tasks: input.tasks.map((task) => ({
          task_id: task.taskId,
          title: task.title,
          detail: task.detail,
          stage: task.stage,
          state: task.state,
          owner: task.owner,
          depends_on: task.dependsOn,
        })),
        context: input.context ?? [],
        trace: {
          agent_run_id: input.agentRunId,
          project_id: input.projectId,
          room_id: input.roomId,
        },
        ...generationFields(input.generation),
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = PlanResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    assertAttributed(parsed.data, input.generation);
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The intake verdict. Scores rather than a decision this side must take on
 * trust: `completeness` and `proximity` are counted in the AI service from a
 * required-slot set and the stages the corpus covers, so a caller can see WHY it
 * was told to ask again.
 */
export const IntakeResponse = z.object({
  slots: z.array(IntakeSlot),
  focus_stages: z.array(z.string()),
  completeness: z.number().min(0).max(1),
  proximity: z.number().min(0).max(1),
  ready: z.boolean(),
  /**
   * `not_a_request` and `out_of_domain` are separate because the reply differs. A
   * greeting has nothing to decline and only needs a question; a request from
   * another field has to be declined before anything is asked, or the question is
   * a way of keeping someone talking rather than an honest redirect.
   */
  outcome: z.enum(['ready', 'needs_detail', 'not_a_request', 'out_of_domain']),
  questions: z.array(IntakeQuestion).max(4),
  refined_goal: z.string(),
  reasoning_summary: z.string(),
  core: z.string(),
});
export type IntakeResponse = z.infer<typeof IntakeResponse>;

export interface IntakeInput {
  roomId: string;
  goal: string;
  answers: string[];
  slots: IntakeSlot[];
  round: number;
  agentRunId: string;
  projectId?: string | null;
}

/**
 * Intake gets its own, much shorter budget, and that is the point rather than an
 * oversight.
 *
 * `requestPlan`'s 90s covers embedding, hybrid search and a CPU cross-encoder.
 * Intake does none of that: it is one cheap-tier model call and no retrieval at
 * all, by design, because what someone sells is not in the corpus. Giving it the
 * planning budget would mean a hung service holds a person for a minute and a
 * half before asking them a question, which is the worst possible place to spend
 * that patience.
 */
export const DEFAULT_INTAKE_TIMEOUT_MS = 20_000;

// Embedding scales with how much somebody pasted rather than with a model's
// thinking, and this runs after the route has already replied, so a generous
// ceiling costs nobody any waiting.
const DEFAULT_SOURCE_TIMEOUT_MS = 120_000;

export async function requestIntake(
  baseUrl: string,
  input: IntakeInput,
  timeoutMs = DEFAULT_INTAKE_TIMEOUT_MS,
): Promise<IntakeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        room_id: input.roomId,
        goal: input.goal,
        answers: input.answers,
        slots: input.slots,
        round: input.round,
        trace: { agent_run_id: input.agentRunId, project_id: input.projectId ?? null },
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = IntakeResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What Node can draw with, told to the core so it knows whether to ask.
 *
 * **`GenerationTarget` with the credential removed, and the removal is the
 * point.** The core never generates an image, so it never needs a key to do it
 * with: it decides whether a creative step should ask for one, and this side
 * makes the call with the key it already holds. A key on this object would be a
 * live credential travelling to a process that has no use for it.
 */
export interface CreativeCapability {
  provider: string;
  model: string;
  images: boolean;
}

export interface ExecuteInput extends GenerationInput {
  /** Absent means the workspace has routed no Creative model, which is Auto's answer too. */
  creative?: CreativeCapability | null;
  taskId: string;
  title: string;
  detail: string;
  stage: string | null;
  agentRunId: string;
  projectId: string;
  roomId?: string | null;
  context?: IntakeSlot[];
}

/**
 * Ask the reasoning core to draft the deliverable for one approved task.
 *
 * Shares `requestPlan`'s budget and its reasoning: executing a step runs the same
 * retrieve, rerank and generate path, so it costs about the same and scales with
 * the same cores.
 */
export async function requestExecution(
  baseUrl: string,
  input: ExecuteInput,
  timeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
): Promise<PlanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        task_id: input.taskId,
        title: input.title,
        detail: input.detail,
        stage: input.stage,
        // What intake established. May make the deliverable concrete, may never
        // be cited, and is deliberately absent from the retrieval query.
        context: input.context ?? [],
        trace: {
          agent_run_id: input.agentRunId,
          project_id: input.projectId,
          // The retrieval scope, so a step is written from this workspace's own
          // business documents as well as the shared corpus.
          room_id: input.roomId ?? null,
        },
        ...generationFields(input.generation),
        // Spread rather than sent as null, for `generationFields`'s reason: a
        // workspace with no Creative route sends the body it sent before images
        // existed, so "the path without a connector is unchanged" stays a claim
        // a diff can settle rather than an assurance.
        ...(input.creative ? { creative: input.creative } : {}),
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = PlanResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    assertAttributed(parsed.data, input.generation);
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the reasoning core to draft a campaign for one step that is waiting on the
 * owner's authorisation.
 *
 * Shaped like `requestExecution` rather than `requestReplan` because the input is
 * one task: the core retrieves narrowly for that step, room-scoped, exactly as
 * `/execute` does. The difference is what comes back. `/execute` produces a
 * deliverable the critic reviews; this produces a proposal only a person can
 * accept, so the core is expected to decline rather than guess when the step is
 * not a campaign or the sources do not support a channel.
 */
export async function requestCampaignDraft(
  baseUrl: string,
  input: ExecuteInput,
  timeoutMs = DEFAULT_PLAN_TIMEOUT_MS,
): Promise<PlanResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/campaign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        task_id: input.taskId,
        title: input.title,
        detail: input.detail,
        stage: input.stage,
        context: input.context ?? [],
        trace: {
          agent_run_id: input.agentRunId,
          project_id: input.projectId,
          room_id: input.roomId ?? null,
        },
        ...generationFields(input.generation),
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = PlanResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    assertAttributed(parsed.data, input.generation);
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

const SourceResponse = z.object({
  document_id: z.string(),
  chunks_written: z.number().int(),
  skipped_unchanged: z.boolean(),
  superseded: z.boolean(),
});
export type SourceResponse = z.infer<typeof SourceResponse>;

export interface SourceInput {
  roomId: string;
  title: string;
  text: string;
  sourceUrl?: string | null;
  agentRunId: string;
}

/**
 * Hand the reasoning core a document about the user's own business.
 *
 * A longer budget than planning, and for a different reason: this is embedding
 * work whose cost scales with the length of what somebody pasted, not with a
 * model's thinking. It is also called from a background continuation after the
 * route has already replied 202, so nobody is watching a spinner while it runs.
 */
export async function requestSource(
  baseUrl: string,
  input: SourceInput,
  timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
): Promise<SourceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        room_id: input.roomId,
        title: input.title,
        text: input.text,
        source_url: input.sourceUrl ?? null,
        trace: {
          agent_run_id: input.agentRunId,
          project_id: null,
          room_id: input.roomId,
        },
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = SourceResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface IngestInput {
  title: string;
  text: string;
  sourceLabel: string;
  sourceUrl: string;
  authority: 'official' | 'vendor' | 'research' | 'internal';
  market?: string | null;
  businessType?: string | null;
  docType?: string | null;
  /** ISO date. The day the page was read, which is the only date we can vouch for. */
  effectiveDate?: string | null;
  lang?: string;
  agentRunId: string;
}

/**
 * Hand the reasoning core a crawled page for the shared corpus.
 *
 * Deliberately a separate call from `requestSource` rather than a flag on it.
 * That one is room-scoped and its metadata is fixed by the endpoint, because
 * everything arriving there is somebody describing their own business. This one
 * carries provenance the registry stated, and a body whose meaning depended on
 * which optional fields happened to be set would be the worse of the two designs.
 *
 * Same budget as a room source and for the same reason: the cost is embedding
 * work proportional to page length, and it runs inside the ticker's pass where
 * nobody is watching a spinner.
 */
export async function requestIngest(
  baseUrl: string,
  input: IngestInput,
  timeoutMs = DEFAULT_SOURCE_TIMEOUT_MS,
): Promise<SourceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        title: input.title,
        text: input.text,
        source_label: input.sourceLabel,
        source_url: input.sourceUrl,
        authority: input.authority,
        market: input.market ?? null,
        business_type: input.businessType ?? null,
        doc_type: input.docType ?? null,
        effective_date: input.effectiveDate ?? null,
        lang: input.lang ?? 'english',
        trace: {
          agent_run_id: input.agentRunId,
          project_id: null,
          // Shared corpus: no room owns a regulator's guidance, and sending one
          // here would scope the document to whichever workspace happened to be
          // in the log line.
          room_id: null,
        },
      }),
    });

    if (!res.ok) throw new AiServiceError(`AI service returned ${res.status}`, 'status');

    const parsed = SourceResponse.safeParse(await res.json());
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response did not match the contract: ${parsed.error}`,
        'contract',
      );
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`, 'timeout');
    }
    throw new AiServiceError(
      err instanceof Error ? err.message : 'AI service unreachable',
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------- the house default */

/**
 * What "Auto" currently means, read from the AI service rather than restated.
 *
 * The alternative was a second copy of the house model id in Node's environment.
 * Two copies of one fact eventually disagree, and this one disagrees invisibly:
 * the settings block would name a model, the runs would use another, and nothing
 * would be wrong enough to notice. So the service that actually holds the key
 * answers the question, on the `/health` document it already publishes.
 *
 * Neither value is a secret. A model id and a provider name are what every
 * message chip in the room already shows; the key they belong to is not
 * reported and never will be.
 */
export interface HouseDefault {
  provider: string;
  model: string;
}

const HouseDefaultShape = z.object({
  generation_provider: z.string().nullable().optional(),
  generation_model: z.string().nullable().optional(),
});

/**
 * A short cache, because this is read on every settings load and changes only
 * when the AI service is redeployed.
 *
 * Sixty seconds is chosen against the failure it prevents rather than for
 * throughput: a settings page open in three tabs should not make three calls,
 * and a deploy that changes the house model should be visible without a restart.
 * In-process and per-instance, which is the honest scope; there is nothing here
 * worth a shared cache.
 *
 * **A failure is cached too, as null.** Without that, an AI service that is down
 * turns every settings load into a ten-second wait for the same answer. The
 * surface says it does not currently know rather than guessing a name, which is
 * the same posture the refusal copy takes everywhere else.
 */
const HOUSE_DEFAULT_TTL_MS = 60_000;
let houseDefaultCache: { at: number; value: HouseDefault | null } | null = null;

/** Exported for tests, which must not inherit a cached answer from each other. */
export function resetHouseDefaultCache(): void {
  houseDefaultCache = null;
}

export async function requestHouseDefault(
  baseUrl: string,
  now: number = Date.now(),
  timeoutMs = 5_000,
): Promise<HouseDefault | null> {
  if (houseDefaultCache && now - houseDefaultCache.at < HOUSE_DEFAULT_TTL_MS) {
    return houseDefaultCache.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let value: HouseDefault | null = null;
  try {
    const res = await fetch(new URL('/health', baseUrl).toString(), {
      method: 'GET',
      signal: controller.signal,
    });
    if (res.ok) {
      const parsed = HouseDefaultShape.safeParse(await res.json());
      if (parsed.success && parsed.data.generation_provider && parsed.data.generation_model) {
        value = {
          provider: parsed.data.generation_provider,
          model: parsed.data.generation_model,
        };
      }
    }
  } catch {
    // Deliberately swallowed and cached as null. The settings block is not a
    // health check: an AI service that is down must not make connecting a key
    // impossible, and "we do not currently know what Auto means" is a true and
    // survivable answer.
  } finally {
    clearTimeout(timer);
  }

  houseDefaultCache = { at: now, value };
  return value;
}
