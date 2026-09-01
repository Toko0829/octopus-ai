/**
 * The sweep that takes a step back from somebody who did not deliver, and the
 * one property that matters more than the rest: **it must never take work away
 * from somebody who did.**
 *
 * What is pinned here:
 *
 *   1. **Only `escrow_funded` and `in_progress` are reassigned.** A step at
 *      `proof_submitted` or `in_review` is past its deadline because the OWNER
 *      has not looked, and reassigning it would hand a finished person's fee to a
 *      stranger.
 *   2. **A warning comes first**, once ever, so reassignment is never the first
 *      thing a working node hears about a date they lost track of.
 *   3. **`maxPerPass` bounds reassignments, not warnings and not the read**, so a
 *      batch of nodes approaching their deadline cannot starve the one who passed
 *      it.
 *   4. **A failure on one engagement does not stop the pass**, and is never
 *      swallowed (rule 16): this is money and somebody's work.
 *   5. **The message comes after the commit**, keyed on the engagement, so a
 *      crash between them cannot produce a second announcement.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noShowSweep } from './no-show';

const ENGAGEMENT = 'e1';
const TASK = 't1';
const PROJECT = 'p1';
const NODE = 'n1';
const ROOM = 'r1';
const THREAD = 'th1';
const EMBED = 'em1';

interface TableState {
  rows: Record<string, unknown>[];
}

/** Named rather than a Record, so a fixture assignment is checked. */
interface Tables {
  engagements: TableState;
  tasks: TableState;
  threads: TableState;
  messages: TableState;
  projects: TableState;
  action_embeds: TableState;
  rooms: TableState;
}

let tables: Tables;
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let rpcError: { message: string } | null;
let messageInsertError: { code: string } | null;
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

/** Fixed, so a test can stand on either side of a deadline without a real clock. */
const NOW = new Date('2026-09-06T12:00:00.000Z');
const IN_TWO_DAYS = new Date('2026-09-08T12:00:00.000Z').toISOString();
const IN_SIX_HOURS = new Date('2026-09-06T18:00:00.000Z').toISOString();
const YESTERDAY = new Date('2026-09-05T12:00:00.000Z').toISOString();

function admin() {
  return {
    from(table: string) {
      const state = tables[table as keyof Tables] ?? { rows: [] };
      const applied: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};

      const matches = () =>
        state.rows.filter((row) =>
          Object.entries(applied).every(([col, val]) => {
            if (col.startsWith('is:')) return row[col.slice(3)] === val;
            if (col.startsWith('not:')) return row[col.slice(4)] !== null;
            if (col.startsWith('in:')) return (val as unknown[]).includes(row[col.slice(3)]);
            return row[col] === val;
          }),
        );

      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied[column] = value;
          return b;
        },
        is: (column: string, value: unknown) => {
          applied[`is:${column}`] = value;
          return b;
        },
        not: (column: string) => {
          applied[`not:${column}`] = true;
          return b;
        },
        in: (column: string, value: unknown) => {
          applied[`in:${column}`] = value;
          return b;
        },
        order: () => b,
        limit: async () => ({ data: matches(), error: null }),
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) =>
              resolve({ data: null, error: table === 'messages' ? messageInsertError : null }),
          });
        },
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { data: null, error: rpcError };
    },
  };
}

function deps(over: { maxPerPass?: number } = {}) {
  return {
    admin: admin() as never,
    maxPerPass: over.maxPerPass ?? 3,
    log,
    now: () => NOW,
  };
}

function anEngagement(over: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT,
    task_id: TASK,
    project_id: PROJECT,
    node_id: NODE,
    deadline_at: YESTERDAY,
    agreed_price: 400,
    currency: 'USD',
    ended_at: null,
    ...over,
  };
}

function aTask(over: Record<string, unknown> = {}) {
  return { id: TASK, state: 'in_progress', title: 'Shoot the launch video', ...over };
}

beforeEach(() => {
  written = [];
  rpcCalls = [];
  rpcError = null;
  messageInsertError = null;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  tables = {
    engagements: { rows: [] },
    tasks: { rows: [] },
    threads: { rows: [{ id: THREAD, room_id: ROOM, task_id: TASK }] },
    messages: { rows: [] },
    // `roomForProject` resolves a project to its room through the plan card it
    // was materialised from, never through `rooms.project_id` (that column is
    // claimed by the first project approved in a room). The fixture has to carry
    // both hops or the announcement half of this sweep is never exercised.
    projects: { rows: [{ id: PROJECT, source_embed_id: EMBED }] },
    action_embeds: { rows: [{ id: EMBED, room_id: ROOM }] },
    rooms: { rows: [{ id: ROOM, project_id: PROJECT }] },
  };
});

