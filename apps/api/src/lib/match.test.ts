import { beforeEach, describe, expect, it, vi } from 'vitest';
import { matcherSweep } from './match';

/**
 * The sweep, against a stubbed database.
 *
 * What is worth pinning here is not that it inserts a row. It is the set of
 * properties that keep a cascade from going wrong in ways nobody would notice
 * until a node complained:
 *
 * 1. An exhausted pool sends the step back to its owner rather than failing it,
 *    and says so once per return.
 * 2. A crashed pass that inserted an offer and died finishes the move on retry
 *    instead of opening a second offer.
 * 3. A task that left the market underneath an open offer has that offer
 *    withdrawn.
 * 4. Every task move is conditional, so the owner taking the step wins the race.
 * 5. `maxPerPass` bounds offers created, not rows read.
 * 6. A rate arriving as a string is parsed before ranking, because a string sort
 *    puts "9.00" above "10.00".
 */

interface TableState {
  rows: Record<string, unknown>[];
  /** Rows a conditional update should report as moved. Defaults to all matched. */
  updateMoves?: boolean;
  insertError?: { code: string } | null;
}

/** Named rather than a Record, so a fixture assignment is checked. */
interface Tables {
  tasks: TableState;
  offers: TableState;
  node_skills: TableState;
  node_profiles: TableState;
  events: TableState;
  messages: TableState;
  rooms: TableState;
  projects: TableState;
  action_embeds: TableState;
}

let tables: Tables;
let written: { table: string; op: string; values?: unknown; filters: Record<string, unknown> }[];
let eventCount: number;
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const NOW = new Date('2026-09-10T12:00:00.000Z');
const TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';

