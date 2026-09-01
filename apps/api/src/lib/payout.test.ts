/**
 * The sweep that pays an expert, and the properties whose violation is money.
 *
 * What is pinned here:
 *
 *   1. **The counsel gate's enforced half.** A provider that moves real money
 *      stops the pass before a single row is read, and the refusal is loud. This
 *      is the only test in the repository standing directly in front of
 *      payments-billing.md's regulatory gate.
 *   2. **Each of the four crash points resumes**, and none of them double-pays:
 *      the task move, the payout insert, the transfer, and the settlement each
 *      re-enter cleanly on the next pass.
 *   3. **No held hold, no payout.** The reconcile or no-show sweep may have given
 *      the money back, and paying against a refunded hold would spend the owner's
 *      ceiling twice.
 *   4. **A step nobody is owed for is never touched** — AI work and work the
 *      owner did themselves have no engagement and no hold, and the sweep reaches
 *      that conclusion without ever asking whose step it is.
 *   5. **`maxPerPass` bounds payouts performed**, not engagements examined.
 *   6. **A failure on one payout does not stop the pass**, and is never swallowed
 *      (rule 16): this is somebody's fee for work already approved.
 *   7. **The message comes after the settlement**, keyed on the engagement, so a
 *      crash between them cannot produce a second announcement.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeTransferId, payoutKey } from '@octopus/payments';
import { payoutSweep } from './payout';

const ENGAGEMENT = 'e1';
const TASK = 't1';
const PROJECT = 'p1';
const NODE = 'n1';
const HOLD = 'h1';
const PAYOUT = 'po1';
const ROOM = 'r1';
const EMBED = 'em1';

const KEY = payoutKey(ENGAGEMENT);

interface TableState {
  rows: Record<string, unknown>[];
}

/** Named rather than a Record, so a fixture assignment is checked. */
interface Tables {
  engagements: TableState;
  tasks: TableState;
  escrow_holds: TableState;
  payouts: TableState;
  messages: TableState;
  projects: TableState;
  action_embeds: TableState;
}

let tables: Tables;
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let rpcError: { message: string } | null;
/** Set to make the `payouts` insert collide, which is crash point 2 resuming. */
let payoutInsertError: { code: string } | null;
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

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
        in: (column: string, value: unknown) => {
          applied[`in:${column}`] = value;
          return b;
        },
        order: () => b,
        limit: async () => ({ data: matches(), error: null }),
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          const hit = matches();
          for (const row of hit) Object.assign(row, values);
          return Object.assign(b, {
            select: () => ({
              then: (resolve: (v: unknown) => unknown) => resolve({ data: hit, error: null }),
            }),
          });
        },
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          const failure = table === 'payouts' ? payoutInsertError : null;
          if (!failure) state.rows.push({ id: PAYOUT, state: 'pending', ...values });
          return Object.assign(b, {
            select: () =>
              Object.assign(b, {
                single: async () => ({
                  data: failure ? null : { id: PAYOUT, state: 'pending', transfer_id: null },
                  error: failure,
                }),
              }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: failure }),
          });
        },
        single: async () => ({ data: matches()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (!rpcError) {
        // What `settle_payout` durably does, as far as a later pass can see it.
        for (const row of tables.payouts.rows) {
          if (row.id === args.p_payout_id) {
            row.state = 'paid';
            row.transfer_id = args.p_transfer_id;
          }
        }
        for (const row of tables.escrow_holds.rows) {
          if (row.task_id === TASK) row.state = 'released';
        }
        for (const row of tables.engagements.rows) {
          if (row.id === ENGAGEMENT) {
            row.ended_at = '2026-09-07T12:00:00.000Z';
            row.outcome = 'completed';
          }
        }
        for (const row of tables.tasks.rows) {
          if (row.id === TASK) row.state = 'done';
        }
      }
      return { data: null, error: rpcError };
    },
  };
}

function deps(over: { maxPerPass?: number; provider?: string } = {}) {
  return {
    admin: admin() as never,
    maxPerPass: over.maxPerPass ?? 3,
    ...(over.provider ? { provider: over.provider } : {}),
    log,
  };
}

function anEngagement(over: Record<string, unknown> = {}) {
  return {
    id: ENGAGEMENT,
    task_id: TASK,
    project_id: PROJECT,
    node_id: NODE,
    agreed_price: 400,
    currency: 'USD',
    accepted_at: '2026-09-01T12:00:00.000Z',
    ended_at: null,
    outcome: null,
    ...over,
  };
}

function aTask(over: Record<string, unknown> = {}) {
  return { id: TASK, state: 'approved', title: 'Shoot the launch video', ...over };
}

function aHold(over: Record<string, unknown> = {}) {
  return { id: HOLD, task_id: TASK, state: 'held', amount: 400, currency: 'USD', ...over };
}

