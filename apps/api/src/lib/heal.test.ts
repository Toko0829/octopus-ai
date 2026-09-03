/**
 * The sweep that finishes what a dead executor left at `approved`, and the
 * properties whose violation is either a stranded step or a stolen one.
 *
 * What is pinned here:
 *
 *   1. **A stranded AI step is walked `approved -> done` conditionally, and its
 *      artifact is delivered**, in that order, with an event that says it was a
 *      recovery rather than a normal finish.
 *   2. **A human step at `approved` is never read.** That state is the payout
 *      authorisation there, and the selection is on `owner_type` so the sweep
 *      cannot take a step out from under the payout sweep.
 *   3. **A campaign step is left alone**, because approved is where its
 *      campaign's own lifecycle begins, not where the step ends.
 *   4. **A step inside the grace window is left alone**, so the sweep cannot
 *      race the executor's own second write.
 *   5. **Losing the race delivers nothing.** If the conditional write misses,
 *      the step was cancelled or finished by somebody else, and announcing the
 *      artifact would say otherwise.
 *   6. **A stranded step with no artifact is finished and not delivered**,
 *      loudly.
 *   7. **`maxPerPass` bounds steps finished**, oldest first, and a failure on
 *      one step does not stop the pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const PROJECT = 'p1';
const ROOM = 'r1';

/**
 * The artifact card's payload is validated before it is stored and wants real
 * uuids, so short names map to fixed ones here and stay readable in the tests.
 */
const IDS: Record<string, string> = {
  t1: '00000000-0000-4000-8000-0000000000a1',
  h1: '00000000-0000-4000-8000-0000000000b1',
  u1: '00000000-0000-4000-8000-0000000000b2',
  c1: '00000000-0000-4000-8000-0000000000c1',
  f1: '00000000-0000-4000-8000-0000000000f1',
  newer: '00000000-0000-4000-8000-0000000000d1',
  oldest: '00000000-0000-4000-8000-0000000000d2',
  middle: '00000000-0000-4000-8000-0000000000d3',
  bad: '00000000-0000-4000-8000-0000000000e1',
  good: '00000000-0000-4000-8000-0000000000e2',
};
const uuid = (name: string) => IDS[name] ?? name;
const artifactUuid = (name: string) => uuid(name).replace(/-8000-/, '-8001-');

const NOW = new Date('2026-09-11T12:00:00Z');
/** Comfortably past the five-minute grace window. */
const OLD = '2026-09-11T11:00:00Z';
const OLDER = '2026-09-11T10:00:00Z';
/** Approved a minute ago: the executor may still be between its two writes. */
const FRESH = '2026-09-11T11:59:00Z';

interface TableState {
  rows: Record<string, unknown>[];
}

interface Tables {
  tasks: TableState;
  campaigns: TableState;
  artifacts: TableState;
  events: TableState;
  messages: TableState;
  action_embeds: TableState;
}

let tables: Tables;
let written: { table: string; op: string; values?: Record<string, unknown>; on: string[] }[];
/** Set to make the `tasks` update throw, which is a failure on one step. */
let failTaskUpdateFor: string | null;
let log: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

vi.mock('./room-for-project', () => ({
  roomForProject: async () => ROOM,
}));

const { healSweep, HEAL_GRACE_MS } = await import('./heal');

type Filter = { col: string; kind: 'eq' | 'in' | 'lt'; val: unknown };

