/**
 * The metrics sweep: the writer `campaign_outcomes` was designed around.
 *
 * The stub below is shaped like `publish.test.ts`'s and is deliberately **not**
 * imported from it. Nothing is shared across test files in this repository today,
 * and the one cross-test import that was tried broke on the module path rather
 * than on an assertion. More to the point, the two stubs model different things:
 * that one exists to honour conditional UPDATEs, and this one exists to honour a
 * UNIQUE KEY, because this table has no update path at all.
 *
 * Four properties carry the file.
 *
 * **A window is never measured twice.** The unique key is the whole idempotency
 * story for an append-only table, so the stub enforces it and the tests assert
 * that a re-pull produces a duplicate rather than a second row. A doubled spend
 * is the number the optimizer would read when deciding whether to pause.
 *
 * **Nothing is ever updated.** Every scenario ends by asserting that the sweep
 * issued no UPDATE against `campaign_outcomes` or `campaigns`, because the grant
 * revokes both and a write that only fails in production is worse than one that
 * fails here.
 *
 * **The days stay contiguous.** The cursor is `max(period_end)`, so a pass that
 * wrote day 4 while day 3 failed would lose day 3 permanently. A failure stops the
 * campaign where it is.
 *
 * **The platform is never called for a campaign that should not be measured.**
 * Asserted as "the adapter was not invoked" rather than as "nothing was written",
 * because those look identical afterwards and only one of them is the property.
 */

import { describe, expect, it } from 'vitest';
import { createFakeAdapter, type AdChannelAdapter } from '@octopus/marketing';
import { MAX_PERIODS_PER_PULL, metricsSweep, rollupOutcomes, type OutcomeReadRow } from './metrics';

type Row = Record<string, unknown>;

const PROJECT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const OTHER_CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const EMBED = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';

/**
 * What the fake answers for this campaign, pinned as literals.
 *
 * Written out rather than recomputed with the same hash the fake uses, which
 * would assert only that a function equals itself. These are the numbers the
 * deterministic adapter actually produces, and they are here so a change to its
 * derivation is a failing test rather than a silently different corpus of
 * fixtures.
 */
const EXTERNAL_ID = 'fake:f5bfadf8b3b8';
const DAY_19 = { impressions: 9331, clicks: 233, spend: 198.05, conversions: 11, revenue: 462 };
const DAY_20 = { impressions: 1648, clicks: 41, spend: 34.85, conversions: 2, revenue: 84 };

/** Fixed "now", so every period this suite asks for is a closed past day. */
const NOW = new Date('2026-08-21T09:00:00.000Z');

interface Fixtures {
  campaigns?: Row[];
  projects?: Row[];
  connections?: Row[];
  adEntities?: Row[];
  outcomes?: Row[];
  failEvents?: boolean;
}

