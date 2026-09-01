/**
 * The sweep that gives escrow back, and the four properties whose violation is
 * expensive and silent.
 *
 *   1. **A step that reached `done` is never refunded.** That hold belongs to the
 *      payout slice; refunding it would take back money somebody earned, and it
 *      would look exactly like tidying up.
 *   2. **A second pass performs nothing.** The conditional `held -> refunded`
 *      update is the whole idempotency contract, so a sweep running every thirty
 *      seconds must not write a second reversal or a second message.
 *   3. **The reversal balances**, and shares the hold's reference, so the four
 *      entries about one hold sum to zero on every account.
 *   4. **Revocation is scoped to the step's own thread.** A node can hold
 *      memberships in other rooms for other work, and a revocation keyed on the
 *      person alone would cut them out of work that is still running.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { entriesBalance, refundKey } from '@octopus/payments';
import { escrowReconcileSweep } from './escrow-reconcile';

interface TableState {
  rows: Record<string, unknown>[];
  /** Whether a conditional update reports rows moved. */
  updateMoves?: boolean;
}

/**
 * Named rather than a `Record<string, TableState>`, because
 * `noUncheckedIndexedAccess` makes every index of the latter possibly
 * undefined and a test that has to write `tables.tasks!` on every line stops
 * reading as a fixture.
 */
interface Tables {
  escrow_holds: TableState;
  tasks: TableState;
  engagements: TableState;
  threads: TableState;
  room_members: TableState;
  ledger_entries: TableState;
  messages: TableState;
  projects: TableState;
  action_embeds: TableState;
}

const HOLD = 'h1111111-1111-4111-8111-111111111111';
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE = '11111111-1111-4111-8111-111111111111';
const ROOM = '88888888-8888-4888-8888-888888888888';
const THREAD = '99999999-9999-4999-8999-999999999999';
const ENGAGEMENT = '77777777-7777-4777-8777-777777777777';

let tables: Tables;
let written: { table: string; op: string; values?: unknown; filters: Record<string, unknown> }[];
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function admin() {
  return {
    from(table: string) {
      const state: TableState = tables[table as keyof Tables] ?? { rows: [] };
      const applied: Record<string, unknown> = {};

      const matches = () =>
        state.rows.filter((row) =>
          Object.entries(applied).every(([col, val]) => {
            if (col.startsWith('is:')) return row[col.slice(3)] === val;
            if (col.startsWith('in:')) return (val as unknown[]).includes(row[col.slice(3)]);
            return row[col] === val;
          }),
        );

      const b: Record<string, unknown> = {};
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
        in: (column: string, value: unknown[]) => {
          applied[`in:${column}`] = value;
          return b;
        },
        limit: () => b,
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        insert: (values: unknown) => {
          written.push({ table, op: 'insert', values, filters: { ...applied } });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (values: unknown) => {
          // `filters` is the SAME object the builder keeps filling in, not a
          // copy. postgrest-js applies its conditions after `.update()`, so a
          // snapshot taken here would record an unconditional write and every
          // assertion about a conditional one would pass vacuously.
          written.push({ table, op: 'update', values, filters: applied });
          const run = () => {
            const moved = state.updateMoves === false ? [] : matches();
            // The conditional update's own effect, so a second pass in the same
            // test genuinely matches nothing rather than being told not to.
            for (const row of moved) Object.assign(row, values as Record<string, unknown>);
            return { data: moved, error: null };
          };
          return Object.assign(b, {
            select: () => ({
              then: (resolve: (v: unknown) => unknown) => resolve(run()),
            }),
            then: (resolve: (v: unknown) => unknown) => resolve(run()),
          });
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
      });
      return b;
    },
  } as never;
}

function deps(over: Partial<{ maxPerPass: number }> = {}) {
  return { admin: admin(), maxPerPass: 5, log, ...over };
}

function aHold(over: Record<string, unknown> = {}) {
  return {
    id: HOLD,
    task_id: TASK,
    project_id: PROJECT,
    amount: '500.00',
    currency: 'USD',
    state: 'held',
    ...over,
  };
}

beforeEach(() => {
  written = [];
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  tables = {
    escrow_holds: { rows: [aHold()] },
    tasks: { rows: [{ id: TASK, title: 'Write the launch emails', state: 'cancelled' }] },
    engagements: {
      rows: [{ id: ENGAGEMENT, task_id: TASK, node_id: NODE, ended_at: null, outcome: null }],
    },
    threads: { rows: [{ id: THREAD, task_id: TASK, room_id: ROOM }] },
    room_members: {
      rows: [
        { room_id: ROOM, user_id: NODE, thread_id: THREAD, scope: 'thread', expires_at: null },
      ],
    },
    ledger_entries: { rows: [] },
    messages: { rows: [] },
    projects: { rows: [{ id: PROJECT, source_embed_id: 'embed-1' }] },
    action_embeds: { rows: [{ id: 'embed-1', room_id: ROOM }] },
  };
});