function admin() {
  return {
    from(table: string) {
      const state = tables[table as keyof Tables] ?? { rows: [] };
      const filters: Filter[] = [];
      let limitTo: number | null = null;
      let orderBy: { col: string; asc: boolean } | null = null;
      const b: Record<string, unknown> = {};

      const matches = () => {
        let hit = state.rows.filter((row) =>
          filters.every((f) => {
            if (f.kind === 'eq') return row[f.col] === f.val;
            if (f.kind === 'in') return (f.val as unknown[]).includes(row[f.col]);
            return String(row[f.col]) < String(f.val);
          }),
        );
        if (orderBy) {
          const { col, asc } = orderBy;
          hit = [...hit].sort((a, b2) =>
            String(a[col]) < String(b2[col]) ? (asc ? -1 : 1) : asc ? 1 : -1,
          );
        }
        if (limitTo !== null) hit = hit.slice(0, limitTo);
        return hit;
      };

      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          filters.push({ col, kind: 'eq', val });
          return b;
        },
        in: (col: string, val: unknown[]) => {
          filters.push({ col, kind: 'in', val });
          return b;
        },
        lt: (col: string, val: unknown) => {
          filters.push({ col, kind: 'lt', val });
          return b;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderBy = { col, asc: opts?.ascending !== false };
          return b;
        },
        limit: (n: number) => {
          limitTo = n;
          return b;
        },
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
        update: (values: Record<string, unknown>) => {
          // Applied at the end of the chain, after every `.eq` has been declared,
          // or the conditional write could never miss.
          const entry: (typeof written)[number] = { table, op: 'update', values, on: [] };
          written.push(entry);
          const apply = () => {
            entry.on = filters.map((f) => f.col);
            const hit = matches();
            const id = filters.find((f) => f.col === 'id')?.val;
            if (table === 'tasks' && failTaskUpdateFor && id === failTaskUpdateFor) {
              throw Object.assign(new Error('injected'), { code: 'XX000' });
            }
            for (const row of hit) Object.assign(row, values);
            return hit;
          };
          return Object.assign(b, {
            select: () =>
              Object.assign(b, {
                maybeSingle: async () => {
                  try {
                    const hit = apply();
                    return { data: hit[0] ?? null, error: null };
                  } catch (err) {
                    return { data: null, error: err };
                  }
                },
              }),
          });
        },
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values, on: [] });
          const key = values.idempotency_key;
          if (table === 'messages' && state.rows.some((r) => r.idempotency_key === key)) {
            const dup = { data: null, error: { code: '23505', message: 'duplicate' } };
            return Object.assign(b, {
              select: () => Object.assign(b, { maybeSingle: async () => dup }),
              then: (resolve: (v: unknown) => unknown) => resolve(dup),
            });
          }
          const row = { id: `${table}-${state.rows.length + 1}`, ...values };
          state.rows.push(row);
          const ok = { data: row, error: null };
          return Object.assign(b, {
            select: () => Object.assign(b, { maybeSingle: async () => ok }),
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
      });
      return b;
    },
  } as never;
}

function task(name: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: uuid(name),
    project_id: PROJECT,
    title: `Step ${name}`,
    stage: 'content',
    owner_type: 'ai',
    state: 'approved',
    updated_at: OLD,
    ...over,
  };
}

function artifact(name: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id: artifactUuid(name),
    task_id: uuid(name),
    kind: 'draft',
    title: `Draft for ${name}`,
    body: 'A full paragraph of usable draft output for the step, well over the floor.',
    citations: ['Paid ads CPA control'],
    created_at: OLD,
    ...over,
  };
}

function taskState(name: string) {
  return tables.tasks.rows.find((r) => r.id === uuid(name))?.state;
}

function deliveredFor(name: string) {
  return tables.messages.rows.filter((m) => m.idempotency_key === `artifact:${artifactUuid(name)}`);
}

function healedEvents() {
  return tables.events.rows.filter((e) => e.verb === 'task.healed');
}

beforeEach(() => {
  tables = {
    tasks: { rows: [] },
    campaigns: { rows: [] },
    artifacts: { rows: [] },
    events: { rows: [] },
    messages: { rows: [] },
    action_embeds: { rows: [] },
  };
  written = [];
  failTaskUpdateFor = null;
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

function run(maxPerPass = 3) {
  return healSweep({ admin: admin(), maxPerPass, now: () => NOW, log });
}

describe('a stranded AI step', () => {
  it('is walked approved -> done conditionally, then delivered, with a healed event', async () => {
    tables.tasks.rows.push(task('t1'));
    tables.artifacts.rows.push(artifact('t1'));

    const report = await run();

    expect(report).toMatchObject({ examined: 1, healed: 1, raced: 0, failed: 0 });
    expect(taskState('t1')).toBe('done');

    const move = written.find((w) => w.table === 'tasks' && w.op === 'update');
    expect(move?.values).toEqual({ state: 'done' });
    expect(move?.on).toEqual(['id', 'state']);

    const healed = healedEvents();
    expect(healed).toHaveLength(1);
    expect(healed[0]?.payload).toMatchObject({
      from: 'approved',
      to: 'done',
      artifactId: artifactUuid('t1'),
    });
    expect(healed[0]?.actor_kind).toBe('system');

    expect(deliveredFor('t1')).toHaveLength(1);
    expect(tables.action_embeds.rows).toHaveLength(1);
    expect(tables.action_embeds.rows[0]).toMatchObject({
      component: 'artifact',
      state: 'reported',
    });

    // Order: the step is finished before the room hears about it.
    const order = written.map((w) => `${w.table}:${w.op}`);
    expect(order.indexOf('tasks:update')).toBeLessThan(order.indexOf('messages:insert'));
  });

  it('is not announced twice when the artifact already reached the room', async () => {
    tables.tasks.rows.push(task('t1'));
    tables.artifacts.rows.push(artifact('t1'));
    tables.messages.rows.push({ id: 'm-old', idempotency_key: `artifact:${artifactUuid('t1')}` });

    const report = await run();

    expect(report.healed).toBe(1);
    expect(taskState('t1')).toBe('done');
    expect(deliveredFor('t1')).toHaveLength(1);
    expect(tables.action_embeds.rows).toHaveLength(0);
  });

  it('with no artifact is finished, not delivered, and warned about by name', async () => {
    tables.tasks.rows.push(task('t1'));

    const report = await run();

    expect(report.healed).toBe(1);
    expect(taskState('t1')).toBe('done');
    expect(tables.messages.rows).toHaveLength(0);
    expect(healedEvents()[0]?.payload).toMatchObject({ artifactId: null });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: uuid('t1') }),
      expect.stringContaining('no artifact'),
    );
  });
});

