/**
 * Route tests for the embed action route's second path: answering a question
 * card on the card.
 *
 * The verdict path (approve / request_changes on a plan, replan or campaign)
 * is driven against the live database, because its commit functions are SQL
 * and a fake that always succeeds proves nothing about them. What is covered
 * here is the part a fake CAN prove: the authorisation, which body reaches
 * which card, the rpc arguments, and that a refusal writes nothing.
 *
 * Two properties carry most of the value:
 *
 *   1. **The owner check runs before anything.** An answer used to be a chat
 *      message that never reached this route, so the owner-only rule had to
 *      live in the agent run. Now `required_role` is the whole control, and a
 *      human node in the room must be refused with zero writes.
 *   2. **A question card never gets a verdict and never writes a label.** A
 *      question has no verdict, and `feedback_events` reads what it stores as
 *      training data.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';
const EMBED = '44444444-4444-4444-8444-444444444444';
const TASK_A = '55555555-5555-4555-8555-555555555555';
const TASK_B = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';

let embedRow: Record<string, unknown> | null;
let roomRow: Record<string, unknown> | null;
let taskRow: Record<string, unknown> | null;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
/** What each rpc answers. A function so a test can derive it from its args. */
let rpcAnswers: Record<string, (args: Record<string, unknown>) => unknown>;
/** Every write a request made, so a refusal can be asserted to have made none. */
let written: { table: string; op: string; values?: Record<string, unknown> }[];
/** Set to make the conditional close of the card find no row. */
let closeMisses: boolean;

const continueFromCard = vi.fn<
  (roomId: string, embedId: string, payload: unknown) => Promise<void>
>(async () => {});

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const applied: Record<string, unknown> = {};
      let mode: 'select' | 'update' = 'select';
      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied[column] = value;
          return b;
        },
        in: () => b,
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (values: Record<string, unknown>) => {
          mode = 'update';
          written.push({ table, op: 'update', values });
          const apply = () => {
            if (table === 'action_embeds') {
              if (closeMisses || !embedRow || embedRow.state !== applied.state) return null;
              Object.assign(embedRow, values);
              return { id: EMBED, state: embedRow.state };
            }
            if (table === 'tasks') {
              if (!taskRow || (applied.state !== undefined && taskRow.state !== applied.state)) {
                return [];
              }
              Object.assign(taskRow, values);
              return [{ id: TASK_A }];
            }
            return null;
          };
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: apply(), error: null }),
            maybeSingle: async () => ({ data: apply(), error: null }),
          });
        },
        maybeSingle: async () => {
          if (mode === 'update') return { data: null, error: null };
          if (table === 'action_embeds') return { data: embedRow, error: null };
          if (table === 'rooms') return { data: roomRow, error: null };
          if (table === 'tasks') return { data: taskRow, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const answer = rpcAnswers[name];
      return { data: answer ? answer(args) : null, error: null };
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

vi.mock('../lib/agent-runner', () => ({
  createAgentRunner: () => ({ startRun: vi.fn(), continueFromCard }),
}));

const { embedRoutes } = await import('./embeds');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(embedRoutes, {
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    aiServiceUrl: 'http://ai.invalid',
    aiTimeoutMs: 1000,
  } as never);
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });
const url = `/api/rooms/${ROOM}/embeds/${EMBED}/actions`;

function intakeCard(slots: { key: string; value: string; source: string }[] = []) {
  return {
    awaiting: 'answers',
    goal: 'get my first 100 customers',
    questions: [
      { slot: 'icp', question: 'Who is it for?' },
      { slot: 'budget_band', question: 'How much a month?' },
    ],
    slots,
    round: 0,
    answers: [],
    stalls: 0,
    taskIds: [],
    runId: RUN,
  };
}

function taskCard(taskAnswers: Record<string, string> = {}) {
  return {
    awaiting: 'task_answers',
    goal: '',
    questions: [],
    slots: [],
    round: 0,
    answers: [],
    stalls: 0,
    taskIds: [TASK_A, TASK_B],
    tasks: [
      { id: TASK_A, title: 'Confirm the monthly ad budget' },
      { id: TASK_B, title: 'Choose the brand voice' },
    ],
    taskAnswers,
  };
}

function anEmbed(component: string, payload: unknown, state = 'pending') {
  return { id: EMBED, room_id: ROOM, component, payload, required_role: 'owner', state };
}