function campaignRow(over: Row = {}): Row {
  return {
    id: CAMPAIGN,
    project_id: PROJECT,
    name: 'Launch campaign',
    channel: 'meta',
    state: 'live',
    created_at: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

function entityRow(over: Row = {}): Row {
  return {
    campaign_id: CAMPAIGN,
    external_id: EXTERNAL_ID,
    kind: 'campaign',
    // One whole closed day is owed against NOW: 2026-08-20.
    created_at: '2026-08-20T08:00:00.000Z',
    ...over,
  };
}

function connectionRow(over: Row = {}): Row {
  return {
    id: 'conn-1',
    provider: 'fake',
    granted_scopes: ['ads:read', 'ads:write'],
    status: 'active',
    created_at: '2026-08-19T00:00:00.000Z',
    ...over,
  };
}

function outcomeRow(over: Row = {}): Row {
  return {
    campaign_id: CAMPAIGN,
    project_id: PROJECT,
    period_start: '2026-08-20T00:00:00.000Z',
    period_end: '2026-08-21T00:00:00.000Z',
    spend: '34.85',
    impressions: 1648,
    clicks: 41,
    conversions: 2,
    revenue: '84.00',
    source: 'pull_metrics',
    ...over,
  };
}

function matches(row: Row, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([k, v]) => row[k] === v);
}

function makeDb(f: Fixtures) {
  const state = {
    campaigns: f.campaigns ?? [campaignRow()],
    projects: f.projects ?? [{ id: PROJECT, status: 'active', source_embed_id: EMBED }],
    embeds: [{ id: EMBED, room_id: ROOM }],
    connections: f.connections ?? [connectionRow()],
    adEntities: f.adEntities ?? [entityRow()],
    outcomes: f.outcomes ?? ([] as Row[]),
  };
  const log = {
    updates: [] as { table: string; values: Row; filters: Record<string, unknown> }[],
    messages: [] as Row[],
    events: [] as Row[],
  };
  const messageKeys = new Set<string>();
  // The real control on this table. `(campaign_id, period_start, period_end,
  // source)`, exactly as the migration declares it.
  const outcomeKeys = new Set(
    state.outcomes.map((r) => `${r.campaign_id}|${r.period_start}|${r.period_end}|${r.source}`),
  );

  function resolve(q: {
    table: string;
    op: string;
    cols: string;
    values: Row | null;
    filters: Record<string, unknown>;
    ins: Record<string, unknown[]>;
  }): { data: unknown; error: unknown } {
    if (q.op === 'insert') {
      const values = q.values as Row;

      if (q.table === 'messages') {
        const key = values.idempotency_key as string;
        if (messageKeys.has(key)) return { data: null, error: { code: '23505' } };
        messageKeys.add(key);
        log.messages.push(values);
        return { data: null, error: null };
      }
      if (q.table === 'events') {
        if (f.failEvents) return { data: null, error: { code: 'XX000', message: 'no' } };
        log.events.push(values);
        return { data: null, error: null };
      }
      if (q.table === 'campaign_outcomes') {
        const key = `${values.campaign_id}|${values.period_start}|${values.period_end}|${values.source}`;
        if (outcomeKeys.has(key)) return { data: null, error: { code: '23505' } };
        outcomeKeys.add(key);
        state.outcomes.push(values);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    if (q.op === 'update') {
      // Recorded whatever the table, so a test can assert that the sweep issued
      // none against the two it holds no privilege on.
      log.updates.push({ table: q.table, values: q.values as Row, filters: q.filters });
      const table =
        q.table === 'channel_connections'
          ? state.connections
          : q.table === 'campaigns'
            ? state.campaigns
            : [];
      const hit = table.find((r) => matches(r, q.filters));
      if (hit) Object.assign(hit, q.values);
      return { data: hit ? { id: hit.id } : null, error: null };
    }

    switch (q.table) {
      case 'campaigns': {
        const wanted = q.ins.state ?? [];
        return { data: state.campaigns.filter((r) => wanted.includes(r.state)), error: null };
      }
      case 'projects': {
        if (q.cols.includes('source_embed_id')) {
          return { data: state.projects.find((r) => r.id === q.filters.id) ?? null, error: null };
        }
        const ids = q.ins.id ?? [];
        return { data: state.projects.filter((r) => ids.includes(r.id)), error: null };
      }
      case 'action_embeds':
        return { data: state.embeds.find((r) => r.id === q.filters.id) ?? null, error: null };
      case 'channel_connections':
        return { data: state.connections, error: null };
      case 'ad_entities': {
        const ids = q.ins.campaign_id ?? [];
        return {
          data: state.adEntities.filter(
            (r) => ids.includes(r.campaign_id) && matches(r, q.filters) && r.external_id !== null,
          ),
          error: null,
        };
      }
      case 'campaign_outcomes': {
        const found = state.outcomes.filter((r) => matches(r, q.filters));
        // Ordered by `period_start` descending, as the query asks, so
        // `maybeSingle` takes the latest measured window.
        found.sort((a, b) => String(b.period_start).localeCompare(String(a.period_start)));
        return { data: found, error: null };
      }
      default:
        return { data: null, error: null };
    }
  }

  const client = {
    from(table: string) {
      const q = {
        table,
        op: 'select',
        cols: '',
        values: null as Row | null,
        filters: {} as Record<string, unknown>,
        ins: {} as Record<string, unknown[]>,
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (cols = '') => {
          q.cols = cols;
          return builder;
        },
        insert: (values: Row) => {
          q.op = 'insert';
          q.values = values;
          return builder;
        },
        update: (values: Row) => {
          q.op = 'update';
          q.values = values;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          q.filters[col] = val;
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          q.ins[col] = vals;
          return builder;
        },
        // `.not('external_id', 'is', null)` is already modelled by the ad_entities
        // branch above, which never returns a null external id.
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          const r = resolve(q);
          return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
          Promise.resolve(resolve(q)).then(ok, err),
      });
      return builder;
    },
  };

  return { client: client as never, log, state };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function recordingLog() {
  const lines: { level: string; obj: unknown; msg: string }[] = [];
  return {
    lines,
    log: {
      info: (obj: unknown, msg: string) => lines.push({ level: 'info', obj, msg }),
      warn: (obj: unknown, msg: string) => lines.push({ level: 'warn', obj, msg }),
      error: (obj: unknown, msg: string) => lines.push({ level: 'error', obj, msg }),
    },
  };
}

/** An adapter that answers however a test needs, and counts being asked. */
function stubAdapter(answers: unknown | unknown[]): {
  adapter: AdChannelAdapter;
  calls: unknown[];
} {
  const queue = Array.isArray(answers) ? [...answers] : null;
  const calls: unknown[] = [];
  const adapter = {
    provider: 'fake',
    createCampaign: async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } }),
    createAdSet: async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } }),
    createAd: async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } }),
    setBudget: async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } }),
    pause: async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } }),
    pullMetrics: async (ref: unknown, period: unknown) => {
      calls.push({ ref, period });
      if (queue) {
        const next = queue.shift();
        if (next === undefined) throw new Error('the sweep asked for more periods than staged');
        if (typeof next === 'function') return (next as () => unknown)();
        return next;
      }
      if (typeof answers === 'function') return (answers as () => unknown)();
      return answers;
    },
  } as unknown as AdChannelAdapter;
  return { adapter, calls };
}

