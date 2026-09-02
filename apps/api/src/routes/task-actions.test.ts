/**
 * Route tests for the owner's two slice-8 acts: disputing a step, and rating the
 * expert who did it.
 *
 * **Scoped to slice 8 on purpose.** The older verbs on the resolve endpoint
 * (`answer`, `retry`, `find_expert`, `approve_work`, `reject_work`) are pinned
 * where their decision actually lives, in `lib/task-resolution.test.ts`, which is
 * pure and covers every state pair. What is covered here is the part that file
 * cannot reach: the authorisation, the rpc arguments, and that a refusal writes
 * nothing.
 *
 * Two properties carry most of the value:
 *
 *   1. **The role in the rpc call is derived, never taken from the caller.**
 *      `p_raised_role` decides whose grievance an operator is reading, and
 *      `raise_dispute` uses it to pick which state list applies. An owner able to
 *      send `'node'` could raise from a state only a node may raise from.
 *   2. **The owner check runs before anything.** A human node is in the room and
 *      must not be able to dispute the owner's own step, or rate on their behalf.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const ENGAGEMENT = '55555555-5555-4555-8555-555555555555';
const ROOM = '66666666-6666-4666-8666-666666666666';
const DISPUTE = '77777777-7777-4777-8777-777777777777';
const RATING = '88888888-8888-4888-8888-888888888888';

let taskRow: Record<string, unknown> | null;
let projectRow: Record<string, unknown> | null;
let embedRow: Record<string, unknown> | null;
let roomRow: Record<string, unknown> | null;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let rpcFailures: Record<string, { code: string; message: string }>;
/** Every write a request made, so a refusal can be asserted to have made none. */
let written: { table: string; op: string; values?: Record<string, unknown> }[];

/**
 * Runs after a `tasks` update lands, so a test can move the row underneath the
 * route the way a concurrent replan would.
 */
let onTaskStateWrite: (() => void) | null;

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const applied: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied[column] = value;
          return b;
        },
        is: () => b,
        in: () => b,
        not: () => b,
        order: () => b,
        limit: () => b,
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        /**
         * **`tasks` is the one table modelled as a row that a filter can miss.**
         * Every state write on this route is conditional on the state it read,
         * so a fake that always matched could not tell a committed move from one
         * that lost a race, and the second hop this suite exists to pin is
         * exactly a conditional write that is allowed to find nothing.
         *
         * Applied at the end of the chain rather than here, because PostgREST
         * builders read `.update(...).eq(...).eq(...)` and no filter has been
         * declared yet at this point. Every other table keeps the old behaviour:
         * the write is recorded and nothing is returned.
         */
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          const apply = () => {
            if (table !== 'tasks' || !taskRow) return null;
            if (applied.state !== undefined && taskRow.state !== applied.state) return [];
            Object.assign(taskRow, values);
            onTaskStateWrite?.();
            return [{ id: TASK }];
          };
          return Object.assign(b, {
            select: () =>
              Object.assign(b, {
                then: (resolve: (v: unknown) => unknown) => resolve({ data: apply(), error: null }),
              }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: apply(), error: null }),
          });
        },
        maybeSingle: async () => {
          if (table === 'tasks') return { data: taskRow, error: null };
          if (table === 'projects') return { data: projectRow, error: null };
          if (table === 'action_embeds') return { data: embedRow, error: null };
          if (table === 'rooms') return { data: roomRow, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const failure = rpcFailures[name];
      if (failure) return { data: null, error: failure };
      return { data: name === 'submit_rating' ? RATING : DISPUTE, error: null };
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { taskActionRoutes } = await import('./task-actions');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(taskActionRoutes, {
    // Stands in for JWKS verification. The token is the subject, so a test can
    // choose who is calling without minting a real JWT.
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    // The executor wiring the approval path needs. No test here reaches it: the
    // dispute branch returns before the executor is consulted, and the rating
    // route is a different endpoint entirely.
    aiServiceUrl: 'http://ai.invalid',
    aiTimeoutMs: 1000,
  } as never);
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

function aTask(state: string) {
  return {
    id: TASK,
    project_id: PROJECT,
    title: 'Cut the launch video',
    stage: 'consider',
    owner_type: 'human',
    state,
    risk_tier: 'low',
    citations: null,
  };
}

beforeEach(() => {
  taskRow = aTask('in_progress');
  projectRow = { source_embed_id: 'embed-1', budget_ceiling: 2000 };
  embedRow = { room_id: ROOM };
  roomRow = { owner_id: OWNER };
  rpcCalls = [];
  rpcFailures = {};
  written = [];
  onTaskStateWrite = null;
});

/**
 * The owner does the step themselves, and the step **finishes**.
 *
 * `approved` is not terminal, and "anything non-terminal may be cancelled" is a
 * universal rule of the task map, so before the second hop existed a step the
 * owner had just completed stayed cancellable by a later replan and would be
 * recorded in the audit trail as abandoned. The distinction this route has to
 * keep is that `approve_work` lands on the same state and must **not** finish:
 * `PAYABLE_TASK_STATES` selects on `approved`, so walking it on would take the
 * step out from under the sweep that pays the expert. That half is pinned in
 * `task-resolution.test.ts`, where the decision is made.
 */
describe('the owner answers a step themselves', () => {
  const url = `/api/projects/${PROJECT}/tasks/${TASK}/resolution`;
  const payload = { action: 'answer', text: 'I set the ceiling at 2000 a month.' };

  const stateWrites = () =>
    written.filter((w) => w.table === 'tasks' && w.op === 'update').map((w) => w.values?.state);

  beforeEach(() => {
    taskRow = aTask('needs_user');
  });

  it('walks the step through approved to done', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.statusCode).toBe(200);
    // Through `approved`, not around it: that is the arc `needs_user` has and
    // the state `task_deps_satisfied` unblocks dependents on.
    expect(stateWrites()).toEqual(['approved', 'done']);
  });

  it('reports the state it actually left the step in', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.json().state).toBe('done');
  });

  it('stores the write-up as the deliverable before moving anything', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    const artifact = written.find((w) => w.table === 'artifacts');
    expect(artifact?.values).toMatchObject({ kind: 'answer', created_by: 'user', citations: [] });
    expect(written.indexOf(artifact!)).toBeLessThan(
      written.findIndex((w) => w.table === 'tasks' && w.op === 'update'),
    );
  });

  it('keeps the answer when the step moves underneath it', async () => {
    // `approved -> cancelled` is a legal arc and a replan may walk it in exactly
    // this window. The owner's answer is already committed, so losing the race
    // is reported as the state the step is in, never as a 409 about work they
    // already did.
    onTaskStateWrite = () => {
      if (taskRow?.state === 'approved') taskRow.state = 'cancelled';
    };
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('approved');
    expect(written.some((w) => w.table === 'artifacts')).toBe(true);
  });

  it('still refuses when the step is not waiting on anybody', async () => {
    taskRow = aTask('in_progress');
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.statusCode).toBe(409);
    expect(written).toEqual([]);
  });
});

