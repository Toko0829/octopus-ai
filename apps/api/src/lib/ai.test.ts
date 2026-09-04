/**
 * The AI-service seam, tested for the two things ADR-0032 added to it: what a
 * request body carries when a workspace has routed a role, and what it means
 * when a service answers a routed call without saying which model ran.
 *
 * **The house path is byte-identical to what it was**, and that is asserted
 * rather than assured. `generation` is spread in only when there is one, so a
 * room with no connectors sends the body it sent before any of this existed. A
 * `generation: null` key would have been the easy way to write it and would have
 * made "nothing changed for everybody else" a claim nobody could check.
 *
 * **The contract check is the security-shaped half.** `provider` and `model` are
 * optional on the response schema so an older service still parses during a
 * rolling deploy. That same optionality would let an older service answer every
 * routed call on the house OpenAI key, silently: the plan would be good, the room
 * would show no model, and the workspace would be paying us for a connector it
 * was not using. So asked-and-unanswered is a contract break, and never-asked is
 * not.
 *
 * There was no test file for this module before this one. Everything here drives
 * a stubbed `fetch` rather than a service.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiServiceError,
  requestCampaignDraft,
  requestExecution,
  requestPlan,
  requestReplan,
} from './ai';
import type { GenerationTarget } from './model-routing';

const BASE = 'http://ai:8000';
const KEY = 'sk-ant-live-not-a-real-key-4f2a';

const TARGET: GenerationTarget = {
  vendor: 'anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  apiKey: KEY,
  baseUrl: null,
};

let bodies: Record<string, unknown>[];
let reply: Record<string, unknown>;

/** A minimal grounded answer, so the schema parse is never what fails a test. */
function answer(extra: Record<string, unknown> = {}) {
  return {
    proposals: [],
    grounded: true,
    citations: [],
    reasoning_summary: '',
    core: 'grounded-plan-v1',
    ...extra,
  };
}

beforeEach(() => {
  bodies = [];
  reply = answer({ provider: 'anthropic', model: 'claude-sonnet-5' });
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => reply } as unknown as Response;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const planInput = { roomId: 'r1', goal: 'Grow the newsletter', agentRunId: 'run1' };
const executeInput = {
  taskId: 't1',
  title: 'Write the brief',
  detail: '',
  stage: 'positioning',
  agentRunId: 'run1',
  projectId: 'p1',
};
const replanInput = {
  projectId: 'p1',
  roomId: 'r1',
  goal: 'Grow the newsletter',
  reason: 'Budget moved',
  tasks: [],
  agentRunId: 'run1',
};

describe('the body carries a target only when there is one', () => {
  it('omits generation entirely on the house path', async () => {
    reply = answer();
    await requestPlan(BASE, planInput);
    expect(bodies[0]).not.toHaveProperty('generation');
    expect(bodies[0]).not.toHaveProperty('generation_fallback');
  });

  it('sends the wire shape, with the key under api_key', async () => {
    await requestPlan(BASE, { ...planInput, generation: TARGET });
    expect(bodies[0]?.generation).toEqual({
      vendor: 'anthropic',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      api_key: KEY,
    });
  });

  it('sends the fallback target as its own field, because it is its own role', async () => {
    await requestPlan(BASE, {
      ...planInput,
      generation: TARGET,
      generationFallback: {
        ...TARGET,
        provider: 'google',
        vendor: 'google',
        model: 'gemini-3.8-flash',
      },
    });
    expect(bodies[0]?.generation).toMatchObject({ provider: 'anthropic' });
    expect(bodies[0]?.generation_fallback).toMatchObject({ provider: 'google' });
  });

  it('carries a fallback target with no grounded target, which is a routed Auto', async () => {
    reply = answer();
    await requestPlan(BASE, {
      ...planInput,
      generationFallback: { ...TARGET, provider: 'google', vendor: 'google' },
    });
    expect(bodies[0]).not.toHaveProperty('generation');
    expect(bodies[0]?.generation_fallback).toMatchObject({ provider: 'google' });
  });

  it('threads the target through execute, campaign and replan', async () => {
    await requestExecution(BASE, { ...executeInput, generation: TARGET });
    await requestCampaignDraft(BASE, { ...executeInput, generation: TARGET });
    await requestReplan(BASE, { ...replanInput, generation: TARGET });
    for (const body of bodies) {
      expect(body.generation).toMatchObject({ model: 'claude-sonnet-5' });
    }
  });

  it('sends no fallback field anywhere but plan: only /plan has two exits', async () => {
    await requestExecution(BASE, { ...executeInput, generation: TARGET });
    await requestReplan(BASE, { ...replanInput, generation: TARGET });
    for (const body of bodies) expect(body).not.toHaveProperty('generation_fallback');
  });
});

describe('what came back', () => {
  it('returns the provider and model the service reported', async () => {
    const plan = await requestPlan(BASE, { ...planInput, generation: TARGET });
    expect(plan.provider).toBe('anthropic');
    expect(plan.model).toBe('claude-sonnet-5');
  });

  it('keeps whatever the service says, not what was asked for', async () => {
    // The service is the authority on which model ran, and the two can differ:
    // `/plan` may take the ungrounded exit and answer on the Fallback route.
    reply = answer({ provider: 'google', model: 'gemini-3.8-flash' });
    const plan = await requestPlan(BASE, { ...planInput, generation: TARGET });
    expect(plan.model).toBe('gemini-3.8-flash');
  });

  it('accepts an unattributed answer when nothing was asked for', async () => {
    reply = answer();
    const plan = await requestPlan(BASE, planInput);
    expect(plan.model).toBeUndefined();
    expect(plan.core).toBe('grounded-plan-v1');
  });

  it('accepts an explicit null model on the house path', async () => {
    // What the service returns for a refusal that generated nothing at all.
    reply = answer({ provider: null, model: null });
    await expect(requestPlan(BASE, planInput)).resolves.toMatchObject({ model: null });
  });

  it('rejects an unattributed grounded answer to a routed call as a contract break', async () => {
    reply = answer();
    await expect(requestPlan(BASE, { ...planInput, generation: TARGET })).rejects.toMatchObject({
      name: 'AiServiceError',
      kind: 'contract',
    });
  });

  it('rejects it on execute, campaign and replan too', async () => {
    reply = answer();
    for (const call of [
      () => requestExecution(BASE, { ...executeInput, generation: TARGET }),
      () => requestCampaignDraft(BASE, { ...executeInput, generation: TARGET }),
      () => requestReplan(BASE, { ...replanInput, generation: TARGET }),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(AiServiceError);
    }
  });

  it('accepts an unattributed refusal, because a refusal called no model at all', async () => {
    // Found by driving the stack. A refusal is `grounded: false` and reports no
    // model because none ran, and failing the run over that would turn "I cannot
    // ground this" into "the agent could not complete this run" on every routed
    // room.
    reply = answer({ grounded: false });
    await expect(
      requestExecution(BASE, { ...executeInput, generation: TARGET }),
    ).resolves.toMatchObject({ grounded: false });
  });

  it('does not demand attribution for a fallback-only route', async () => {
    // Only the grounded target is checked. A plan that took the ungrounded exit
    // was answered on a target this side did not necessarily set, so demanding
    // attribution here would demand it of a call we did not route.
    reply = answer();
    await expect(
      requestPlan(BASE, { ...planInput, generationFallback: TARGET }),
    ).resolves.toBeTruthy();
  });

  it('says nothing about the key when it complains', async () => {
    reply = answer();
    const err = await requestPlan(BASE, { ...planInput, generation: TARGET }).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).not.toContain(KEY);
  });
});
