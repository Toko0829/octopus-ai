import { z } from 'zod';

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

export const Citation = z.object({
  source_id: z.string(),
  label: z.string(),
  url: z.string().nullable().optional(),
  effective_date: z.string().nullable().optional(),
});

export const PlanResponse = z.object({
  proposals: z.array(PostMessageProposal),
  grounded: z.boolean(),
  citations: z.array(Citation),
  reasoning_summary: z.string(),
  core: z.string(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export interface PlanInput {
  roomId: string;
  goal: string;
  agentRunId: string;
  projectId?: string | null;
}

export class AiServiceError extends Error {}

/**
 * Ask the reasoning core for proposals.
 *
 * Times out rather than hanging: this runs inside an agent step, and a step that
 * never returns is a run that never completes.
 */
export async function requestPlan(
  baseUrl: string,
  input: PlanInput,
  timeoutMs = 30_000,
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
        trace: {
          agent_run_id: input.agentRunId,
          project_id: input.projectId ?? null,
        },
      }),
    });

    if (!res.ok) {
      throw new AiServiceError(`AI service returned ${res.status}`);
    }

    const parsed = PlanResponse.safeParse(await res.json());
    if (!parsed.success) {
      // A shape we do not recognise is a contract break, not something to
      // muddle through with.
      throw new AiServiceError(`AI service response did not match the contract: ${parsed.error}`);
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof AiServiceError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiServiceError(`AI service timed out after ${timeoutMs}ms`);
    }
    throw new AiServiceError(err instanceof Error ? err.message : 'AI service unreachable');
  } finally {
    clearTimeout(timer);
  }
}