beforeEach(() => {
  written = [];
  rpcCalls = [];
  rpcError = null;
  payoutInsertError = null;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  tables = {
    engagements: { rows: [anEngagement()] },
    tasks: { rows: [aTask()] },
    escrow_holds: { rows: [aHold()] },
    payouts: { rows: [] },
    messages: { rows: [] },
    // `roomForProject` resolves a project to its room through the plan card it
    // was materialised from. The fixture carries both hops or the announcement
    // half of this sweep is never exercised.
    projects: { rows: [{ id: PROJECT, source_embed_id: EMBED }] },
    action_embeds: { rows: [{ id: EMBED, room_id: ROOM }] },
  };
});

describe('paying an expert for a step the owner approved', () => {
  it('moves the step, records the intent, transfers, and settles', async () => {
    const result = await payoutSweep(deps());

    expect(result.paid).toBe(1);

    // The intent, before the call. ADR-0013's ordering.
    const moved = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect(moved?.values).toEqual({ state: 'payout_pending' });

    const inserted = written.find((w) => w.table === 'payouts' && w.op === 'insert');
    expect(inserted?.values).toMatchObject({
      engagement_id: ENGAGEMENT,
      node_id: NODE,
      task_id: TASK,
      amount: 400,
      currency: 'USD',
      idempotency_key: KEY,
    });

    expect(rpcCalls).toEqual([
      { name: 'settle_payout', args: { p_payout_id: PAYOUT, p_transfer_id: fakeTransferId(KEY) } },
    ]);
  });

  it('retains nothing, because the offer never named a fee', async () => {
    // ADR-0024. Escrow holds exactly the price the node was shown before they
    // accepted, so a cut taken here would change what somebody agreed to after
    // they agreed to it. If a take rate ever lands, it lands on the offer first
    // and this assertion is what will fail.
    await payoutSweep(deps());

    const inserted = written.find((w) => w.table === 'payouts' && w.op === 'insert');
    expect(inserted?.values?.platform_fee).toBe(0);
    expect(inserted?.values?.amount).toBe(400);
  });

  it('pays the amount on the hold rather than the price on the deal', async () => {
    // They are equal in this build and reading the hold is what keeps that an
    // equality rather than an assumption: the hold is what is actually being
    // released, and the ledger pair is written against it.
    tables.escrow_holds.rows = [aHold({ amount: 250 })];

    await payoutSweep(deps());

    const inserted = written.find((w) => w.table === 'payouts' && w.op === 'insert');
    expect(inserted?.values?.amount).toBe(250);
  });

  it('tells the owner the money left escrow, keyed so it is said once', async () => {
    await payoutSweep(deps());

    const message = written.find((w) => w.table === 'messages');
    expect(message?.values?.idempotency_key).toBe(KEY);
    expect(String(message?.values?.body)).toContain('400.00 USD');
    expect(String(message?.values?.body)).toContain('Shoot the launch video');
  });

  it('finishes a step the sweep had already moved to payout_pending', async () => {
    // Crash point 1 resuming. The conditional move matches nothing, and the pass
    // must read on rather than return: the earlier pass may have died before the
    // transfer, and this one can finish it.
    tables.tasks.rows = [aTask({ state: 'payout_pending' })];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(1);
    expect(rpcCalls).toHaveLength(1);
  });
});

describe('the counsel gate', () => {
  it('has exactly one registered provider, and it moves no money', async () => {
    // The premise every assertion below rests on. Adding a second entry is a
    // reviewed change to a checked-in file, which is the whole reason the
    // registry is a file rather than a table — and it is what would make the
    // refusal below reachable for a real provider.
    const { PAYMENT_PROVIDER_REGISTRY, carriesRealMoney } = await import('@octopus/payments');

    expect(Object.keys(PAYMENT_PROVIDER_REGISTRY)).toEqual(['fake']);
    expect(carriesRealMoney('fake')).toBe(false);
  });

  it('refuses a provider it has never heard of rather than assuming it is harmless', async () => {
    // The inversion `carriesRealMoney` was written for: "a provider we have
    // never heard of certainly moves no money" is the assumption that would let
    // an unreviewed integration straight through the one check standing in front
    // of payments-billing.md's regulatory gate. Unknown means refused.
    await expect(payoutSweep(deps({ provider: 'stripe' }))).rejects.toThrow(/stripe/i);
  });

  it('refuses before reading or moving anything', async () => {
    // A refused pass must be inert rather than half-done: no task leaves
    // `approved`, no payout row exists, and nothing is announced.
    await expect(payoutSweep(deps({ provider: 'stripe' }))).rejects.toThrow();

    expect(written).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(tables.tasks.rows[0]!.state).toBe('approved');
  });
});

