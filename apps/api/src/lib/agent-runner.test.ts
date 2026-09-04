/**
 * What a message that names one of the four voices does.
 *
 * `agent-runner.ts` had no test file before this. That is worth stating rather
 * than quietly fixing: it is the only path by which anything the reasoning core
 * says becomes visible, and the coverage it had came from route tests that mock
 * it out entirely. These cases cover the mention branch, which is what this
 * change added; the plan and intake paths are still exercised only by the live
 * run and by `routes/embeds.test.ts` at one remove.
 *
 * **The property under test is that a mention buys nothing.** It produces a
 * card, in the voice that was addressed, through the same `produceDiff` an
 * owner's own request from the project panel takes. So the assertions are as
 * much about what does not happen: no intake call, no dismissed cards, no second
 * plan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOM = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';

interface Write {
  table: string;
  op: 'insert' | 'update';
  values: Record<string, unknown>;
}

let written: Write[];
let liveProject: { id: string; goal: string; status: string } | null;
let diffCalls: Record<string, unknown>[];
let diffOpts: Record<string, unknown>[];
let intakeCalls: number;
/** What the fake `/plan` answers with. Reassigned per test. */
let planReply: Record<string, unknown>;
/** Every `/plan` request body the runner built, so the target can be seen. */
let planInputs: Record<string, unknown>[];
/** Rows the fake client hands back for the two model tables. */
let routeRow: Record<string, unknown> | null;
let connectionRow: Record<string, unknown> | null;

vi.mock('./ai', () => ({
  AiServiceError: class AiServiceError extends Error {
    kind = 'unreachable';
  },
  requestIntake: async () => {
    intakeCalls += 1;
    return {
      outcome: 'ready',
      refined_goal: 'a refined goal',
      slots: [],
      questions: [],
      ready: true,
      completeness: 1,
      proximity: 1,
    };
  },
  requestPlan: async (_url: string, input: Record<string, unknown>) => {
    planInputs.push(input);
    return planReply;
  },
}));

vi.mock('./replan-diff', () => ({
  produceDiff: async (
    _admin: unknown,
    opts: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => {
    diffOpts.push(opts);
    diffCalls.push(input);
  },
}));

vi.mock('./room-for-project', () => ({
  liveProjectForRoom: async () => liveProject,
}));

vi.mock('./room-profile', () => ({
  readProfile: async () => null,
  profileFieldsFromSlots: () => ({}),
  writeProfileFields: async () => undefined,
}));

/** A PostgREST-shaped fake that records writes and answers reads with the room. */
function client() {
  const b: Record<string, unknown> = {};
  let table = '';
  Object.assign(b, {
    from(t: string) {
      table = t;
      return b;
    },
    select: () => b,
    eq: () => b,
    in: () => b,
    order: () => b,
    limit: () => b,
    maybeSingle: async () => {
      if (table === 'rooms') return { data: { owner_id: OWNER }, error: null };
      if (table === 'model_routes') return { data: routeRow, error: null };
      if (table === 'model_connections') return { data: connectionRow, error: null };
      return { data: null, error: null };
    },
    single: async () => ({ data: { id: 'row-1' }, error: null }),
    insert: (values: Record<string, unknown>) => {
      written.push({ table, op: 'insert', values });
      return b;
    },
    update: (values: Record<string, unknown>) => {
      written.push({ table, op: 'update', values });
      return b;
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
  });
  return b;
}

vi.mock('./supabase', () => ({
  createServiceClient: () => client(),
}));

const { createAgentRunner } = await import('./agent-runner');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function runner(modelKeySecret: string | null = null) {
  return createAgentRunner({
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    aiServiceUrl: 'http://ai',
    modelKeySecret,
    log: log as never,
  });
}

const messages = () => written.filter((w) => w.table === 'messages');
const ack = () => messages().find((m) => String(m.values.idempotency_key).endsWith(':ack'));

beforeEach(() => {
  written = [];
  diffCalls = [];
  diffOpts = [];
  intakeCalls = 0;
  planInputs = [];
  routeRow = null;
  connectionRow = null;
  planReply = {
    proposals: [{ kind: 'post_message', body: 'Here is what I would do.' }],
    citations: [],
    reasoning_summary: 's',
    provider: 'openai',
    model: 'gpt-5.4',
  };
  liveProject = { id: PROJECT, goal: 'Grow the newsletter', status: 'active' };
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
});

describe('a mention from the owner, on a project that is running', () => {
  it('answers in the voice that was addressed and proposes a diff', async () => {
    await runner().startRun(ROOM, '@Ads move the budget to Meta', 'run-1', OWNER);

    expect(ack()?.values).toMatchObject({
      author_kind: 'agent',
      persona: 'ads',
      idempotency_key: 'agent-run:run-1:ack',
    });
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0]).toMatchObject({ projectId: PROJECT, persona: 'ads' });
    expect(String(diffCalls[0]?.reason)).toContain('The owner asked Ads');
    expect(String(diffCalls[0]?.reason)).toContain('move the budget to Meta');
  });

  it('spends no intake call and posts no plan', async () => {
    // The whole point of the branch. A mention is about the plan that exists,
    // so classifying it as a goal would spend a call to learn nothing and could
    // produce a second plan competing with the running one.
    await runner().startRun(ROOM, '@Ads move the budget to Meta', 'run-1', OWNER);

    expect(intakeCalls).toBe(0);
    expect(messages()).toHaveLength(1);
  });

  it('leaves the open intake cards alone', async () => {
    // A new goal closes the cards that were sharpening the previous one. A
    // mention is not a new goal, so closing them would throw away questions the
    // owner is still part-way through.
    await runner().startRun(ROOM, '@Ads move the budget to Meta', 'run-1', OWNER);

    expect(written.filter((w) => w.table === 'action_embeds')).toEqual([]);
  });

  it('routes @Strategist the same way rather than replanning from scratch', async () => {
    // A fresh intake on a running project would produce a competing plan, which
    // is the regeneration replan-by-diff exists to prevent.
    await runner().startRun(ROOM, '@Strategist add an SEO stage', 'run-1', OWNER);

    expect(diffCalls[0]).toMatchObject({ persona: 'strategist' });
    expect(intakeCalls).toBe(0);
  });
});

