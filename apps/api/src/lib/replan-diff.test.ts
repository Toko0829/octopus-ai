/**
 * Who signs a plan-change card, and who signs it when nothing came back.
 *
 * `produceDiff` had no test file at all before this change, which is worth
 * saying rather than quietly fixing: it is reached from three callers (the
 * owner's replan route, a question card finished after its plan was approved,
 * and now a mention) and it is the only path that posts a card proposing to
 * rewrite a running project. These cases cover the voice, because that is what
 * this change added; the diff mapping itself is still exercised only by the
 * live run and by `apply_plan_diff`'s pgTAP suite.
 *
 * **The failure notice matters as much as the card.** A mention that produced
 * nothing must still answer in the voice it was addressed in: a request sent to
 * Ads that comes back unsigned, or signed by somebody else, reads as the request
 * having been lost rather than attempted.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';

interface Write {
  table: string;
  values: Record<string, unknown>;
}

let written: Write[];
let replanResponse: { proposals: unknown[]; citations: unknown[]; model?: string | null };
let replanThrows: Error | null;
/** Every `/replan` request the producer built, so the resolved role can be seen. */
let replanInputs: Record<string, unknown>[];
/** Rows the fake client hands back for the two model tables. */
let routeRow: Record<string, unknown> | null;
let connectionRow: Record<string, unknown> | null;

vi.mock('./ai', () => ({
  requestReplan: async (_url: string, input: Record<string, unknown>) => {
    replanInputs.push(input);
    if (replanThrows) throw replanThrows;
    return replanResponse;
  },
}));

const { produceDiff } = await import('./replan-diff');

/**
 * A PostgREST-shaped fake in the `executor.test.ts` style: it records every
 * write with the values that reached it, and answers reads from fixed rows.
 */
function admin() {
  const tasks = [
    {
      id: TASK,
      title: 'Draft the launch email',
      detail: 'Three sends',
      stage: 'content',
      state: 'pending',
      owner_type: 'ai',
    },
  ];

  const builder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        if (table === 'model_routes') return { data: routeRow, error: null };
        if (table === 'model_connections') return { data: connectionRow, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        const values = (b.__values ?? {}) as Record<string, unknown>;
        return { data: { id: 'msg-1', ...values }, error: null };
      },
      insert: (values: Record<string, unknown>) => {
        written.push({ table, values });
        b.__values = values;
        return b;
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'tasks' ? tasks : [], error: null }),
    });
    return b;
  };

  return { from: (table: string) => builder(table) } as never;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const opts = { aiServiceUrl: 'http://ai', log: log as never };
const input = {
  projectId: PROJECT,
  roomId: ROOM,
  goal: 'Grow the newsletter',
  reason: 'The owner wants more email',
  runId: 'run-1',
};

const aReplan = {
  kind: 'propose_replan',
  project_id: PROJECT,
  summary: 'Two more sends in the sequence.',
  ops: [
    {
      op: 'add_step',
      stage: 'content',
      id: 'send-4',
      title: 'Write send four',
      detail: 'After the offer',
      owner: 'AI',
      citations: [],
      risk_tier: 'reversible',
      acceptance_criteria: [],
      depends_on: [],
    },
  ],
};

beforeEach(() => {
  written = [];
  replanThrows = null;
  replanInputs = [];
  routeRow = null;
  connectionRow = null;
  replanResponse = { proposals: [aReplan], citations: [], model: 'gpt-5.4' };
});

const messages = () => written.filter((w) => w.table === 'messages');