function admin() {
  return {
    from(table: string) {
      const state: TableState = tables[table as keyof Tables] ?? { rows: [] };
      const applied: Record<string, unknown> = {};
      let op = 'select';
      let values: unknown;

      const matches = () =>
        state.rows.filter((row) =>
          Object.entries(applied).every(([col, val]) => {
            if (col.startsWith('not:')) return row[col.slice(4)] !== null;
            if (col.startsWith('gt:')) return String(row[col.slice(3)]) > String(val);
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
        in: (column: string, value: unknown[]) => {
          applied[`in:${column}`] = value;
          return b;
        },
        not: (column: string) => {
          applied[`not:${column}`] = true;
          return b;
        },
        gt: (column: string, value: unknown) => {
          applied[`gt:${column}`] = value;
          return b;
        },
        order: () => b,
        limit: () => b,
        insert: (v: Record<string, unknown>) => {
          op = 'insert';
          values = v;
          written.push({ table, op, values: v, filters: { ...applied } });
          if (table === 'events') eventCount += 1;
          if (state.insertError) {
            return Object.assign(b, {
              select: () => b,
              maybeSingle: async () => ({ data: null, error: state.insertError }),
              then: (resolve: (x: unknown) => unknown) =>
                resolve({ data: null, error: state.insertError }),
            });
          }
          const created = { id: `offer-${state.rows.length + 1}`, ...v };
          state.rows.push(created);
          return Object.assign(b, {
            select: () => b,
            maybeSingle: async () => ({ data: created, error: null }),
            then: (resolve: (x: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (v: Record<string, unknown>) => {
          op = 'update';
          values = v;
          return Object.assign(b, {
            select: () => {
              const hit = state.updateMoves === false ? [] : matches();
              written.push({ table, op, values: v, filters: { ...applied } });
              for (const row of hit) Object.assign(row, v);
              return Object.assign(b, {
                then: (resolve: (x: unknown) => unknown) => resolve({ data: hit, error: null }),
                maybeSingle: async () => ({ data: hit[0] ?? null, error: null }),
              });
            },
            then: (resolve: (x: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (x: unknown) => unknown) => {
          if (op === 'select') {
            const rows = matches();
            // `head: true` count reads resolve with a count instead of data.
            return resolve({ data: rows, error: null, count: rows.length });
          }
          return resolve({ data: null, error: null });
        },
      });
      return b;
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

const aTask = (over: Record<string, unknown> = {}) => ({
  id: TASK,
  project_id: PROJECT,
  title: 'Write the launch emails',
  stage: 'conversion',
  state: 'matching',
  ...over,
});

const aNode = (id: string, rate: unknown, ratePeriod: string = 'task') => ({
  user_id: id,
  rate,
  // Task-rated by default, because the pool filters on it since slice 5: an
  // hourly rate is a price per hour and an escrow hold is a total, so there is
  // no honest way to fund one.
  rate_period: ratePeriod,
  service_jurisdictions: ['US-TX'],
  kyc_status: 'verified',
  availability: 'available',
});

beforeEach(() => {
  written = [];
  eventCount = 0;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  tables = {
    tasks: { rows: [] },
    offers: { rows: [] },
    node_skills: { rows: [] },
    node_profiles: { rows: [] },
    events: { rows: [] },
    messages: { rows: [] },
    rooms: { rows: [] },
    projects: { rows: [] },
    action_embeds: { rows: [] },
  };
});

describe('matcherSweep: offering', () => {
  it('offers the cheapest eligible node and moves the task', async () => {
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [
      { node_id: NODE_A, skill_tag: 'copywriting' },
      { node_id: NODE_B, skill_tag: 'copywriting' },
    ];
    tables.node_profiles.rows = [aNode(NODE_A, 200), aNode(NODE_B, 90)];

    const result = await matcherSweep(deps());

    expect(result.offered).toBe(1);
    const insert = written.find((w) => w.table === 'offers' && w.op === 'insert');
    expect((insert?.values as Record<string, unknown>).node_id).toBe(NODE_B);
    // project_id comes from the task row, never derived later.
    expect((insert?.values as Record<string, unknown>).project_id).toBe(PROJECT);
    // 48 hours out.
    expect((insert?.values as Record<string, unknown>).expires_at).toBe('2026-09-12T12:00:00.000Z');

    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect((move?.values as Record<string, unknown>).state).toBe('offered');
    // Conditional on the state it read, so the owner taking the step wins.
    expect(move?.filters.state).toBe('matching');
  });

  it('parses a rate that arrives as a string, so 9 does not outrank 10', async () => {
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [
      { node_id: NODE_A, skill_tag: 'copywriting' },
      { node_id: NODE_B, skill_tag: 'copywriting' },
    ];
    // PostgREST stringifies numeric. A string sort would put "9.00" first.
    tables.node_profiles.rows = [aNode(NODE_A, '9.00'), aNode(NODE_B, '10.00')];

    await matcherSweep(deps());

    const insert = written.find((w) => w.table === 'offers' && w.op === 'insert');
    expect((insert?.values as Record<string, unknown>).node_id).toBe(NODE_A);
  });

  it('skips nodes that already hold an offer for this task', async () => {
    tables.tasks.rows = [aTask()];
    tables.offers.rows = [
      { id: 'o1', task_id: TASK, node_id: NODE_B, status: 'declined', round: 0 },
    ];
    tables.node_skills.rows = [
      { node_id: NODE_A, skill_tag: 'copywriting' },
      { node_id: NODE_B, skill_tag: 'copywriting' },
    ];
    tables.node_profiles.rows = [aNode(NODE_A, 200), aNode(NODE_B, 90)];

    await matcherSweep(deps());

    const insert = written.find((w) => w.table === 'offers' && w.op === 'insert');
    // NODE_B is cheaper and is skipped, because they already said no.
    expect((insert?.values as Record<string, unknown>).node_id).toBe(NODE_A);
  });

  it('excludes an hourly node from the pool entirely', async () => {
    // Slice 5's filter. An hourly rate is a price per hour and an escrow hold is
    // a total, so there is no hours field to fund one against. Offering the work
    // and then refusing the acceptance would be the dead-end shape this
    // repository keeps recording, so the exclusion is at the pool.
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [
      { node_id: NODE_A, skill_tag: 'copywriting' },
      { node_id: NODE_B, skill_tag: 'copywriting' },
    ];
    // NODE_B is cheaper and is hourly, so the more expensive task-rated node wins.
    tables.node_profiles.rows = [aNode(NODE_A, 200), aNode(NODE_B, 90, 'hour')];

    const result = await matcherSweep(deps());

    expect(result.offered).toBe(1);
    const insert = written.find((w) => w.table === 'offers' && w.op === 'insert');
    expect((insert?.values as Record<string, unknown>).node_id).toBe(NODE_A);
  });

  it('exhausts rather than offering when every candidate is hourly', async () => {
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [{ node_id: NODE_A, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_A, 90, 'hour')];

    const result = await matcherSweep(deps());

    expect(result.offered).toBe(0);
    expect(result.exhausted).toBe(1);
  });

  it('bounds offers created rather than tasks read', async () => {
    tables.tasks.rows = [aTask({ id: 't1' }), aTask({ id: 't2' }), aTask({ id: 't3' })];
    tables.node_skills.rows = [{ node_id: NODE_A, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_A, 90)];

    const result = await matcherSweep(deps({ maxPerPass: 2 }));

    expect(result.offered).toBe(2);
    expect(written.filter((w) => w.table === 'offers' && w.op === 'insert')).toHaveLength(2);
  });
});

describe('matcherSweep: exhaustion', () => {
  it('sends the step back to its owner rather than failing it', async () => {
    tables.tasks.rows = [aTask()];
    // Nobody claims the skill, so the pool is empty.
    tables.node_skills.rows = [];
    tables.rooms.rows = [{ id: 'room-1', project_id: PROJECT }];

    const result = await matcherSweep(deps());

    expect(result.exhausted).toBe(1);
    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    // `escalated`, never `failed`: failed is terminal and would strand work the
    // owner can still do (ADR-0018).
    expect((move?.values as Record<string, unknown>).state).toBe('escalated');
    expect(move?.filters.state).toBe('matching');
  });

  it('refuses a stage it has no skill map for, without inventing a match', async () => {
    tables.tasks.rows = [aTask({ stage: 'formation' })];
    tables.rooms.rows = [{ id: 'room-1', project_id: PROJECT }];

    const result = await matcherSweep(deps());

    expect(result.unmatchable).toBe(1);
    expect(written.some((w) => w.table === 'offers' && w.op === 'insert')).toBe(false);
  });
});

describe('matcherSweep: settling and cascading', () => {
  it('expires an open offer that has run out, and does not cascade in the same pass', async () => {
    tables.tasks.rows = [aTask({ state: 'offered' })];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'open',
        expires_at: '2026-09-09T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.expired).toBe(1);
    expect(result.cascaded).toBe(0);
    const settle = written.find((w) => w.table === 'offers' && w.op === 'update');
    expect((settle?.values as Record<string, unknown>).status).toBe('expired');
    expect(settle?.filters.status).toBe('open');
  });

  it('cascades a task whose offer was declined', async () => {
    tables.tasks.rows = [aTask({ state: 'offered' })];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'declined',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.cascaded).toBe(1);
    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect((move?.values as Record<string, unknown>).state).toBe('matching');
    expect(move?.filters.state).toBe('offered');
  });

  it('leaves a live offer alone', async () => {
    tables.tasks.rows = [aTask({ state: 'offered' })];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'open',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.expired).toBe(0);
    expect(result.cascaded).toBe(0);
    expect(written.some((w) => w.op === 'update')).toBe(false);
  });

  it('withdraws an offer whose task left the market', async () => {
    // The owner cancelled the step, or took it on themselves, while somebody was
    // still deciding. This is `withdrawn`'s only producer.
    tables.tasks.rows = [aTask({ state: 'cancelled' })];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'open',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.withdrawn).toBe(1);
    const settle = written.find((w) => w.table === 'offers' && w.op === 'update');
    expect((settle?.values as Record<string, unknown>).status).toBe('withdrawn');
  });

  it('does not withdraw an open offer whose task is still matching', async () => {
    // The half-finished pass again, from the orphan sweep's side. Withdrawing
    // here would destroy an offer somebody is holding and hand the step back as
    // though nobody wanted it.
    tables.tasks.rows = [aTask({ state: 'matching' })];
    tables.node_skills.rows = [{ node_id: NODE_A, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_A, 90)];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'open',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.withdrawn).toBe(0);
    expect(
      written.some(
        (w) =>
          w.table === 'offers' &&
          w.op === 'update' &&
          (w.values as Record<string, unknown>).status === 'withdrawn',
      ),
    ).toBe(false);
  });

  it('does not guess about a task that is offered with no offer row', async () => {
    tables.tasks.rows = [aTask({ state: 'offered' })];

    const result = await matcherSweep(deps());

    expect(result.waiting).toBe(1);
    expect(written.some((w) => w.table === 'tasks' && w.op === 'update')).toBe(false);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('matcherSweep: replay', () => {
  it('finishes the move when an earlier pass inserted the offer and died', async () => {
    // The crash this test exists for: an offer was created, the process stopped
    // before moving the task, and the task is still in `matching` with an open
    // offer against it. Resuming has to come BEFORE the pool is read, or the
    // skip set excludes the very node holding the offer, a one-node pool reads
    // as exhausted, and the step goes back to its owner while somebody is still
    // holding an offer they were never given a chance to answer.
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [{ node_id: NODE_A, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_A, 90)];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'open',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.replayed).toBe(1);
    expect(result.offered).toBe(1);
    expect(result.exhausted).toBe(0);
    // No second offer for a round that already has one.
    expect(written.some((w) => w.table === 'offers' && w.op === 'insert')).toBe(false);
    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect((move?.values as Record<string, unknown>).state).toBe('offered');
    expect(move?.filters.state).toBe('matching');
  });

  it('does not resurrect a settled offer as a resume', async () => {
    // Only an OPEN prior offer means a half-finished pass. A declined one means
    // the cascade should carry on to the next candidate.
    tables.tasks.rows = [aTask()];
    tables.node_skills.rows = [
      { node_id: NODE_A, skill_tag: 'copywriting' },
      { node_id: NODE_B, skill_tag: 'copywriting' },
    ];
    tables.node_profiles.rows = [aNode(NODE_A, 90), aNode(NODE_B, 200)];
    tables.offers.rows = [
      {
        id: 'o1',
        task_id: TASK,
        project_id: PROJECT,
        node_id: NODE_A,
        round: 0,
        status: 'declined',
        expires_at: '2026-09-30T12:00:00.000Z',
      },
    ];

    const result = await matcherSweep(deps());

    expect(result.replayed).toBe(0);
    expect(result.offered).toBe(1);
    const insert = written.find((w) => w.table === 'offers' && w.op === 'insert');
    expect((insert?.values as Record<string, unknown>).node_id).toBe(NODE_B);
  });

  it('does not write a second offer.created event on a replay of a completed pass', async () => {
    // The task already moved, so the conditional update matches nothing and the
    // event is skipped: `events` has no unique key, and two rows would put two
    // offers in the trail where one was made.
    tables.tasks.rows = [aTask()];
    tables.tasks.updateMoves = false;
    tables.node_skills.rows = [{ node_id: NODE_A, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_A, 90)];

    const result = await matcherSweep(deps());

    expect(result.offered).toBe(0);
    expect(result.waiting).toBe(1);
    expect(eventCount).toBe(0);
  });
});

/**
 * The race with `accept_offer`, from this side.
 *
 * The sweep's header used to say it was the only writer of `tasks.state` in this
 * domain, and slice 5 made that false: acceptance moves the task itself, twice,
 * inside one transaction. What actually keeps the two apart is that every move
 * on both sides is a conditional UPDATE, so a loser performs nothing. These
 * assertions are the sweep's half of that: an accepted pair must be invisible to
 * all three phases, or a cascade would re-offer work somebody is already doing.
 */
describe('matcherSweep: an accepted offer is invisible to every phase', () => {
  const accepted = {
    id: 'o1',
    task_id: TASK,
    project_id: PROJECT,
    node_id: NODE_A,
    round: 0,
    status: 'accepted',
    expires_at: '2026-09-30T12:00:00.000Z',
  };

  it('withdrawOrphans reads only open offers, so it never sees it', async () => {
    // The task is at `escrow_funded`, which is not a market state, so an offer
    // still `open` against it WOULD be withdrawn. It is `accepted`, and the
    // phase filters on status before it looks at the task at all.
    tables.tasks.rows = [aTask({ state: 'escrow_funded' })];
    tables.offers.rows = [accepted];

    const result = await matcherSweep(deps());

    expect(result.withdrawn).toBe(0);
    expect(written.filter((w) => w.table === 'offers' && w.op === 'update')).toHaveLength(0);
  });

  it('settleOffered reads only tasks at offered, so a funded step is not cascaded', async () => {
    tables.tasks.rows = [aTask({ state: 'escrow_funded' })];
    tables.offers.rows = [accepted];

    const result = await matcherSweep(deps());

    expect(result.cascaded).toBe(0);
    expect(result.expired).toBe(0);
    expect(written.filter((w) => w.table === 'tasks' && w.op === 'update')).toHaveLength(0);
  });

  it('offerMatching reads only tasks at matching, so nothing is re-offered', async () => {
    tables.tasks.rows = [aTask({ state: 'claimed' })];
    tables.offers.rows = [accepted];
    tables.node_skills.rows = [{ node_id: NODE_B, skill_tag: 'copywriting' }];
    tables.node_profiles.rows = [aNode(NODE_B, 90)];

    const result = await matcherSweep(deps());

    expect(result.offered).toBe(0);
    expect(written.filter((w) => w.table === 'offers' && w.op === 'insert')).toHaveLength(0);
  });

  it('leaves the whole pass with nothing to say', async () => {
    // The property behind the three above, stated once: a healthy accepted
    // engagement costs the sweep three reads and produces no writes at all.
    tables.tasks.rows = [aTask({ state: 'escrow_funded' })];
    tables.offers.rows = [accepted];

    const result = await matcherSweep(deps());

    expect(result).toMatchObject({
      offered: 0,
      cascaded: 0,
      expired: 0,
      withdrawn: 0,
      exhausted: 0,
      replayed: 0,
      waiting: 0,
    });
    expect(written).toHaveLength(0);
  });
});