/** The rpc behaves like the real one: replace-or-append the slot, mark it stated. */
function slotRpc(args: Record<string, unknown>) {
  const payload = (embedRow as { payload: ReturnType<typeof intakeCard> }).payload;
  const kept = payload.slots.filter((s) => s.key !== args.p_slot);
  return {
    ...payload,
    slots: [...kept, { key: args.p_slot, value: args.p_value, source: 'stated' }],
  };
}

function taskRpc(args: Record<string, unknown>) {
  const payload = (embedRow as { payload: ReturnType<typeof taskCard> }).payload;
  if (!payload.taskIds.includes(args.p_task_id as string)) return null;
  return {
    ...payload,
    taskAnswers: { ...(payload.taskAnswers ?? {}), [args.p_task_id as string]: args.p_value },
  };
}

beforeEach(() => {
  embedRow = anEmbed('question', intakeCard());
  roomRow = { owner_id: OWNER };
  taskRow = {
    id: TASK_A,
    project_id: 'p1',
    title: 'Confirm the monthly ad budget',
    state: 'needs_user',
  };
  rpcCalls = [];
  rpcAnswers = { answer_question_slot: slotRpc, answer_question_task: taskRpc };
  written = [];
  closeMisses = false;
  continueFromCard.mockClear();
});

const answer = (slot: string, value: string) => ({ action: 'answer', slot, value });

describe('who may answer', () => {
  it('refuses a member who is not the owner, and writes nothing', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(STRANGER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('refuses when the room has no owner, because null means nobody', async () => {
    roomRow = { owner_id: null };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(403);
    expect(written).toEqual([]);
  });
});

describe('which body reaches which card', () => {
  it('refuses a verdict on a question card', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'approve' },
    });
    expect(res.statusCode).toBe(409);
    expect(written).toEqual([]);
  });

  it('refuses a verdict carrying a budget on a question card, before the cap is read', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'approve', budgetCap: 100 },
    });
    expect(res.statusCode).toBe(409);
    expect(written).toEqual([]);
  });

  it('refuses an answer on a plan card', async () => {
    embedRow = anEmbed('plan', { title: 't', summary: 's', stages: [], citations: [] });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(409);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses an answer that names both a slot and a task', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'answer', slot: 'icp', taskId: TASK_A, value: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses an answer on a card that is already answered', async () => {
    embedRow = anEmbed('question', intakeCard(), 'answered');
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(409);
    expect(rpcCalls).toEqual([]);
  });

  it('has nothing to answer on a card left waiting for a goal', async () => {
    embedRow = anEmbed('question', { ...intakeCard(), awaiting: 'goal', goal: '', questions: [] });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(409);
    expect(rpcCalls).toEqual([]);
  });
});

describe('answering a slot', () => {
  it('writes the one slot through the rpc and reports what is still missing', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'solo founders'),
    });
    expect(res.statusCode).toBe(200);
    expect(rpcCalls).toEqual([
      {
        name: 'answer_question_slot',
        args: { p_embed_id: EMBED, p_slot: 'icp', p_value: 'solo founders' },
      },
    ]);
    const body = res.json();
    expect(body.state).toBe('pending');
    expect(body.remaining).toEqual(['budget_band']);
    expect(body.payload.slots).toEqual([{ key: 'icp', value: 'solo founders', source: 'stated' }]);
    // The card stays open, and nothing is labelled.
    expect(written.filter((w) => w.table === 'action_embeds')).toEqual([]);
    expect(written.filter((w) => w.table === 'feedback_events')).toEqual([]);
    expect(continueFromCard).not.toHaveBeenCalled();
  });

  it('closes the card and continues the run when the last required slot lands', async () => {
    embedRow = anEmbed(
      'question',
      intakeCard([{ key: 'icp', value: 'founders', source: 'inferred' }]),
    );
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('budget_band', '500_2k'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('answered');
    expect(res.json().remaining).toEqual([]);
    const close = written.find((w) => w.table === 'action_embeds' && w.op === 'update');
    expect(close?.values).toMatchObject({ state: 'answered', acted_by: OWNER });
    expect(continueFromCard).toHaveBeenCalledTimes(1);
    expect(continueFromCard.mock.calls[0]?.[0]).toBe(ROOM);
    expect(continueFromCard.mock.calls[0]?.[1]).toBe(EMBED);
    expect(written.filter((w) => w.table === 'feedback_events')).toEqual([]);
  });

  it('reports a closed card when the rpc finds no pending row', async () => {
    // The conditional update lives inside the function: null means it matched
    // nothing, which is a race lost, not a fault.
    rpcAnswers.answer_question_slot = () => null;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: answer('icp', 'x'),
    });
    expect(res.statusCode).toBe(409);
    expect(continueFromCard).not.toHaveBeenCalled();
  });

  it('turns the function refusal into a 400', async () => {
    rpcAnswers.answer_question_slot = () => {
      throw new Error('unused');
    };
    const app = await build();
    // Route the error through the rpc's error channel rather than a throw.
    (client as unknown as { rpcError?: unknown }).rpcError = null;
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'answer', slot: 'icp', value: '' },
    });
    // An empty value never reaches the rpc: the contract refuses it first.
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe('finishing a card', () => {
  it('closes it with whatever it has and continues the run', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'finish' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('answered');
    expect(continueFromCard).toHaveBeenCalledTimes(1);
    expect(written.filter((w) => w.table === 'feedback_events')).toEqual([]);
  });

  it('loses a race to whoever closed it first', async () => {
    closeMisses = true;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'finish' },
    });
    expect(res.statusCode).toBe(409);
    expect(continueFromCard).not.toHaveBeenCalled();
  });

  it('is not how a task card closes', async () => {
    embedRow = anEmbed('question', taskCard());
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'finish' },
    });
    expect(res.statusCode).toBe(409);
    expect(written).toEqual([]);
  });
});