describe('what the sweep refuses to pay', () => {
  it('skips a step whose hold was already refunded', async () => {
    // The reconcile or no-show sweep got there first, so the money is back with
    // the owner. Paying now would spend their ceiling twice.
    tables.escrow_holds.rows = [aHold({ state: 'refunded' })];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('skips a step with no hold at all', async () => {
    tables.escrow_holds.rows = [];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(written).toEqual([]);
  });

  it('never touches AI work or work the owner did themselves', async () => {
    // Neither has an engagement, so neither is read at all — and the sweep
    // reaches that without a single test on `owner_type`. The money is what
    // decides who is owed, which is the one definition the ledger already holds.
    tables.engagements.rows = [];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(written).toEqual([]);
  });

  it('leaves a step that is still being worked on', async () => {
    tables.tasks.rows = [aTask({ state: 'in_progress' })];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(written).toEqual([]);
  });

  it('leaves a step that was already paid', async () => {
    tables.tasks.rows = [aTask({ state: 'done' })];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(rpcCalls).toEqual([]);
  });
});

describe('resuming', () => {
  it('reads back its own payout row rather than starting a second one', async () => {
    // Crash point 2. The unique key collides, and a collision is the mechanism.
    payoutInsertError = { code: '23505' };
    tables.payouts.rows = [
      { id: PAYOUT, state: 'pending', transfer_id: null, idempotency_key: KEY, task_id: TASK },
    ];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(1);
    expect(rpcCalls).toEqual([
      { name: 'settle_payout', args: { p_payout_id: PAYOUT, p_transfer_id: fakeTransferId(KEY) } },
    ]);
  });

  it('skips the transfer when one is already recorded', async () => {
    // Crash point 3. A second transfer for the same work is the one failure this
    // ordering exists to prevent.
    payoutInsertError = { code: '23505' };
    tables.payouts.rows = [
      {
        id: PAYOUT,
        state: 'pending',
        transfer_id: 'tr_fake_already',
        idempotency_key: KEY,
        task_id: TASK,
      },
    ];

    await payoutSweep(deps());

    expect(rpcCalls).toEqual([
      { name: 'settle_payout', args: { p_payout_id: PAYOUT, p_transfer_id: 'tr_fake_already' } },
    ]);
  });

  it('does nothing at all for a payout that already settled', async () => {
    // Crash point 4, and the one that could otherwise double-write: a settled
    // payout is read back and returned before anything else runs.
    payoutInsertError = { code: '23505' };
    tables.payouts.rows = [
      {
        id: PAYOUT,
        state: 'paid',
        transfer_id: 'tr_fake_done',
        idempotency_key: KEY,
        task_id: TASK,
      },
    ];

    await payoutSweep(deps());

    expect(rpcCalls).toEqual([]);
    expect(written.some((w) => w.table === 'messages')).toBe(false);
  });

  it('does not pay twice when the same fixture is swept twice', async () => {
    await payoutSweep(deps());
    written = [];
    rpcCalls = [];

    const second = await payoutSweep(deps());

    expect(second.paid).toBe(0);
    expect(rpcCalls).toEqual([]);
  });
});

describe('bounds and failures', () => {
  it('bounds payouts performed rather than engagements examined', async () => {
    tables.engagements.rows = [
      anEngagement({ id: 'e1', task_id: 't1' }),
      anEngagement({ id: 'e2', task_id: 't2' }),
      anEngagement({ id: 'e3', task_id: 't3' }),
    ];
    tables.tasks.rows = [
      aTask({ id: 't1' }),
      aTask({ id: 't2', title: 'Write the launch email' }),
      aTask({ id: 't3', title: 'Set up the landing page' }),
    ];
    tables.escrow_holds.rows = [
      aHold({ id: 'h1', task_id: 't1' }),
      aHold({ id: 'h2', task_id: 't2' }),
      aHold({ id: 'h3', task_id: 't3' }),
    ];

    const result = await payoutSweep(deps({ maxPerPass: 2 }));

    expect(result.paid).toBe(2);
  });

  it('carries on past one payout it cannot make, and never swallows it', async () => {
    rpcError = { message: 'escrow hold stopped being held while it was being released' };

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(0);
    expect(result.waiting).toBe(1);
    expect(log.error).toHaveBeenCalled();
  });

  it('refuses an amount nobody can reason about rather than paying it', async () => {
    // `numeric(12,2)` arrives as a string over PostgREST, and a value that is not
    // a number must stop the payout rather than reach arithmetic. A silent
    // arithmetic failure on money is the worst available outcome.
    tables.escrow_holds.rows = [aHold({ amount: 'not-a-number' })];

    const result = await payoutSweep(deps());

    expect(result.waiting).toBe(1);
    expect(rpcCalls).toEqual([]);
    expect(log.error).toHaveBeenCalled();
  });

  it('still settles when the project has no room to announce it in', async () => {
    // The money is the act; the message is the announcement. Losing the second
    // must not undo the first, and the gap is warned about rather than silent.
    tables.projects.rows = [];

    const result = await payoutSweep(deps());

    expect(result.paid).toBe(1);
    expect(rpcCalls).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });
});