describe('a mention with no project running', () => {
  beforeEach(() => {
    liveProject = null;
  });

  it('says the specialist joins once there is a plan, then plans', async () => {
    await runner().startRun(ROOM, '@Ads write me some ads', 'run-1', OWNER);

    expect(ack()?.values).toMatchObject({ persona: 'ads' });
    expect(String(ack()?.values.body)).toContain('joins once a plan is running');
    expect(diffCalls).toHaveLength(0);
    expect(intakeCalls).toBe(1);
  });

  it('plans on the message without its mention token', async () => {
    // The planner should not be asked to plan around "@Ads".
    await runner().startRun(ROOM, '@Ads write me some ads', 'run-1', OWNER);

    const started = messages().find((m) => String(m.values.idempotency_key).endsWith(':started'));
    expect(String(started?.values.body)).toContain('write me some ads');
    expect(String(started?.values.body)).not.toContain('@Ads');
  });

  it('says nothing extra when the Strategist is the one mentioned', async () => {
    // It would be telling itself it joins once a plan is running.
    await runner().startRun(ROOM, '@Strategist help me start', 'run-1', OWNER);

    expect(ack()).toBeUndefined();
    expect(intakeCalls).toBe(1);
  });
});

describe('a mention from somebody who is not the owner', () => {
  it('is an ordinary goal, and touches no card', async () => {
    // The cards are about the owner's own business, so a member's sentence is
    // not an authorisation to change their plan.
    await runner().startRun(ROOM, '@Ads move the budget', 'run-1', MEMBER);

    expect(ack()).toBeUndefined();
    expect(diffCalls).toHaveLength(0);
    expect(intakeCalls).toBe(1);
  });
});

describe('a message with no mention', () => {
  it('behaves exactly as it did before', async () => {
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    expect(ack()).toBeUndefined();
    expect(diffCalls).toHaveLength(0);
    expect(intakeCalls).toBe(1);
  });

  it('is not fooled by an email address in the text', async () => {
    await runner().startRun(ROOM, 'email someone@ads.com about this', 'run-1', OWNER);

    expect(ack()).toBeUndefined();
    expect(diffCalls).toHaveLength(0);
  });
});

describe('what a mention says', () => {
  it('writes no em dash', async () => {
    // AGENTS.md rule 22, over both sentences this branch can produce.
    await runner().startRun(ROOM, '@Ads do the thing', 'run-1', OWNER);
    liveProject = null;
    await runner().startRun(ROOM, '@Analyst do the thing', 'run-2', OWNER);

    for (const m of messages()) expect(String(m.values.body ?? '')).not.toContain('—');
  });
});