describe('answering a task', () => {
  const taskAnswer = (taskId: string) => ({
    action: 'answer',
    taskId,
    value: 'Two thousand a month.',
  });

  beforeEach(() => {
    embedRow = anEmbed('question', taskCard());
  });

  it('records the answer on the card, then completes the step through approved to done', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: taskAnswer(TASK_A),
    });
    expect(res.statusCode).toBe(200);
    expect(rpcCalls[0]).toEqual({
      name: 'answer_question_task',
      args: { p_embed_id: EMBED, p_task_id: TASK_A, p_value: 'Two thousand a month.' },
    });
    const artifact = written.find((w) => w.table === 'artifacts');
    expect(artifact?.values).toMatchObject({
      kind: 'answer',
      created_by: 'user',
      citations: [],
      task_id: TASK_A,
    });
    expect(
      written.filter((w) => w.table === 'tasks' && w.op === 'update').map((w) => w.values?.state),
    ).toEqual(['approved', 'done']);
    // One step of two answered: the card stays open for the other.
    expect(res.json().state).toBe('pending');
    expect(written.filter((w) => w.table === 'action_embeds')).toEqual([]);
    // And the room is told, keyed so a replay says it once.
    const notice = written.find((w) => w.table === 'messages');
    expect(notice?.values).toMatchObject({
      // The Strategist: it asked the question, so it is the one saying it has
      // the answer and is carrying on.
      author_kind: 'agent',
      persona: 'strategist',
      idempotency_key: `question-task:${EMBED}:${TASK_A}`,
    });
    expect(String(notice?.values?.body)).toContain('Confirm the monthly ad budget');
  });

  it('closes the card once every step it named is answered', async () => {
    embedRow = anEmbed('question', taskCard({ [TASK_B]: 'Warm and plain.' }));
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: taskAnswer(TASK_A),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('answered');
    // A task card continues nothing: the plan it belongs to is already running.
    expect(continueFromCard).not.toHaveBeenCalled();
  });

  it('refuses a task the card never asked about', async () => {
    const app = await build();
    const other = '99999999-9999-4999-8999-999999999999';
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: taskAnswer(other),
    });
    expect(res.statusCode).toBe(409);
    expect(written.filter((w) => w.table === 'artifacts')).toEqual([]);
  });

  it('keeps the answer but does not pretend a step that moved on was completed', async () => {
    taskRow = { ...taskRow, state: 'cancelled' };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: taskAnswer(TASK_A),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('kept on the card');
    expect(written.filter((w) => w.table === 'artifacts')).toEqual([]);
  });

  it('refuses a task answer on an intake card', async () => {
    embedRow = anEmbed('question', intakeCard());
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: taskAnswer(TASK_A),
    });
    expect(res.statusCode).toBe(409);
    expect(rpcCalls).toEqual([]);
  });
});
