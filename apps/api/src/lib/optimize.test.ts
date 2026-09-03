/**
 * The optimize sweep: the first act on money with no click behind it.
 *
 * The stub below is shaped like `metrics.test.ts`'s and is deliberately not
 * imported from it, on that file's own reasoning: nothing is shared across test
 * files here, and the two model different properties. That one exists to honour
 * a unique key; this one exists to honour **conditional state transitions and an
 * epoch-carrying idempotency key**, because the danger in this sweep is not a
 * doubled row but a database that says `paused` about a campaign the platform is
 * still spending on.
 *
 * Four properties carry the file.
 *
 * **The platform is never called for a campaign that should not be judged.**
 * Asserted as "the adapter was not invoked", because "nothing was paused" looks
 * identical afterwards and only one of them is the property.
 *
 * **A pause failure never moves a campaign.** `live -> failed` is not a legal
 * arc, and a campaign we could not pause must stay visibly live.
 *
 * **The key carries the epoch.** A second breach after a resume presents a new
 * key, or a record-replay platform answers it with the first pause's recorded
 * result while the money keeps moving.
 *
 * **`campaign_outcomes` is never written or updated by this sweep.** It reads
 * the table the metrics sweep writes, and a write here would be a decision
 * dressed as a measurement.
 */

import { describe, expect, it } from 'vitest';
import type { AdChannelAdapter } from '@octopus/marketing';
import { optimizeSweep } from './optimize';

type Row = Record<string, unknown>;

const PROJECT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const OTHER_CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const EMBED = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';
const EXTERNAL_ID = 'fake:f5bfadf8b3b8';

interface Fixtures {
  campaigns?: Row[];
  projects?: Row[];
  connections?: Row[];
  adEntities?: Row[];
  outcomes?: Row[];
  events?: Row[];
}