/**
 * Which model wrote what (ADR-0032 decision 4).
 *
 * The rule the table cannot enforce is enforced here: **only text a model wrote
 * gets a model.** `messages_model_agent_only` refuses a model on a person's or a
 * system's row, which is the forgery half; it cannot tell our own prose from a
 * model's, and every notice this file posts is an `agent` row it could
 * legitimately stamp. So the assertions below are mostly about the notices.
 */
describe('attribution on what a run posts', () => {
  const stamped = () =>
    messages().filter((m) => m.values.model !== null && m.values.model !== undefined);

  it('stamps a proposal the core wrote with the model that answered', async () => {
    planReply.model = 'claude-sonnet-5';
    planReply.provider = 'anthropic';
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    const proposal = messages().find((m) => String(m.values.idempotency_key).endsWith(':0'));
    expect(proposal?.values.model).toBe('claude-sonnet-5');
  });

  it('leaves the started notice unstamped, because those words are ours', async () => {
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    const started = messages().find((m) => String(m.values.idempotency_key).endsWith(':started'));
    expect(started?.values.body).toBeTruthy();
    expect(started?.values.model).toBeNull();
  });

  it('leaves a failure notice unstamped, in the platform voice', async () => {
    planReply = Promise.reject(new Error('boom')) as never;
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    const failed = messages().find((m) => String(m.values.idempotency_key).endsWith(':failed'));
    expect(failed?.values.author_kind).toBe('system');
    expect(failed?.values.model).toBeNull();
  });

  it('stamps nothing at all when a mention is acknowledged', async () => {
    // The ack is one templated sentence and the card is the diff producer's to
    // post. Neither is this run's to attribute.
    await runner().startRun(ROOM, '@Ads move the budget to Meta', 'run-1', OWNER);
    expect(stamped()).toHaveLength(0);
  });

  it('records the house model when the room has routed nothing', async () => {
    // `gpt-5.4` is reported by the service, not read from our own configuration.
    // It is still a fact about what wrote the message, so it is still recorded.
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);
    const proposal = messages().find((m) => String(m.values.idempotency_key).endsWith(':0'));
    expect(proposal?.values.model).toBe('gpt-5.4');
  });
});

describe('the target a run resolves', () => {
  const HEX = 'a'.repeat(64);
  const KEY = 'sk-ant-live-not-a-real-key-4f2a';

  async function connectAnthropic(role: string) {
    const { modelConnectionAad, parseMasterKey, seal } = await import('./envelope');
    const sealed = seal(KEY, parseMasterKey(HEX), modelConnectionAad(ROOM, 'anthropic', 1));
    routeRow = { role, provider: 'anthropic', model: 'claude-opus-5' };
    connectionRow = {
      key_ciphertext: sealed.ciphertext,
      key_iv: sealed.iv,
      key_tag: sealed.tag,
      key_version: 1,
    };
  }

  it('sends no generation when nothing is routed', async () => {
    await runner().startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);
    expect(planInputs[0]?.generation).toBeNull();
    expect(planInputs[0]?.generationFallback).toBeNull();
  });

  it('sends the strategist route and the fallback route together', async () => {
    // One request, two roles, because `/plan` has two exits: a grounded turn is
    // the Strategist's and a refused one is the Fallback's, and which runs is
    // decided inside the service by the gate.
    await connectAnthropic('strategist');
    await runner(HEX).startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    expect(planInputs[0]?.generation).toMatchObject({ model: 'claude-opus-5', apiKey: KEY });
    expect(planInputs[0]?.generationFallback).toMatchObject({ model: 'claude-opus-5' });
  });

  it('never writes the key to a log line', async () => {
    await connectAnthropic('strategist');
    await runner(HEX).startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    const logged = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    expect(logged).toContain('claude-opus-5');
    expect(logged).not.toContain(KEY);
  });

  it('fails the run with the variable named when a route has no master key', async () => {
    routeRow = { role: 'strategist', provider: 'anthropic', model: 'claude-opus-5' };
    await runner(null).startRun(ROOM, 'grow my newsletter to 1000 subscribers', 'run-1', OWNER);

    const failed = messages().find((m) => String(m.values.idempotency_key).endsWith(':failed'));
    expect(String(failed?.values.body)).toContain('MODEL_KEY_SECRET');
    // Loudly, and having written nothing: a run that quietly used the house key
    // would bill us for a provider the owner chose and stamp a model they did not.
    expect(planInputs).toHaveLength(0);
  });

  it('hands the master key on to the diff producer a mention reaches', async () => {
    await runner(HEX).startRun(ROOM, '@Ads move the budget to Meta', 'run-1', OWNER);
    expect(diffOpts[0]).toMatchObject({ modelKeySecret: HEX });
  });
});