describe('the owner disputes a step', () => {
  const url = `/api/projects/${PROJECT}/tasks/${TASK}/resolution`;
  const payload = { action: 'dispute', text: 'Nothing has arrived and the deadline passed.' };

  it('freezes the step and records the grievance in one call', async () => {
    // The route does not move the task itself, unlike every other action on this
    // endpoint: a frozen step with no dispute row is a step nobody can explain,
    // and a dispute row over an unfrozen step is a freeze that is not freezing
    // anything. `raise_dispute` lands both.
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('disputed');
    expect(res.json().ranExecutor).toBe(false);

    const call = rpcCalls.find((c) => c.name === 'raise_dispute');
    expect(call?.args.p_task_id).toBe(TASK);
    expect(call?.args.p_raised_by).toBe(OWNER);
    expect(call?.args.p_raised_role).toBe('owner');
    expect(call?.args.p_reason).toBe(payload.text);
  });

  it('never lets the caller choose which side raised it', async () => {
    // `p_raised_role` picks which state list `raise_dispute` applies. An owner
    // able to send `'node'` could raise from `rejected`, which is the node's arc
    // and means something different to the operator reading it.
    const app = await build();
    await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { ...payload, raisedRole: 'node', p_raised_role: 'node' },
    });
    expect(rpcCalls.find((c) => c.name === 'raise_dispute')?.args.p_raised_role).toBe('owner');
  });

  it('allows the three states that sit before the transfer', async () => {
    for (const state of ['escrow_funded', 'in_progress', 'payout_pending']) {
      taskRow = aTask(state);
      rpcCalls = [];
      const app = await build();
      const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
      expect(res.statusCode, state).toBe(200);
      expect(rpcCalls, state).toHaveLength(1);
    }
  });

  it('refuses every other state without calling anything', async () => {
    for (const state of ['approved', 'rejected', 'paid', 'done', 'cancelled', 'escalated']) {
      taskRow = aTask(state);
      rpcCalls = [];
      written = [];
      const app = await build();
      const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
      expect(res.statusCode, state).toBe(409);
      expect(rpcCalls, state).toEqual([]);
      expect(written, state).toEqual([]);
    }
  });

  it('points a handed-over step at the review path instead', async () => {
    // Work handed over and not yet judged is a review, not a dispute, and
    // `reject_work` with a required note is the cheaper, more informative act.
    // If that rejection is then contested, the node's own arc answers it.
    taskRow = aTask('proof_submitted');
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('Send it back');
    expect(rpcCalls).toEqual([]);
  });

  it('requires the owner to say what has gone wrong', async () => {
    const app = await build();
    for (const text of ['', '   ']) {
      rpcCalls = [];
      const res = await app.inject({
        method: 'POST',
        url,
        headers: as(OWNER),
        payload: { action: 'dispute', text },
      });
      expect(res.statusCode).toBe(409);
      expect(rpcCalls).toEqual([]);
    }
  });

  it('refuses anybody who is not the workspace owner', async () => {
    // A human node is in this room. Disputing the owner's own step, or resolving
    // it any other way, is not theirs to do.
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(STRANGER), payload });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('answers 404 for a step the caller cannot see', async () => {
    // Read as the caller, so RLS decides whether this task exists for them, and
    // the API does not confirm the existence of something it will not show.
    taskRow = null;
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(STRANGER), payload });
    expect(res.statusCode).toBe(404);
  });

  it('tells the room once, keyed on the dispute', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    const messages = written.filter((w) => w.table === 'messages');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.values?.idempotency_key).toBe(`dispute-raised:${DISPUTE}`);
    expect(messages[0]!.values?.room_id).toBe(ROOM);
    expect(String(messages[0]!.values?.body)).not.toContain('—');
  });

  it('does not name the expert in the room line', async () => {
    // The owner already knows who they engaged, and a system line naming
    // somebody beside the word "dispute" reads as a verdict before anybody has
    // made one.
    const app = await build();
    await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    const line = String(written.find((w) => w.table === 'messages')?.values?.body);
    expect(line.toLowerCase()).not.toContain('expert');
  });

  it('hands back the database refusal when the step moved underneath', async () => {
    // `raise_dispute` refuses the same states this route already refused, so
    // reaching that refusal means the step moved between the read and the call,
    // and the SQL names what it moved to.
    rpcFailures.raise_dispute = {
      code: '23514',
      message: 'cannot dispute a task in state paid',
    };
    const app = await build();
    const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('cannot dispute a task in state paid');
  });

  it('refuses an action nobody defined', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { action: 'escalate_to_lawyer', text: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });
});

