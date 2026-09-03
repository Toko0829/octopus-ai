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
let replanResponse: { proposals: unknown[]; citations: unknown[] };
let replanThrows: Error | null;

vi.mock('./ai', () => ({
  requestReplan: async () => {
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
      maybeSingle: async () => ({ data: null, error: null }),
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
} as never;

const opts = { aiServiceUrl: 'http://ai', log };
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
  replanResponse = { proposals: [aReplan], citations: [] };
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