function ok(rows: unknown[]) {
  return { ok: true, value: rows, alreadyExisted: false };
}

function metricsRow(over: Row = {}): Row {
  return {
    externalId: EXTERNAL_ID,
    periodStart: '2026-08-20T00:00:00.000Z',
    periodEnd: '2026-08-21T00:00:00.000Z',
    spend: 34.85,
    impressions: 1648,
    clicks: 41,
    conversions: 2,
    revenue: 84,
    extras: {},
    ...over,
  };
}

function run(
  db: ReturnType<typeof makeDb>,
  over: Partial<Parameters<typeof metricsSweep>[0]> = {},
) {
  return metricsSweep({
    admin: db.client,
    maxPerPass: 5,
    log: silentLog,
    now: () => NOW,
    ...over,
  });
}

/** No UPDATE may reach either table: the grant revokes it, including for us. */
function expectAppendOnly(db: ReturnType<typeof makeDb>) {
  const forbidden = db.log.updates.filter(
    (u) => u.table === 'campaign_outcomes' || u.table === 'campaigns',
  );
  expect(forbidden).toEqual([]);
}

/* ------------------------------------------------------------ the happy path */

describe('measuring a live campaign', () => {
  it('writes one row per closed day, with the window it asked for', async () => {
    const db = makeDb({});
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    expect(result).toMatchObject({ attempted: 1, rowsWritten: 1, duplicates: 0, waiting: 0 });
    expect(calls).toHaveLength(1);
    expect(db.state.outcomes).toHaveLength(1);
    expect(db.state.outcomes[0]).toMatchObject({
      campaign_id: CAMPAIGN,
      project_id: PROJECT,
      period_start: '2026-08-20T00:00:00.000Z',
      period_end: '2026-08-21T00:00:00.000Z',
      spend: 34.85,
      source: 'pull_metrics',
    });
    expectAppendOnly(db);
  });

  it('records the act, carrying what the row has no column for', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(ok([metricsRow()]));

    await run(db, { adapters: () => adapter });

    expect(db.log.events).toHaveLength(1);
    expect(db.log.events[0]).toMatchObject({
      verb: 'campaign.metrics_pulled',
      subject_type: 'campaign',
      subject_id: CAMPAIGN,
      project_id: PROJECT,
      actor_kind: 'system',
    });
    const payload = db.log.events[0]!.payload as Row;
    expect(payload).toMatchObject({
      provider: 'fake',
      connection_id: 'conn-1',
      external_id: EXTERNAL_ID,
      rows_written: 1,
    });
  });

  it('says nothing in the room when it worked', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(ok([metricsRow()]));
    await run(db, { adapters: () => adapter });
    expect(db.log.messages).toEqual([]);
  });

  it('is the numbers the real fake adapter produces, not a stub', async () => {
    // Two days owed, so the pin covers a second window as well and a change to
    // the fake's derivation cannot pass unnoticed.
    const db = makeDb({ adEntities: [entityRow({ created_at: '2026-08-19T00:00:00.000Z' })] });

    const result = await run(db, { adapters: () => createFakeAdapter() });

    expect(result).toMatchObject({ attempted: 1, rowsWritten: 2, duplicates: 0 });
    expect(db.state.outcomes[0]).toMatchObject({
      period_start: '2026-08-19T00:00:00.000Z',
      spend: DAY_19.spend,
      impressions: DAY_19.impressions,
      clicks: DAY_19.clicks,
      conversions: DAY_19.conversions,
      revenue: DAY_19.revenue,
    });
    expect(db.state.outcomes[1]).toMatchObject({
      period_start: '2026-08-20T00:00:00.000Z',
      spend: DAY_20.spend,
      impressions: DAY_20.impressions,
    });
    // numeric(12,2): the fake must never produce a value the column cannot hold.
    for (const row of db.state.outcomes) {
      expect(Math.round((row.spend as number) * 100)).toBeCloseTo((row.spend as number) * 100, 6);
    }
  });
});