describe('what qualifies', () => {
  it('refunds a hold on a cancelled step', async () => {
    const result = await escrowReconcileSweep(deps());

    expect(result.refunded).toBe(1);
    const update = written.find((w) => w.table === 'escrow_holds' && w.op === 'update');
    expect((update?.values as Record<string, unknown>).state).toBe('refunded');
    // Conditional on the state it read, so two overlapping passes cannot both win.
    expect(update?.filters.state).toBe('held');
  });

  it('leaves a hold on a step that is still running', async () => {
    tables.tasks.rows = [{ id: TASK, title: 'Work', state: 'escrow_funded' }];

    const result = await escrowReconcileSweep(deps());

    expect(result.refunded).toBe(0);
    expect(written).toHaveLength(0);
  });

  it('never refunds a step that reached done', async () => {
    // The most consequential assertion in the file. `done` means approved, and
    // refunding approved work would take back money a person earned. That hold
    // is the payout slice's to release.
    tables.tasks.rows = [{ id: TASK, title: 'Work', state: 'done' }];

    const result = await escrowReconcileSweep(deps());

    expect(result.refunded).toBe(0);
    expect(written).toHaveLength(0);
  });

  it('leaves a hold that is already settled', async () => {
    tables.escrow_holds.rows = [aHold({ state: 'refunded' })];

    const result = await escrowReconcileSweep(deps());

    expect(result.refunded).toBe(0);
  });

  it('bounds refunds performed rather than holds read', async () => {
    tables.escrow_holds.rows = [
      aHold({ id: 'h1', task_id: 't1' }),
      aHold({ id: 'h2', task_id: 't2' }),
      aHold({ id: 'h3', task_id: 't3' }),
    ];
    tables.tasks.rows = [
      { id: 't1', title: 'One', state: 'cancelled' },
      { id: 't2', title: 'Two', state: 'cancelled' },
      { id: 't3', title: 'Three', state: 'cancelled' },
    ];
    tables.engagements.rows = [];
    tables.threads.rows = [];

    const result = await escrowReconcileSweep(deps({ maxPerPass: 2 }));

    expect(result.refunded).toBe(2);
  });
});

describe('the reversal', () => {
  it('writes a balanced pair against the hold', async () => {
    await escrowReconcileSweep(deps());

    const insert = written.find((w) => w.table === 'ledger_entries');
    const rows = insert?.values as {
      account: string;
      debit: number;
      credit: number;
      currency: string;
      ref_type: string;
      ref_id: string;
    }[];

    expect(rows).toHaveLength(2);
    expect(
      entriesBalance(
        rows.map((r) => ({
          account: r.account,
          debit: r.debit,
          credit: r.credit,
          currency: r.currency,
          refType: r.ref_type,
          refId: r.ref_id,
        })),
      ),
    ).toBe(true);
    // Sharing the hold's reference is what makes the hold and its reversal
    // readable together as a settled pair.
    expect(rows.every((r) => r.ref_id === HOLD)).toBe(true);
  });

  it('converts the amount from the string PostgREST returns', async () => {
    await escrowReconcileSweep(deps());

    const rows = written.find((w) => w.table === 'ledger_entries')?.values as { debit: number }[];
    expect(rows.some((r) => r.debit === 500)).toBe(true);
  });
});

describe('what else unwinds', () => {
  it('ends the engagement as cancelled, through the write-once guard', async () => {
    const result = await escrowReconcileSweep(deps());

    expect(result.ended).toBe(1);
    const update = written.find((w) => w.table === 'engagements');
    expect((update?.values as Record<string, unknown>).outcome).toBe('cancelled');
    // Conditional on it still being live, so a replay writes nothing and the
    // guard is never asked to refuse an update we should not have made.
    expect(update?.filters['is:ended_at']).toBeNull();
  });

  it('revokes the membership for this thread and not for the person', async () => {
    // A node can hold memberships in other rooms for other steps. Keying the
    // revocation on the person would cut them out of work that is still running.
    const result = await escrowReconcileSweep(deps());

    expect(result.revoked).toBe(1);
    const update = written.find((w) => w.table === 'room_members');
    expect(update?.filters.thread_id).toBe(THREAD);
    expect(update?.filters.user_id).toBe(NODE);
    expect((update?.values as Record<string, unknown>).expires_at).toBeTruthy();
  });

  it('tells the owner once, keyed on the hold', async () => {
    await escrowReconcileSweep(deps());

    const message = written.find((w) => w.table === 'messages');
    const values = message?.values as Record<string, unknown>;
    expect(values.room_id).toBe(ROOM);
    expect(values.idempotency_key).toBe(refundKey(HOLD));
    expect(String(values.body)).toContain('500');
    // Rule 22, on a sentence that reaches a person on a money surface.
    expect(String(values.body)).not.toContain('—');
  });

  it('says so rather than failing when the project has no room', async () => {
    tables.projects.rows = [{ id: PROJECT, source_embed_id: null }];

    const result = await escrowReconcileSweep(deps());

    // The money is still given back. A room that cannot be found is a missing
    // announcement, not a reason to leave a ceiling pinned.
    expect(result.refunded).toBe(1);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('a second pass', () => {
  it('performs nothing at all', async () => {
    await escrowReconcileSweep(deps());
    written = [];

    const result = await escrowReconcileSweep(deps());

    expect(result.refunded).toBe(0);
    expect(result.ended).toBe(0);
    expect(result.revoked).toBe(0);
    expect(written).toHaveLength(0);
  });
});