function campaignRow(over: Row = {}): Row {
  return {
    id: CAMPAIGN,
    project_id: PROJECT,
    name: 'Launch campaign',
    channel: 'meta',
    state: 'live',
    // As PostgREST hands numeric back: a string. Parsing it is part of what the
    // sweep is on the hook for.
    cpa_ceiling: '15.00',
    currency: 'USD',
    created_at: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

function entityRow(over: Row = {}): Row {
  return {
    id: 'ent-1',
    campaign_id: CAMPAIGN,
    external_id: EXTERNAL_ID,
    kind: 'campaign',
    state: 'live',
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

/** One measured whole day that plainly breaches a ceiling of 15: 500 for 2. */
function breachedOutcome(over: Row = {}): Row {
  return {
    campaign_id: CAMPAIGN,
    project_id: PROJECT,
    period_start: '2026-08-20T00:00:00.000Z',
    period_end: '2026-08-21T00:00:00.000Z',
    spend: '500.00',
    impressions: 9000,
    clicks: 200,
    conversions: 2,
    source: 'pull_metrics',
    ...over,
  };
}

/** A prior `paused -> live` transition, which is what the pause epoch counts. */
function resumeTransition(subjectId: string = CAMPAIGN): Row {
  return {
    verb: 'campaign.transitioned',
    subject_type: 'campaign',
    subject_id: subjectId,
    payload: { from: 'paused', to: 'live' },
  };
}

function matches(row: Row, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([k, v]) => {
    if (k.startsWith('payload->>')) {
      const payload = row.payload as Record<string, unknown> | undefined;
      return payload?.[k.slice('payload->>'.length)] === v;
    }
    return row[k] === v;
  });
}

function makeDb(f: Fixtures) {
  const state = {
    campaigns: f.campaigns ?? [campaignRow()],
    projects: f.projects ?? [{ id: PROJECT, status: 'active', source_embed_id: EMBED }],
    embeds: [{ id: EMBED, room_id: ROOM }],
    connections: f.connections ?? [connectionRow()],
    adEntities: f.adEntities ?? [entityRow()],
    outcomes: f.outcomes ?? [breachedOutcome()],
    events: f.events ?? ([] as Row[]),
  };
  const log = {
    updates: [] as { table: string; values: Row; filters: Record<string, unknown> }[],
    messages: [] as Row[],
    events: [] as Row[],
  };
  const messageKeys = new Set<string>();

  function resolve(q: {
    table: string;
    op: string;
    cols: string;
    head: boolean;
    values: Row | null;
    filters: Record<string, unknown>;
    ins: Record<string, unknown[]>;
  }): { data: unknown; error: unknown; count?: number | null } {
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
        log.events.push(values);
        state.events.push(values);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }

    if (q.op === 'update') {
      log.updates.push({ table: q.table, values: q.values as Row, filters: q.filters });
      const table =
        q.table === 'channel_connections'
          ? state.connections
          : q.table === 'campaigns'
            ? state.campaigns
            : q.table === 'ad_entities'
              ? state.adEntities
              : [];
      const hit = table.find((r) => matches(r, q.filters));
      if (hit) Object.assign(hit, q.values);
      // As `.update().eq(...).select('id')` resolves in supabase-js: an array of
      // the rows that actually moved, which is what the replay branch reads.
      return { data: hit ? [{ id: hit.id }] : [], error: null };
    }

    switch (q.table) {
      case 'campaigns':
        // `.eq('state', 'live').not('cpa_ceiling', 'is', null)`: the stub applies
        // both because the sweep's selection IS one of the properties under test.
        return {
          data: state.campaigns.filter((r) => matches(r, q.filters) && r.cpa_ceiling !== null),
          error: null,
        };
      case 'projects':
        return { data: state.projects.find((r) => r.id === q.filters.id) ?? null, error: null };
      case 'action_embeds':
        return { data: state.embeds.find((r) => r.id === q.filters.id) ?? null, error: null };
      case 'channel_connections':
        return { data: state.connections, error: null };
      case 'ad_entities': {
        const ids = q.ins.campaign_id ?? [];
        return {
          data: state.adEntities.filter(
            (r) => ids.includes(r.campaign_id) && r.kind === 'campaign' && r.external_id !== null,
          ),
          error: null,
        };
      }
      case 'campaign_outcomes':
        return { data: state.outcomes.filter((r) => matches(r, q.filters)), error: null };
      case 'events': {
        const found = state.events.filter((r) => matches(r, q.filters));
        return { data: q.head ? null : found, error: null, count: found.length };
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
        head: false,
        values: null as Row | null,
        filters: {} as Record<string, unknown>,
        ins: {} as Record<string, unknown[]>,
      };
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: (cols = '', opts?: { count?: string; head?: boolean }) => {
          q.cols = cols;
          if (opts?.head) q.head = true;
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

/** An adapter whose pause answers however a test needs, and counts being asked. */
function stubAdapter(answer: unknown | unknown[]): {
  adapter: AdChannelAdapter;
  calls: { externalId: string; key: string }[];
} {
  const queue = Array.isArray(answer) ? [...answer] : null;
  const calls: { externalId: string; key: string }[] = [];
  const refuse = async () => ({ ok: false, error: { kind: 'not_found', message: 'no' } });
  const adapter = {
    provider: 'fake',
    createCampaign: refuse,
    createAdSet: refuse,
    createAd: refuse,
    setBudget: refuse,
    resume: refuse,
    pullMetrics: refuse,
    pause: async (ref: { externalId: string }, key: string) => {
      calls.push({ externalId: ref.externalId, key });
      if (queue) return queue.shift();
      return answer;
    },
  } as unknown as AdChannelAdapter;
  return { adapter, calls };
}

const PAUSED_OK = { ok: true, value: { externalId: EXTERNAL_ID }, alreadyExisted: false };

function run(
  db: ReturnType<typeof makeDb>,
  over: Partial<Parameters<typeof optimizeSweep>[0]> = {},
) {
  return optimizeSweep({
    admin: db.client,
    maxPerPass: 5,
    log: silentLog,
    ...over,
  });
}

/** This sweep reads the outcomes table and must never write or update it. */
function expectOutcomesUntouched(db: ReturnType<typeof makeDb>) {
  expect(db.log.updates.filter((u) => u.table === 'campaign_outcomes')).toEqual([]);
}

/* ------------------------------------------------------- who is never judged */

describe('what the sweep leaves alone', () => {
  it('never calls the adapter for a campaign with no ceiling', async () => {
    const db = makeDb({ campaigns: [campaignRow({ cpa_ceiling: null })] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result.judged).toBe(0);
    expectOutcomesUntouched(db);
  });

  it('abstains, without calling the adapter, when nothing has been measured', async () => {
    const db = makeDb({ outcomes: [] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ judged: 1, abstained: 1, breached: 0 });
  });

  it('abstains when spend was measured and conversions never were: no invented zero', async () => {
    const db = makeDb({
      outcomes: [breachedOutcome({ conversions: null })],
    });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ judged: 1, abstained: 1, breached: 0 });
  });

  it('leaves a campaign inside its allowance alone, and counts it', async () => {
    // 34.85 for 2 conversions against a ceiling of 15: allowance 45, no breach.
    const db = makeDb({ outcomes: [breachedOutcome({ spend: '34.85' })] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ judged: 1, withinCeiling: 1, breached: 0 });
  });

  it('skips a campaign whose root was never published, silently', async () => {
    const db = makeDb({ adEntities: [] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result.judged).toBe(0);
  });

  it('logs a garbage ceiling at error instead of judging against it', async () => {
    const db = makeDb({ campaigns: [campaignRow({ cpa_ceiling: 'not-a-number' })] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ judged: 1, unusable: 1, breached: 0 });
    expect(rec.lines.some((l) => l.level === 'error')).toBe(true);
  });
});

/* --------------------------------------------------------------- the breach */

describe('pausing a breached campaign', () => {
  it('pauses at the platform under the epoch-0 key, then moves both rows', async () => {
    const db = makeDb({});
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([{ externalId: EXTERNAL_ID, key: `pause:${CAMPAIGN}:cpa:0` }]);
    expect(result).toMatchObject({ judged: 1, breached: 1, paused: 1, waiting: 0 });

    const entityMove = db.log.updates.find((u) => u.table === 'ad_entities');
    expect(entityMove).toMatchObject({
      values: { state: 'paused' },
      filters: { id: 'ent-1', state: 'live' },
    });

    const campaignMove = db.log.updates.find((u) => u.table === 'campaigns');
    expect(campaignMove).toMatchObject({
      values: { state: 'paused', pause_reason: 'cpa_breach' },
      filters: { id: CAMPAIGN, state: 'live' },
    });

    expectOutcomesUntouched(db);
  });

  it('writes the decision event with the arithmetic, and tells the room once', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter(PAUSED_OK);

    await run(db, { adapters: () => adapter });

    const event = db.log.events.find((e) => e.verb === 'campaign.auto_paused');
    expect(event).toMatchObject({
      actor_kind: 'system',
      subject_id: CAMPAIGN,
      payload: {
        spend: 500,
        conversions: 2,
        cpa_ceiling: 15,
        allowance: 45,
        provider: 'fake',
        external_id: EXTERNAL_ID,
      },
    });
    // No actor: the authorisation was typing the ceiling, which has its own
    // event with the person's id on it.
    expect(event).not.toHaveProperty('actor_id');

    expect(db.log.messages).toHaveLength(1);
    // The Analyst, because pausing on a cost ceiling is a judgement it made
    // from what it measured rather than something a person or a platform did.
    expect(db.log.messages[0]).toMatchObject({
      idempotency_key: `campaign-paused:${CAMPAIGN}:0`,
      author_kind: 'agent',
      persona: 'analyst',
    });
    expect(db.log.messages[0]!.body).toContain('500');
    expect(db.log.messages[0]!.body).toContain('15');
  });

  it('converges when a crash left the entity moved and the campaign not', async () => {
    const db = makeDb({ adEntities: [entityRow({ state: 'paused' })] });
    const { adapter, calls } = stubAdapter({ ...PAUSED_OK, alreadyExisted: true });

    const result = await run(db, { adapters: () => adapter });

    // Same key as the crashed pass, so the platform replays rather than re-acts.
    expect(calls[0]!.key).toBe(`pause:${CAMPAIGN}:cpa:0`);
    // The entity's conditional update matched nothing and that is fine; the
    // campaign still moved and the room was still told.
    expect(result.paused).toBe(1);
    const campaignMove = db.log.updates.find((u) => u.table === 'campaigns');
    expect(campaignMove).toBeDefined();
    expect(db.log.messages).toHaveLength(1);
  });

  it('uses a fresh epoch after a resume, so the second breach is its own act', async () => {
    const db = makeDb({ events: [resumeTransition()] });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    await run(db, { adapters: () => adapter });

    expect(calls).toEqual([{ externalId: EXTERNAL_ID, key: `pause:${CAMPAIGN}:cpa:1` }]);
    expect(db.log.messages[0]).toMatchObject({
      idempotency_key: `campaign-paused:${CAMPAIGN}:1`,
    });
  });

  it('pauses a breached campaign even when its project is paused: no project gate', async () => {
    // Deliberate, asserted so it reads as a choice: stopping money is
    // kill-switch-family work, and the stopping arc must have no states it
    // cannot reach. A stale rollup errs in the safe direction.
    const db = makeDb({ projects: [{ id: PROJECT, status: 'paused', source_embed_id: EMBED }] });
    const { adapter } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(result.paused).toBe(1);
  });
});

/* ---------------------------------------------------------- the failure map */

describe('when the pause does not land', () => {
  it('marks the connection expired on auth_expired, announces it, and moves nothing', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'auth_expired', message: 'token expired' },
    });

    const result = await run(db, { adapters: () => adapter });

    expect(result).toMatchObject({ breached: 1, paused: 0, waiting: 1 });
    const connMove = db.log.updates.find((u) => u.table === 'channel_connections');
    expect(connMove).toBeDefined();
    expect(db.log.updates.filter((u) => u.table === 'campaigns')).toEqual([]);
    expect(db.log.updates.filter((u) => u.table === 'ad_entities')).toEqual([]);
    expect(db.log.messages[0]).toMatchObject({
      idempotency_key: `campaign-pause-blocked:${CAMPAIGN}:auth_expired`,
    });
  });

  it('retries a rate limit silently: no message, no state moved', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'rate_limited', message: 'slow down' },
    });

    const result = await run(db, { adapters: () => adapter });

    expect(result).toMatchObject({ breached: 1, waiting: 1 });
    expect(db.log.messages).toEqual([]);
    expect(db.log.updates).toEqual([]);
  });

  it('says not_found once, at error, and never invents a confirmation', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'not_found', message: 'no such campaign' },
    });
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result).toMatchObject({ breached: 1, gone: 1, paused: 0 });
    expect(db.log.updates.filter((u) => u.table === 'campaigns')).toEqual([]);
    expect(db.log.messages[0]).toMatchObject({
      idempotency_key: `campaign-pause-blocked:${CAMPAIGN}:not_found`,
    });
    expect(rec.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('flags a mutation-vocabulary refusal at error and keeps retrying', async () => {
    const db = makeDb({});
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'policy_rejected', message: 'a pause has no creative' },
    });
    const rec = recordingLog();

    const result = await run(db, { adapters: () => adapter, log: rec.log });

    expect(result).toMatchObject({ breached: 1, waiting: 1 });
    expect(db.log.updates).toEqual([]);
    expect(rec.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('announces a missing scope once and never calls the adapter', async () => {
    const db = makeDb({
      connections: [connectionRow({ granted_scopes: ['ads:read'] })],
    });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter });

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ breached: 1, waiting: 1 });
    expect(db.log.messages[0]).toMatchObject({
      idempotency_key: `campaign-pause-blocked:${CAMPAIGN}:missing_scopes`,
    });
  });
});