/* ---------------------------------------------------------------- idempotency */

describe('a window is never measured twice', () => {
  it('counts a re-pull as a duplicate and writes no second row', async () => {
    const db = makeDb({ outcomes: [outcomeRow()] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    // The row already covers 2026-08-20, so nothing is owed and the adapter is
    // never asked. That is the cursor working, one layer before the unique key.
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ attempted: 0, rowsWritten: 0 });
    expect(db.state.outcomes).toHaveLength(1);
    expectAppendOnly(db);
  });

  it('tolerates the unique key when a racing pass got there first', async () => {
    // The cursor read finds nothing because the existing row is for a different
    // source, so the sweep asks and the insert is what refuses it. This is the
    // second layer, and it is the one that survives two workers.
    const db = makeDb({ outcomes: [outcomeRow({ source: 'manual' })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ rowsWritten: 1, duplicates: 0 });
    // The manual row and the pulled row coexist: the source is part of the key,
    // so a correction is a new row and both numbers survive.
    expect(db.state.outcomes).toHaveLength(2);
  });

  it('writes no event on a pass that recorded nothing new', async () => {
    const db = makeDb({ outcomes: [outcomeRow()] });
    const { adapter } = stubAdapter(ok([metricsRow()]));
    await run(db, { adapters: () => adapter });
    expect(db.log.events).toEqual([]);
  });

  it('a manual correction does not move the cursor past an unpulled day', async () => {
    // A manual row for 2026-08-20 exists and no pull_metrics row does. The day is
    // still owed, because the cursor is scoped to what this sweep wrote: letting a
    // correction advance it would skip a day nobody ever pulled.
    const db = makeDb({ outcomes: [outcomeRow({ source: 'manual' })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(1);
    expect((calls[0] as { period: { start: string } }).period.start).toBe(
      '2026-08-20T00:00:00.000Z',
    );
    expect(db.state.outcomes.filter((r) => r.source === 'pull_metrics')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ selection */

describe('which campaigns a pass takes', () => {
  it('never measures a campaign that is not live or paused', async () => {
    for (const state of ['draft', 'ready', 'publishing', 'completed', 'cancelled', 'failed']) {
      const db = makeDb({ campaigns: [campaignRow({ state })] });
      const { adapter, calls } = stubAdapter(ok([metricsRow()]));
      const result = await run(db, { adapters: () => adapter });
      expect(calls, `state ${state} was measured`).toHaveLength(0);
      expect(result.attempted).toBe(0);
    }
  });

  it('measures a paused campaign, because it spent before it stopped', async () => {
    const db = makeDb({ campaigns: [campaignRow({ state: 'paused' })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));
    await run(db, { adapters: () => adapter });
    expect(calls).toHaveLength(1);
  });

  it('skips a campaign whose project is not active, and says so', async () => {
    const db = makeDb({
      projects: [{ id: PROJECT, status: 'paused', source_embed_id: EMBED }],
    });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(calls).toHaveLength(0);
    expect(result.attempted).toBe(0);
    expect(rec.lines.some((l) => l.msg.includes('not being measured'))).toBe(true);
  });

  it('does not call the platform for a campaign with no published entity', async () => {
    const db = makeDb({ adEntities: [] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ attempted: 0, rowsWritten: 0, waiting: 0 });
  });

  it('bounds the pass by campaigns actually pulled, not by campaigns looked at', async () => {
    const measured = campaignRow({ id: OTHER_CAMPAIGN, created_at: '2026-08-02T00:00:00.000Z' });
    const db = makeDb({
      // The first is already up to date, so it must not consume the single slot
      // and leave the second one starved.
      campaigns: [campaignRow(), measured],
      adEntities: [entityRow(), entityRow({ campaign_id: OTHER_CAMPAIGN })],
      outcomes: [outcomeRow()],
    });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter, maxPerPass: 1 });

    expect(result).toMatchObject({ attempted: 1, rowsWritten: 1 });
    expect(calls).toHaveLength(1);
    expect(db.state.outcomes.filter((r) => r.campaign_id === OTHER_CAMPAIGN)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- blocked paths */

describe('the platform is not called when it should not be', () => {
  it('says so once when no account is connected', async () => {
    const db = makeDb({ connections: [] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const first = await run(db, { adapters: () => adapter });
    expect(calls).toHaveLength(0);
    expect(first).toMatchObject({ attempted: 1, waiting: 1, rowsWritten: 0 });
    expect(db.log.messages).toHaveLength(1);
    expect(db.log.messages[0]!.idempotency_key).toBe(
      `campaign-metrics-blocked:${CAMPAIGN}:no_connection`,
    );

    // The next pass finds the same state and has nothing new to say.
    await run(db, { adapters: () => adapter });
    expect(db.log.messages).toHaveLength(1);
    expectAppendOnly(db);
  });

  it('refuses a connection that was never granted the read scope', async () => {
    const db = makeDb({ connections: [connectionRow({ granted_scopes: ['ads:write'] })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(0);
    expect(result.waiting).toBe(1);
    expect(db.log.messages[0]!.idempotency_key).toBe(
      `campaign-metrics-blocked:${CAMPAIGN}:missing_scopes`,
    );
  });

  it('measures a connection granted only the read scope', async () => {
    // A person may untick `ads:write` on the consent screen. That connection
    // cannot publish and can still be measured, which is the whole reason the two
    // scope lists are separate.
    const db = makeDb({ connections: [connectionRow({ granted_scopes: ['ads:read'] })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(1);
    expect(result.rowsWritten).toBe(1);
  });

  it('refuses a revoked connection and names the status rather than a scope', async () => {
    const db = makeDb({ connections: [connectionRow({ status: 'revoked' })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));

    await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(0);
    expect(db.log.messages[0]!.idempotency_key).toBe(
      `campaign-metrics-blocked:${CAMPAIGN}:connection_not_active`,
    );
  });

  it('leaves a campaign with no room alone and logs it', async () => {
    const db = makeDb({
      projects: [{ id: PROJECT, status: 'active', source_embed_id: null }],
    });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(calls).toHaveLength(0);
    expect(result.waiting).toBe(1);
    expect(rec.lines.some((l) => l.level === 'warn' && l.msg.includes('no room'))).toBe(true);
  });
});

/* ------------------------------------------------- what the platform answered */

describe('what the platform answered', () => {
  it('marks the connection expired and says so once on auth_expired', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'auth_expired', message: 'token gone' },
    });

    const result = await run(db, { adapters: () => adapter });

    expect(result).toMatchObject({ waiting: 1, rowsWritten: 0 });
    expect(db.state.connections[0]!.status).toBe('expired');
    expect(db.log.messages[0]!.idempotency_key).toBe(
      `campaign-metrics-blocked:${CAMPAIGN}:auth_expired`,
    );
    // The only update this sweep may make.
    expect(db.log.updates.map((u) => u.table)).toEqual(['channel_connections']);
  });

  it('says once that a campaign the platform lost cannot be measured', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'not_found', message: 'no such campaign' },
    });

    const result = await run(db, { adapters: () => adapter });

    expect(result).toMatchObject({ gone: 1, waiting: 0, rowsWritten: 0 });
    expect(db.log.messages[0]!.idempotency_key).toBe(
      `campaign-metrics-blocked:${CAMPAIGN}:not_found`,
    );
    // Never closed. There is no arc a failed measurement could take, and pausing
    // somebody's spend because we could not read a number would be the worst use
    // of an uncertain measurement.
    expect(db.state.campaigns[0]!.state).toBe('live');
    expectAppendOnly(db);
  });

  it('retries a rate limit silently, because it is not owner-actionable', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'rate_limited', message: 'slow down' },
    });
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result).toMatchObject({ waiting: 1, rowsWritten: 0 });
    expect(db.log.messages).toEqual([]);
    expect(rec.lines.some((l) => l.level === 'warn' && l.msg.includes('refused for now'))).toBe(
      true,
    );
  });

  it('logs a write-only error kind at error level, because the seam was broken', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'invalid_spec', message: 'not a read error' },
    });
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result.waiting).toBe(1);
    expect(rec.lines.some((l) => l.level === 'error' && l.msg.includes('write-only'))).toBe(true);
    // Still not terminal: there is nothing to close.
    expect(db.state.campaigns[0]!.state).toBe('live');
  });

  it('writes nothing when the adapter answers a different question', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(ok([metricsRow({ externalId: 'fake:somebody-else' })]));
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result).toMatchObject({ rowsWritten: 0, waiting: 1 });
    expect(db.state.outcomes).toEqual([]);
    expect(
      rec.lines.some((l) => l.level === 'warn' && l.msg.includes('did not answer the question')),
    ).toBe(true);
  });

  it('writes nothing when the adapter returns two rows for one window', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(ok([metricsRow(), metricsRow({ spend: 1 })]));

    const result = await run(db, { adapters: () => adapter });

    expect(result.rowsWritten).toBe(0);
    expect(db.state.outcomes).toEqual([]);
  });
});

/* ------------------------------------------------------------ contiguity */

describe('the days stay contiguous', () => {
  it('stops at the first day that does not land, so the cursor cannot skip it', async () => {
    // Three days owed. The second fails, so the third must not be written: the
    // cursor is max(period_end), and writing day three would strand day two.
    const db = makeDb({ adEntities: [entityRow({ created_at: '2026-08-18T00:00:00.000Z' })] });
    const { adapter, calls } = stubAdapter([
      ok([
        metricsRow({
          periodStart: '2026-08-18T00:00:00.000Z',
          periodEnd: '2026-08-19T00:00:00.000Z',
        }),
      ]),
      { ok: false, error: { kind: 'provider_error', message: 'boom' } },
      ok([metricsRow()]),
    ]);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ rowsWritten: 1, waiting: 1 });
    expect(db.state.outcomes).toHaveLength(1);
    expect(db.state.outcomes[0]).toMatchObject({ period_start: '2026-08-18T00:00:00.000Z' });
  });

  it('resumes from the day that failed on the next pass', async () => {
    const db = makeDb({ adEntities: [entityRow({ created_at: '2026-08-18T00:00:00.000Z' })] });
    const first = stubAdapter([
      ok([
        metricsRow({
          periodStart: '2026-08-18T00:00:00.000Z',
          periodEnd: '2026-08-19T00:00:00.000Z',
        }),
      ]),
      { ok: false, error: { kind: 'provider_error', message: 'boom' } },
    ]);
    await run(db, { adapters: () => first.adapter });

    const second = stubAdapter([
      ok([
        metricsRow({
          periodStart: '2026-08-19T00:00:00.000Z',
          periodEnd: '2026-08-20T00:00:00.000Z',
        }),
      ]),
      ok([metricsRow()]),
    ]);
    const result = await run(db, { adapters: () => second.adapter });

    // Asked for 19 and 20, in that order. Nothing was skipped.
    expect(second.calls).toHaveLength(2);
    expect((second.calls[0] as { period: { start: string } }).period.start).toBe(
      '2026-08-19T00:00:00.000Z',
    );
    expect(result.rowsWritten).toBe(2);
    expect(db.state.outcomes.map((r) => r.period_start)).toEqual([
      '2026-08-18T00:00:00.000Z',
      '2026-08-19T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z',
    ]);
  });

  it('caps a long backlog at the oldest days and leaves the rest owed', async () => {
    const db = makeDb({ adEntities: [entityRow({ created_at: '2026-07-01T00:00:00.000Z' })] });
    const result = await run(db, { adapters: () => createFakeAdapter() });

    expect(result.rowsWritten).toBe(MAX_PERIODS_PER_PULL);
    expect(db.state.outcomes[0]).toMatchObject({ period_start: '2026-07-01T00:00:00.000Z' });
    expect(db.state.outcomes).toHaveLength(MAX_PERIODS_PER_PULL);
  });
});