describe('what is not a stranded step', () => {
  it('never reads a human step at approved, which is the payout authorisation', async () => {
    tables.tasks.rows.push(task('h1', { owner_type: 'human' }));
    tables.tasks.rows.push(task('u1', { owner_type: 'user' }));

    const report = await run();

    expect(report.examined).toBe(0);
    expect(taskState('h1')).toBe('approved');
    expect(taskState('u1')).toBe('approved');
    expect(written.filter((w) => w.op === 'update')).toHaveLength(0);
  });

  it('leaves a campaign step alone, and counts it', async () => {
    tables.tasks.rows.push(task('c1'));
    tables.campaigns.rows.push({ id: 'camp1', task_id: uuid('c1') });

    const report = await run();

    expect(report).toMatchObject({ examined: 1, campaigns: 1, healed: 0 });
    expect(taskState('c1')).toBe('approved');
    expect(written.filter((w) => w.op === 'update')).toHaveLength(0);
  });

  it('leaves a step inside the grace window alone', async () => {
    tables.tasks.rows.push(task('f1', { updated_at: FRESH }));
    tables.artifacts.rows.push(artifact('f1'));

    const report = await run();

    expect(report.examined).toBe(0);
    expect(taskState('f1')).toBe('approved');
    expect(HEAL_GRACE_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('reads nothing at all when the cap is zero', async () => {
    tables.tasks.rows.push(task('t1'));
    const report = await run(0);
    expect(report.examined).toBe(0);
    expect(written).toHaveLength(0);
  });
});

describe('the race and the bound', () => {
  it('delivers nothing when the conditional write misses', async () => {
    // Listed as approved at read time, cancelled by the time the write lands:
    // the fake applies filters at the end of the chain, so flipping the row
    // between the read and the update is exactly a replan winning the race.
    const row = task('t1');
    tables.tasks.rows.push(row);
    tables.artifacts.rows.push(artifact('t1'));
    const original = admin();
    const racing = {
      from(table: string) {
        if (table === 'artifacts') row.state = 'cancelled';
        return (original as { from: (t: string) => unknown }).from(table);
      },
    } as never;

    const report = await healSweep({ admin: racing, maxPerPass: 3, now: () => NOW, log });

    expect(report).toMatchObject({ healed: 0, raced: 1 });
    expect(taskState('t1')).toBe('cancelled');
    expect(tables.messages.rows).toHaveLength(0);
    expect(healedEvents()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: uuid('t1') }),
      expect.stringContaining('moved before'),
    );
  });

  it('finishes at most maxPerPass steps, oldest first', async () => {
    tables.tasks.rows.push(task('newer', { updated_at: OLD }));
    tables.tasks.rows.push(task('oldest', { updated_at: OLDER }));
    tables.tasks.rows.push(task('middle', { updated_at: '2026-09-11T10:30:00Z' }));
    for (const id of ['newer', 'oldest', 'middle']) tables.artifacts.rows.push(artifact(id));

    const report = await run(2);

    expect(report.healed).toBe(2);
    expect(taskState('oldest')).toBe('done');
    expect(taskState('middle')).toBe('done');
    expect(taskState('newer')).toBe('approved');
  });

  it('does not count a skipped campaign step against the cap', async () => {
    tables.tasks.rows.push(task('c1', { updated_at: OLDER }));
    tables.campaigns.rows.push({ id: 'camp1', task_id: uuid('c1') });
    tables.tasks.rows.push(task('t1'));
    tables.artifacts.rows.push(artifact('t1'));

    const report = await run(1);

    expect(report).toMatchObject({ campaigns: 1, healed: 1 });
    expect(taskState('t1')).toBe('done');
  });

  it('a failure on one step is logged and does not stop the pass', async () => {
    tables.tasks.rows.push(task('bad', { updated_at: OLDER }));
    tables.tasks.rows.push(task('good'));
    for (const id of ['bad', 'good']) tables.artifacts.rows.push(artifact(id));
    failTaskUpdateFor = uuid('bad');

    const report = await run();

    expect(report).toMatchObject({ healed: 1, failed: 1 });
    expect(taskState('bad')).toBe('approved');
    expect(taskState('good')).toBe('done');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: uuid('bad') }),
      'could not heal a stranded step',
    );
  });
});