describe('taking a step back from somebody who did not deliver', () => {
  it('reassigns an overdue step that was started and abandoned', async () => {
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask({ state: 'in_progress' })];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(1);
    expect(rpcCalls).toEqual([
      { name: 'reassign_engagement', args: { p_engagement_id: ENGAGEMENT } },
    ]);
  });

  it('reassigns one that was funded and never started', async () => {
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask({ state: 'escrow_funded' })];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(1);
  });

  it('tells the owner what happened to the step AND to the money', async () => {
    // Two facts, and only one of them is obvious from the step moving.
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask()];

    await noShowSweep(deps());

    const message = written.find((w) => w.table === 'messages');
    expect(message?.values?.idempotency_key).toBe(`work-reassigned:${ENGAGEMENT}`);
    expect(String(message?.values?.body)).toMatch(/available again/i);
  });

  it('does not name the node in the message that says they failed', async () => {
    // The roster cannot see a thread-scoped membership, and naming somebody in
    // that sentence is a decision this slice has no reason to take.
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask()];

    await noShowSweep(deps());

    const message = written.find((w) => w.table === 'messages');
    // Asserted present first: without this the body check passes vacuously on
    // `String(undefined)`, which is how a test starts confirming nothing.
    expect(message).toBeDefined();
    expect(String(message?.values?.body)).not.toContain(NODE);
  });
});

describe('the step it must never take', () => {
  it('leaves an overdue step that was already handed over', async () => {
    // **The most consequential assertion in this file.** A deadline that passes
    // after the work arrives is the owner's failure to review, and reassigning
    // here would take a finished person's fee and give it to a stranger.
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask({ state: 'proof_submitted' })];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('leaves one the owner is in the middle of deciding on', async () => {
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask({ state: 'in_review' })];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('leaves an approved step alone, so nobody loses money they earned', async () => {
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask({ state: 'approved' })];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(0);
  });

  it('leaves a step whose deadline has not passed', async () => {
    tables.engagements.rows = [anEngagement({ deadline_at: IN_TWO_DAYS })];
    tables.tasks.rows = [aTask()];

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(0);
    expect(result.warned).toBe(0);
  });
});

describe('warning before acting', () => {
  it('warns a node inside the last day, in their own thread', async () => {
    tables.engagements.rows = [anEngagement({ deadline_at: IN_SIX_HOURS })];
    tables.tasks.rows = [aTask()];

    const result = await noShowSweep(deps());

    expect(result.warned).toBe(1);
    expect(result.reassigned).toBe(0);
    const message = written.find((w) => w.table === 'messages');
    // In the thread, because it is addressed to the node and the node cannot
    // read the room stream. The owner sees it anyway: they read thread messages.
    expect(message?.values?.thread_id).toBe(THREAD);
    expect(message?.values?.idempotency_key).toBe(`work-due-soon:${ENGAGEMENT}`);
  });

  it('says it once ever, not once per pass', async () => {
    // The key is the whole contract: a collision is the mechanism working, which
    // is what stops the last day of every deal producing a message a minute.
    tables.engagements.rows = [anEngagement({ deadline_at: IN_SIX_HOURS })];
    tables.tasks.rows = [aTask()];
    messageInsertError = { code: '23505' };

    const result = await noShowSweep(deps());

    expect(result.warned).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not warn about a step that was already handed over', async () => {
    tables.engagements.rows = [anEngagement({ deadline_at: IN_SIX_HOURS })];
    tables.tasks.rows = [aTask({ state: 'proof_submitted' })];

    const result = await noShowSweep(deps());

    expect(result.warned).toBe(0);
  });
});

describe('bounds and failures', () => {
  it('bounds reassignments performed, not engagements examined', async () => {
    tables.engagements.rows = [
      anEngagement({ id: 'e1', task_id: 'ta' }),
      anEngagement({ id: 'e2', task_id: 'tb' }),
      anEngagement({ id: 'e3', task_id: 'tc' }),
    ];
    tables.tasks.rows = [aTask({ id: 'ta' }), aTask({ id: 'tb' }), aTask({ id: 'tc' })];
    tables.threads.rows = [
      { id: 'th-a', room_id: ROOM, task_id: 'ta' },
      { id: 'th-b', room_id: ROOM, task_id: 'tb' },
      { id: 'th-c', room_id: ROOM, task_id: 'tc' },
    ];

    const result = await noShowSweep(deps({ maxPerPass: 2 }));

    expect(result.reassigned).toBe(2);
    expect(rpcCalls).toHaveLength(2);
  });

  it('counts a failure as waiting, logs it loudly, and carries on', async () => {
    // Rule 16. A silent skip here is a step that stays stuck for exactly as long
    // as nobody reads the logs, with somebody's budget pinned against it.
    tables.engagements.rows = [anEngagement()];
    tables.tasks.rows = [aTask()];
    rpcError = { message: 'step is proof_submitted, so it is not an abandoned one' };

    const result = await noShowSweep(deps());

    expect(result.reassigned).toBe(0);
    expect(result.waiting).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('does nothing at all when no engagement is live', async () => {
    const result = await noShowSweep(deps());
    expect(result).toEqual({ warned: 0, reassigned: 0, waiting: 0 });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns rather than throwing when an overdue engagement has no thread', async () => {
    tables.engagements.rows = [anEngagement({ deadline_at: IN_SIX_HOURS })];
    tables.tasks.rows = [aTask()];
    tables.threads.rows = [];

    const result = await noShowSweep(deps());

    expect(result.warned).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });
});