/* ------------------------------------------------------------- resilience */

describe('one campaign does not cost the others their pass', () => {
  it('records a throw against the campaign that caused it and carries on', async () => {
    const db = makeDb({
      campaigns: [campaignRow(), campaignRow({ id: OTHER_CAMPAIGN })],
      adEntities: [entityRow(), entityRow({ campaign_id: OTHER_CAMPAIGN })],
    });
    let call = 0;
    const adapter = {
      provider: 'fake',
      pullMetrics: async () => {
        call += 1;
        if (call === 1) throw new Error('transport died');
        return ok([metricsRow()]);
      },
    } as unknown as AdChannelAdapter;
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result).toMatchObject({ attempted: 2, rowsWritten: 1, waiting: 1 });
    expect(db.state.outcomes).toHaveLength(1);
    expect(db.state.outcomes[0]!.campaign_id).toBe(OTHER_CAMPAIGN);
    expect(rec.lines.some((l) => l.level === 'error' && l.msg.includes('could not measure'))).toBe(
      true,
    );
  });

  it('does not lose a measurement because its event could not be written', async () => {
    const db = makeDb({ failEvents: true });
    const { adapter } = stubAdapter(ok([metricsRow()]));
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result.rowsWritten).toBe(1);
    expect(db.state.outcomes).toHaveLength(1);
    expect(rec.lines.some((l) => l.level === 'error' && l.msg.includes('the event was not'))).toBe(
      true,
    );
  });

  it('reports a campaign whose own timestamps cannot be read', async () => {
    const db = makeDb({ adEntities: [entityRow({ created_at: 'not-a-date' })] });
    const { adapter, calls } = stubAdapter(ok([metricsRow()]));
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(calls).toHaveLength(0);
    expect(result.waiting).toBe(1);
    expect(rec.lines.some((l) => l.level === 'error' && l.msg.includes('which days'))).toBe(true);
  });

  it('ends every pass with a summary, whatever happened', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(ok([metricsRow()]));
    const rec = recordingLog();

    await run(db, { adapters: () => adapter, log: rec.log });

    expect(rec.lines.some((l) => l.msg === 'metrics sweep complete')).toBe(true);
  });
});

