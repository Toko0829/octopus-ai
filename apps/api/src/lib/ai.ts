import { z } from 'zod';
import { IntakeQuestion, IntakeSlot, TaskRiskTier } from '@octopus/contracts';

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
export const Proposal = z.discriminatedUnion('kind', [
  PostMessageProposal,
  ProposePlanProposal,
  WriteArtifactProposal,
]);
export type Proposal = z.infer<typeof Proposal>;

export const Citation = z.object({
  source_id: z.string(),
  label: z.string(),
  url: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
});

export const PlanResponse = z.object({
  proposals: z.array(Proposal),
  grounded: z.boolean(),
  citations: z.array(Citation),
  reasoning_summary: z.string(),
  core: z.string(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export interface PlanInput {
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
 * The default is deliberately NOT raised to cover the slowest case. Agent runs
 * are asynchronous (202 + runId), so a longer plan is a longer wait rather than
 * a failure, whereas a default long enough for a single vCPU would mean a
 * genuinely hung service takes four minutes to report instead of ninety seconds.
 * Size the instance, or raise this per environment.
 */
export const DEFAULT_PLAN_TIMEOUT_MS = 90_000;

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

export interface ExecuteInput {
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