/* -------------------------------------------------------------- the bounds */

describe('maxPerPass', () => {
  it('bounds breaches acted on, so caught-up campaigns cannot starve a breaching one', async () => {
    const healthy = campaignRow({
      id: OTHER_CAMPAIGN,
      // Sorted first by created_at; within its allowance, so it must not
      // consume the single slot.
      created_at: '2026-07-01T10:00:00.000Z',
    });
    const db = makeDb({
      campaigns: [healthy, campaignRow()],
      adEntities: [entityRow(), entityRow({ id: 'ent-2', campaign_id: OTHER_CAMPAIGN })],
      outcomes: [
        breachedOutcome(),
        breachedOutcome({ campaign_id: OTHER_CAMPAIGN, spend: '34.85' }),
      ],
    });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter, maxPerPass: 1 });

    expect(result).toMatchObject({ judged: 2, withinCeiling: 1, breached: 1, paused: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`pause:${CAMPAIGN}:cpa:0`);
  });

  it('stops acting once the bound is spent, and the rest keep their breach for next pass', async () => {
    const second = campaignRow({ id: OTHER_CAMPAIGN, created_at: '2026-08-02T10:00:00.000Z' });
    const db = makeDb({
      campaigns: [campaignRow(), second],
      adEntities: [entityRow(), entityRow({ id: 'ent-2', campaign_id: OTHER_CAMPAIGN })],
      outcomes: [breachedOutcome(), breachedOutcome({ campaign_id: OTHER_CAMPAIGN })],
    });
    const { adapter, calls } = stubAdapter(PAUSED_OK);

    const result = await run(db, { adapters: () => adapter, maxPerPass: 1 });

    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ breached: 1, paused: 1 });
  });
});