describe('the card the diff arrives on', () => {
  it('is signed by the Strategist when nobody named a specialist', async () => {
    await produceDiff(admin(), opts, input);

    expect(messages()[0]?.values).toMatchObject({
      author_kind: 'agent',
      persona: 'strategist',
      idempotency_key: 'replan:run-1',
    });
    expect(written.some((w) => w.table === 'action_embeds')).toBe(true);
  });

  it('is signed by the specialist the request was addressed to', async () => {
    await produceDiff(admin(), opts, { ...input, persona: 'ads' });

    expect(messages()[0]?.values).toMatchObject({
      author_kind: 'agent',
      persona: 'ads',
      idempotency_key: 'replan:run-1',
    });
  });

  it('still requires an approval, whoever signed it', async () => {
    // The point of ADR-0031: a name on a card buys no authority. The embed is
    // owner-gated and pending exactly as a plan card is, and `apply_plan_diff`
    // is still the only thing that changes the project.
    await produceDiff(admin(), opts, { ...input, persona: 'ads' });

    expect(written.find((w) => w.table === 'action_embeds')?.values).toMatchObject({
      component: 'replan',
      required_role: 'owner',
      state: 'pending',
    });
  });
});

describe('when the reasoning core cannot answer', () => {
  it('says so in the voice that was asked', async () => {
    replanThrows = new Error('unreachable');

    await produceDiff(admin(), opts, { ...input, persona: 'ads' });

    const notice = messages()[0]?.values;
    expect(notice).toMatchObject({ persona: 'ads', idempotency_key: 'replan-notice:run-1' });
    expect(String(notice?.body)).toContain('could not work out a change');
  });

  it('never throws, so a caller that already answered the owner is not unwound', async () => {
    replanThrows = new Error('unreachable');
    await expect(produceDiff(admin(), opts, input)).resolves.toBeUndefined();
  });

  it('writes no em dash in anything it says', async () => {
    // AGENTS.md rule 22, over every sentence this file can produce.
    replanThrows = new Error('unreachable');
    await produceDiff(admin(), opts, input);
    for (const m of messages()) expect(String(m.values.body)).not.toContain('—');
  });
});

/**
 * The voice and the route are one choice (ADR-0032).
 *
 * `@Ads move the budget to Meta` comes back signed by Ads **and written on the
 * model this workspace routed to Ads**. Splitting the two would make the
 * signature decorative: a card that reads as one specialist while being composed
 * by another specialist's model is telling the reader something untrue about the
 * only thing the signature claims.
 */
describe('which model answers a diff', () => {
  const HEX = 'a'.repeat(64);
  const KEY = 'sk-ant-live-not-a-real-key-4f2a';

  async function route(role: string) {
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

  it('resolves the strategist route when nobody named a specialist', async () => {
    await route('strategist');
    await produceDiff(admin(), { ...opts, modelKeySecret: HEX }, input);
    expect(replanInputs[0]?.generation).toMatchObject({ model: 'claude-opus-5' });
  });

  it('resolves the addressed specialist route on a mention', async () => {
    // The fake answers whatever route row the test set, so what this pins is the
    // role the producer asked for: the persona is the role, by construction.
    await route('ads');
    await produceDiff(admin(), { ...opts, modelKeySecret: HEX }, { ...input, persona: 'ads' });
    const roles = log.info.mock.calls.map((c) => (c[0] as { role?: string }).role).filter(Boolean);
    expect(roles).toContain('ads');
  });

  it('stamps the card with the model that answered', async () => {
    replanResponse.model = 'claude-opus-5';
    await produceDiff(admin(), opts, { ...input, persona: 'ads' });
    expect(messages()[0]?.values).toMatchObject({ persona: 'ads', model: 'claude-opus-5' });
  });

  it("stamps the core's own message when it sends one instead of a diff", async () => {
    replanResponse = {
      proposals: [{ kind: 'post_message', body: 'Nothing to change here.' }],
      citations: [],
      model: 'claude-opus-5',
    };
    await produceDiff(admin(), opts, input);
    expect(messages()[0]?.values).toMatchObject({ model: 'claude-opus-5' });
  });

  it('leaves our own failure sentence unstamped', async () => {
    // The one function posts both, so this is the assertion that keeps the
    // distinction: no model wrote "I could not work out a change".
    replanThrows = new Error('unreachable');
    await produceDiff(admin(), opts, input);
    expect(messages()[0]?.values.model).toBeNull();
  });

  it('sends nothing when the room has routed nothing', async () => {
    await produceDiff(admin(), opts, input);
    expect(replanInputs[0]?.generation).toBeNull();
  });
});
