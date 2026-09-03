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
let intakeCalls: number;

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
  requestPlan: async () => ({
    proposals: [{ kind: 'post_message', body: 'Here is what I would do.' }],
    citations: [],
    reasoning_summary: 's',
  }),
}));

vi.mock('./replan-diff', () => ({
  produceDiff: async (_admin: unknown, _opts: unknown, input: Record<string, unknown>) => {
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
    maybeSingle: async () => ({
      data: table === 'rooms' ? { owner_id: OWNER } : null,
      error: null,
    }),
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

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function runner() {
  return createAgentRunner({
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    aiServiceUrl: 'http://ai',
    log,
  });
}

const messages = () => written.filter((w) => w.table === 'messages');
const ack = () => messages().find((m) => String(m.values.idempotency_key).endsWith(':ack'));

beforeEach(() => {
  written = [];
  diffCalls = [];
  intakeCalls = 0;
  liveProject = { id: PROJECT, goal: 'Grow the newsletter', status: 'active' };
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