describe('the owner rates the expert', () => {
  const url = `/api/projects/${PROJECT}/engagements/${ENGAGEMENT}/rating`;

  it('records the score against the engagement, not the step', async () => {
    // A step that was taken, abandoned and reassigned has two engagements with
    // two different experts, and a rating belongs to the deal it is about.
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { score: 5, comment: 'Delivered early and the cut was right.' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ratingId).toBe(RATING);
    const call = rpcCalls.find((c) => c.name === 'submit_rating');
    expect(call?.args.p_engagement_id).toBe(ENGAGEMENT);
    expect(call?.args.p_rater).toBe(OWNER);
    expect(call?.args.p_score).toBe(5);
  });

  it('sends no direction and no ratee, because the database derives both', async () => {
    const app = await build();
    await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { score: 3, direction: 'node_of_owner', rateeId: STRANGER },
    });
    expect(Object.keys(rpcCalls[0]?.args ?? {}).sort()).toEqual([
      'p_comment',
      'p_engagement_id',
      'p_rater',
      'p_score',
    ]);
  });

  it('refuses a score outside one to five, and a fractional one', async () => {
    const app = await build();
    for (const score of [0, 6, 4.5, -2]) {
      rpcCalls = [];
      const res = await app.inject({ method: 'POST', url, headers: as(OWNER), payload: { score } });
      expect(res.statusCode, String(score)).toBe(400);
      expect(rpcCalls, String(score)).toEqual([]);
    }
  });

  it('refuses anybody who is not the workspace owner', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(STRANGER),
      payload: { score: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses when the project resolves to no owner at all', async () => {
    // A null owner means nobody, never anybody. Read as the caller, so a room
    // they cannot see yields no owner and the check fails closed.
    roomRow = { owner_id: null };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { score: 5 },
    });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it('passes the completed-deal gate through rather than second-guessing it', async () => {
    // `submit_rating` gates on `outcome = 'completed'`, which is what keeps a
    // `disputed_resolved` deal readable and unrateable. The route hands back
    // that refusal rather than holding a second copy of the rule.
    rpcFailures.submit_rating = {
      code: '23514',
      message: 'only a completed engagement can be rated',
    };
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url,
      headers: as(OWNER),
      payload: { score: 5 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('only a completed engagement can be rated');
  });

  it('moves no task, because rating is not a resolution', async () => {
    // Filed as its own route rather than another `action`, since the step is
    // already `done` and nothing here moves it. Asserted so it stays that way.
    const app = await build();
    await app.inject({ method: 'POST', url, headers: as(OWNER), payload: { score: 5 } });
    expect(written.filter((w) => w.table === 'tasks')).toEqual([]);
  });
});