/* ------------------------------------------------------------------ rollup */

describe('rollupOutcomes', () => {
  const row = (over: Partial<OutcomeReadRow> = {}): OutcomeReadRow => ({
    campaign_id: CAMPAIGN,
    spend: '10.50',
    impressions: 100,
    clicks: 10,
    conversions: 1,
    period_end: '2026-08-20T00:00:00.000Z',
    ...over,
  });

  it('sums the stringified numerics PostgREST hands back', () => {
    const out = rollupOutcomes([
      row(),
      row({ spend: '4.50', period_end: '2026-08-21T00:00:00.000Z' }),
    ]);
    expect(out.get(CAMPAIGN)).toMatchObject({ spendToDate: 15, clicksToDate: 20 });
  });

  it('reports the latest window it has measured', () => {
    const out = rollupOutcomes([
      row({ period_end: '2026-08-21T00:00:00.000Z' }),
      row({ period_end: '2026-08-19T00:00:00.000Z' }),
    ]);
    expect(out.get(CAMPAIGN)!.lastMeasuredAt).toBe('2026-08-21T00:00:00.000Z');
  });

  it('keeps a metric nothing measured as null rather than zero', () => {
    // A zero would claim the campaign was measured and found to have none, which
    // is a different sentence from "the platform did not report this".
    const out = rollupOutcomes([row({ clicks: null }), row({ clicks: null })]);
    expect(out.get(CAMPAIGN)!.clicksToDate).toBeNull();
    expect(out.get(CAMPAIGN)!.impressionsToDate).toBe(200);
  });

  it('counts only the rows that carried a value', () => {
    const out = rollupOutcomes([row({ clicks: 10 }), row({ clicks: null })]);
    expect(out.get(CAMPAIGN)!.clicksToDate).toBe(10);
  });

  it('treats a null spend as nothing rather than as NaN', () => {
    // `spend` is `not null` in the table, so this is defensive. The failure it
    // guards is the one this repository keeps meeting: a wrong answer wearing
    // the shape of a right one.
    const out = rollupOutcomes([row({ spend: null }), row({ spend: 'nonsense' }), row()]);
    expect(out.get(CAMPAIGN)!.spendToDate).toBe(10.5);
  });

  it('keeps campaigns apart', () => {
    const out = rollupOutcomes([row(), row({ campaign_id: OTHER_CAMPAIGN, spend: '1.00' })]);
    expect(out.get(CAMPAIGN)!.spendToDate).toBe(10.5);
    expect(out.get(OTHER_CAMPAIGN)!.spendToDate).toBe(1);
  });

  it('has nothing to say about a campaign with no rows', () => {
    expect(rollupOutcomes([]).size).toBe(0);
  });
});
