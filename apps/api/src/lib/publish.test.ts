/**
 * The publish sweep: the first code in this system that acts outside it.
 *
 * The stub below models Postgres more carefully than a mock usually needs to,
 * and the reason is that every safety property in this file is expressed as a
 * CONDITIONAL write. `.eq('state', 'publishing')` matching zero rows is how a
 * cancelled campaign is stopped, how a racing pass is made harmless, and how a
 * resume avoids repeating itself. A stub that accepted every update and reported
 * success would let all three regress while these tests stayed green, so updates
 * here match on their filters and mutate the fixture rows, and later reads see
 * what earlier writes did.
 *
 * Four properties carry the file.
 *
 * **The platform is never called for a campaign that should not publish.** Not
 * cancelled, not unscoped, not unbudgeted, not on an unregistered provider. Every
 * one of those is asserted as "the adapter was not invoked" rather than as "the
 * state afterwards looks right", because the state afterwards looks identical
 * whether we refused or asked and lost the answer.
 *
 * **Every crash point resumes.** The intent row, the transition, the answer, and
 * the finalisation are four separate writes with three gaps between them, and
 * each gap has a test that starts from the state that gap leaves behind.
 *
 * **A policy rejection is terminal and says so to a person.** Retrying it is the
 * silently-keep-spending path the module rule forbids, and closing it without
 * explanation is the dead end this repository has now built twice.
 *
 * **Nothing is dropped in silence.** Every campaign the sweep declines to publish
 * leaves either a message in the room or a log line, and the tests assert which.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createFakeAdapter,
  POLICY_VIOLATION_MARKER,
  type AdChannelAdapter,
} from '@octopus/marketing';
import { publishSweep, selectPublishable, type PublishableCampaign } from './publish';

type Row = Record<string, unknown>;

const PROJECT = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const EMBED = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';

/** sha256('publish:<CAMPAIGN>:campaign'), as the fake derives it. Pinned, not computed. */
const EXPECTED_EXTERNAL_ID = (() => {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return `fake:${createHash('sha256').update(`publish:${CAMPAIGN}:campaign`).digest('hex').slice(0, 12)}`;
})();

interface Fixtures {
  campaigns?: Row[];
  projects?: Row[];
  connections?: Row[];
  adEntities?: Row[];
  /** Force the intent-row insert to collide, as a racing pass would. */
  insertConflict?: boolean;
  failEvents?: boolean;
  /**
   * Cancel the campaign after this pass has read it but before it writes, which
   * is the only way to stage the race: a campaign already cancelled is never
   * selected, so setting the state up front would test nothing.
   */
  cancelAfterRead?: boolean;
}

function campaignRow(over: Row = {}): Row {
  return {
    id: CAMPAIGN,
    project_id: PROJECT,
    name: 'Launch campaign',
    objective: 'reach new customers',
    channel: 'meta',
    state: 'ready',
    budget_cap: '400.00',
    currency: 'USD',
    created_at: '2026-08-29T10:00:00.000Z',
    ...over,
  };
}

function connectionRow(over: Row = {}): Row {
  return {
    id: 'conn-1',
    provider: 'fake',
    granted_scopes: ['ads:read', 'ads:write'],
    status: 'active',
    created_at: '2026-08-20T00:00:00.000Z',
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
    adEntities: f.adEntities ?? ([] as Row[]),
  };
  const log = {
    updates: [] as {
      table: string;
      values: Row;
      filters: Record<string, unknown>;
      matched: boolean;
    }[],
    inserts: [] as { table: string; values: Row }[],
    messages: [] as Row[],
    events: [] as Row[],
  };
  const messageKeys = new Set<string>();

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
      log.inserts.push({ table: q.table, values });

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
      if (q.table === 'ad_entities') {
        if (f.insertConflict) return { data: null, error: { code: '23505' } };
        const row = { id: 'entity-1', ...values };
        state.adEntities.push(row);
        return { data: row, error: null };
      }
      return { data: null, error: null };
    }

    if (q.op === 'update') {
      const table =
        q.table === 'campaigns'
          ? state.campaigns
          : q.table === 'ad_entities'
            ? state.adEntities
            : state.connections;
      const hit = table.find((r) => matches(r, q.filters));
      log.updates.push({
        table: q.table,
        values: q.values as Row,
        filters: q.filters,
        matched: !!hit,
      });
      // Conditional writes are the safety mechanism, so the stub honours them:
      // a row that no longer matches its expected state is not written.
      if (hit) Object.assign(hit, q.values);
      return { data: hit ? { id: hit.id } : null, error: null };
    }

    switch (q.table) {
      case 'campaigns': {
        if (q.filters.id)
          return { data: state.campaigns.find((r) => r.id === q.filters.id) ?? null, error: null };
        const wanted = q.ins.state ?? [];
        const listed = state.campaigns.filter((r) => wanted.includes(r.state));
        // Copies, because a read hands back the values as they were and not a
        // live view that changes under the caller.
        const snapshot = listed.map((r) => ({ ...r }));
        if (f.cancelAfterRead) {
          // Somebody else acts in the gap between this read and the write below,
          // so the caller is holding a row that is already out of date.
          for (const row of listed) row.state = 'cancelled';
        }
        return { data: snapshot, error: null };
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
        const found = state.adEntities.find((r) => matches(r, q.filters));
        return { data: found ?? null, error: null };
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
function stubAdapter(answer: unknown | (() => never)): {
  adapter: AdChannelAdapter;
  calls: number[];
} {
  const calls: number[] = [];
  const adapter = {
    provider: 'fake',
    createCampaign: async () => {
      calls.push(1);
      if (typeof answer === 'function') (answer as () => never)();
      return answer;
    },
    createAdSet: async () => answer,
    createAd: async () => answer,
    setBudget: async () => answer,
    pause: async () => answer,
    pullMetrics: async () => answer,
  } as unknown as AdChannelAdapter;
  return { adapter, calls };
}

/* -------------------------------------------------------------- selection */

describe('which campaigns a pass takes', () => {
  const c = (id: string, state: string, created: string): PublishableCampaign =>
    ({ ...campaignRow({ id, state, created_at: created }) }) as unknown as PublishableCampaign;

  it('puts a freshly approved campaign ahead of a retry backlog', () => {
    // The starvation case. A campaign stuck at `publishing` can retry forever;
    // the person who just approved one is watching for it now.
    const picked = selectPublishable(
      [
        c('old-retry', 'publishing', '2026-08-01T00:00:00Z'),
        c('new', 'ready', '2026-08-29T00:00:00Z'),
      ],
      1,
    );
    expect(picked.map((p) => p.id)).toEqual(['new']);
  });

  it('drains oldest first within each group', () => {
    const picked = selectPublishable(
      [c('b', 'ready', '2026-08-05T00:00:00Z'), c('a', 'ready', '2026-08-01T00:00:00Z')],
      2,
    );
    expect(picked.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('respects the cap', () => {
    const picked = selectPublishable(
      [c('a', 'ready', '2026-08-01T00:00:00Z'), c('b', 'ready', '2026-08-02T00:00:00Z')],
      1,
    );
    expect(picked).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ happy path */

describe('publishing a campaign somebody approved', () => {
  it('writes the intent row, moves the campaign, and records the platform id', async () => {
    const { client, log, state } = makeDb({});

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(result).toEqual({ attempted: 1, published: 1, failed: 0, waiting: 0 });

    const intent = log.inserts.find((i) => i.table === 'ad_entities')!;
    expect(intent.values).toMatchObject({
      campaign_id: CAMPAIGN,
      project_id: PROJECT,
      kind: 'campaign',
      parent_id: null,
      state: 'publishing',
      idempotency_key: `publish:${CAMPAIGN}:campaign`,
      channel_connection_id: 'conn-1',
    });

    // The approved brief, carried rather than regenerated.
    expect(intent.values.spec).toEqual({
      name: 'Launch campaign',
      objective: 'reach new customers',
      channel: 'meta',
      budgetCap: 400,
      currency: 'USD',
    });

    expect(state.campaigns[0]!.state).toBe('live');
    expect(state.adEntities[0]!.state).toBe('live');
    expect(state.adEntities[0]!.external_id).toBe(EXPECTED_EXTERNAL_ID);
  });

  it('moves the campaign only from the state it was read in', async () => {
    const { client, log } = makeDb({});
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    const toPublishing = log.updates.find(
      (u) => u.table === 'campaigns' && u.values.state === 'publishing',
    )!;
    expect(toPublishing.filters).toEqual({ id: CAMPAIGN, state: 'ready' });

    const toLive = log.updates.find((u) => u.table === 'campaigns' && u.values.state === 'live')!;
    expect(toLive.filters).toEqual({ id: CAMPAIGN, state: 'publishing' });
  });

  it('records an event naming the account and the platform id', async () => {
    const { client, log } = makeDb({});
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    const event = log.events.find((e) => e.verb === 'campaign.published')!;
    expect(event).toMatchObject({
      project_id: PROJECT,
      actor_kind: 'system',
      subject_type: 'campaign',
      subject_id: CAMPAIGN,
    });
    // No actor: machinery carrying out a decision made earlier is not a person
    // acting now, and dating their approval to this moment would be false.
    expect(event.actor_id).toBeUndefined();
    expect(event.payload).toMatchObject({
      external_id: EXPECTED_EXTERNAL_ID,
      provider: 'fake',
      connection_id: 'conn-1',
      already_existed: false,
    });
  });

  it('tells the room, and never writes campaign.transitioned by hand', async () => {
    const { client, log } = makeDb({});
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    const message = log.messages[0]!;
    expect(message.idempotency_key).toBe(`campaign-published:${CAMPAIGN}`);
    // Ads, not the platform. It submitted this campaign, so it is the one
    // reporting that the platform took it.
    expect(message.author_kind).toBe('agent');
    expect(message.persona).toBe('ads');
    expect(String(message.body)).toContain('is live');
    // The trigger owns that verb. Writing it here would double every entry.
    expect(log.events.some((e) => e.verb === 'campaign.transitioned')).toBe(false);
  });

  it('converts the cap from the string PostgREST returns', async () => {
    const { client, log } = makeDb({ campaigns: [campaignRow({ budget_cap: '400.00' })] });
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    const intent = log.inserts.find((i) => i.table === 'ad_entities')!;
    expect((intent.values.spec as Row).budgetCap).toBe(400);
  });
});

/* ---------------------------------------------------------------- resume */

describe('every gap between two writes resumes', () => {
  it('finds the existing intent row when the insert collides', async () => {
    const { client, log } = makeDb({
      insertConflict: true,
      adEntities: [
        {
          id: 'entity-1',
          state: 'publishing',
          external_id: null,
          idempotency_key: `publish:${CAMPAIGN}:campaign`,
        },
      ],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(result.published).toBe(1);
    // One insert attempted, none succeeded, no rival intent created.
    expect(log.inserts.filter((i) => i.table === 'ad_entities')).toHaveLength(1);
  });

  it('does not attempt the ready transition for a campaign already publishing', async () => {
    const { client, log } = makeDb({ campaigns: [campaignRow({ state: 'publishing' })] });
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(
      log.updates.some((u) => u.table === 'campaigns' && u.values.state === 'publishing'),
    ).toBe(false);
  });

  it('skips the platform entirely when the id was already recorded', async () => {
    // The crash-after-the-answer case. Asking again would be a second request
    // for a side effect whose result is sitting in front of us.
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    const { client, state } = makeDb({
      campaigns: [campaignRow({ state: 'publishing' })],
      insertConflict: true,
      adEntities: [
        {
          id: 'entity-1',
          state: 'publishing',
          external_id: 'fake:deadbeefcafe',
          idempotency_key: `publish:${CAMPAIGN}:campaign`,
        },
      ],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(calls).toHaveLength(0);
    expect(result.published).toBe(1);
    expect(state.campaigns[0]!.state).toBe('live');
    expect(state.adEntities[0]!.external_id).toBe('fake:deadbeefcafe');
  });

  it('closes the campaign to match an entity that was already closed, without re-asking', async () => {
    // The narrowest crash here: the platform refused, the entity was moved to
    // `rejected`, and the process died before the campaign followed. Re-asking
    // could produce a live object whose id nothing records.
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    const { client, state } = makeDb({
      campaigns: [campaignRow({ state: 'publishing' })],
      insertConflict: true,
      adEntities: [
        {
          id: 'entity-1',
          state: 'rejected',
          external_id: null,
          idempotency_key: `publish:${CAMPAIGN}:campaign`,
        },
      ],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(calls).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(state.campaigns[0]!.state).toBe('failed');
  });

  it('reports a resumed publish as already existing, not as a new creation', async () => {
    const { client, log } = makeDb({
      campaigns: [campaignRow({ state: 'publishing' })],
      insertConflict: true,
      adEntities: [
        {
          id: 'entity-1',
          state: 'publishing',
          external_id: 'fake:deadbeefcafe',
          idempotency_key: `publish:${CAMPAIGN}:campaign`,
        },
      ],
    });
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    const event = log.events.find((e) => e.verb === 'campaign.published')!;
    expect((event.payload as Row).already_existed).toBe(true);
  });
});

/* ------------------------------------------------------- refusing to send */

describe('the platform is not called for a campaign that should not publish', () => {
  it('stops when the campaign was cancelled while the pass was reading', async () => {
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    // The row the sweep read said `ready`; by the time it writes, it is not.
    const db = makeDb({ cancelAfterRead: true });

    const result = await publishSweep({
      admin: db.client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(calls).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(db.state.adEntities[0]!.state).toBe('failed');
    expect(db.state.campaigns[0]!.state).toBe('cancelled');
  });

  it('refuses a campaign with no authorised cap rather than publishing a zero', async () => {
    // `Number(null)` is 0, which is finite and non-negative and would parse
    // cleanly into a spec authorising nothing while reporting success.
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    const { client, log, state } = makeDb({ campaigns: [campaignRow({ budget_cap: null })] });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(calls).toHaveLength(0);
    expect(result.waiting).toBe(1);
    expect(state.campaigns[0]!.state).toBe('ready');
    expect(String(log.messages[0]!.idempotency_key)).toContain('campaign-publish-blocked');
  });

  it('refuses when the connection lacks the scope, before asking', async () => {
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    const { client, log } = makeDb({
      connections: [connectionRow({ granted_scopes: ['ads:read'] })],
    });

    await publishSweep({ admin: client, maxPerPass: 5, log: silentLog, adapters: () => adapter });

    expect(calls).toHaveLength(0);
    expect(String(log.messages[0]!.body)).toContain('ads:write');
  });

  it('tells the owner to reconnect when the only connection expired', async () => {
    const { client, log } = makeDb({ connections: [connectionRow({ status: 'expired' })] });
    await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    // Not "no account connected", which would send them to do a thing they did.
    expect(String(log.messages[0]!.body)).toContain('expired');
  });

  it('leaves a campaign at ready and says so when no account is connected', async () => {
    const { client, log, state } = makeDb({ connections: [] });
    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(result.waiting).toBe(1);
    expect(state.campaigns[0]!.state).toBe('ready');
    expect(log.messages).toHaveLength(1);
    expect(String(log.messages[0]!.body)).toContain('Nothing has been spent');
  });

  it('says it once, however many passes run', async () => {
    const db = makeDb({ connections: [] });
    await publishSweep({
      admin: db.client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });
    await publishSweep({
      admin: db.client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(db.log.messages).toHaveLength(1);
    // Attempted twice, stored once: the key is doing the work, not a read.
    expect(db.log.inserts.filter((i) => i.table === 'messages')).toHaveLength(2);
  });

  it('skips a campaign whose project is no longer active, and says how many', async () => {
    const { adapter, calls } = stubAdapter({
      ok: true,
      value: { externalId: 'x' },
      alreadyExisted: false,
    });
    const recorder = recordingLog();
    const { client } = makeDb({
      projects: [{ id: PROJECT, status: 'completed', source_embed_id: EMBED }],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: recorder.log,
      adapters: () => adapter,
    });

    expect(calls).toHaveLength(0);
    expect(result.attempted).toBe(0);
    expect(recorder.lines.some((l) => l.msg.includes('project is not active'))).toBe(true);
  });
});

/* ------------------------------------------------------ what came back */

describe('what the platform answered', () => {
  it('closes a policy rejection and quotes the platform to the owner', async () => {
    const { client, log, state } = makeDb({
      campaigns: [campaignRow({ name: `Launch ${POLICY_VIOLATION_MARKER}` })],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => createFakeAdapter(),
    });

    expect(result.failed).toBe(1);
    expect(state.campaigns[0]!.state).toBe('failed');
    expect(state.adEntities[0]!.state).toBe('rejected');
    expect(state.adEntities[0]!.external_id).toBeUndefined();

    const body = String(log.messages[0]!.body);
    expect(body).toContain('The platform disapproved this creative.');
    // The dead end this repository has already built twice: a person told
    // something failed, with nowhere to go.
    expect(body).toContain('approve a new');
    expect(log.events.some((e) => e.verb === 'campaign.publish_rejected')).toBe(true);
  });

  it('closes an invalid spec as our defect, not the platform disapproving', async () => {
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'invalid_spec', message: 'Bad.' },
    });
    const { client, log, state } = makeDb({});

    await publishSweep({ admin: client, maxPerPass: 5, log: silentLog, adapters: () => adapter });

    expect(state.campaigns[0]!.state).toBe('failed');
    expect(state.adEntities[0]!.state).toBe('failed');
    expect(String(log.messages[0]!.body)).toContain('fault on our');
    expect(log.events.some((e) => e.verb === 'campaign.publish_failed')).toBe(true);
  });

  it('marks the connection expired and waits, rather than closing the campaign', async () => {
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'auth_expired', message: 'Expired.' },
    });
    const { client, log, state } = makeDb({});

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(result.waiting).toBe(1);
    expect(state.campaigns[0]!.state).toBe('publishing');
    expect(state.connections[0]!.status).toBe('expired');
    expect(log.updates.some((u) => u.table === 'channel_connections')).toBe(true);
  });

  it('leaves everything alone on a rate limit, and says nothing to the room', async () => {
    // Not owner-actionable, and a message every thirty seconds about a condition
    // that fixes itself is noise on the surface the important messages live on.
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'rate_limited', message: 'Slow down.', retryAfterMs: 1000 },
    });
    const { client, log, state } = makeDb({});

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => adapter,
    });

    expect(result.waiting).toBe(1);
    expect(state.campaigns[0]!.state).toBe('publishing');
    expect(state.adEntities[0]!.state).toBe('publishing');
    expect(log.messages).toHaveLength(0);
  });

  it('retries a provider error rather than destroying an authorised campaign', async () => {
    const { adapter } = stubAdapter({
      ok: false,
      error: { kind: 'provider_error', message: 'Upstream down.', status: 503 },
    });
    const { client, state } = makeDb({});

    await publishSweep({ admin: client, maxPerPass: 5, log: silentLog, adapters: () => adapter });

    expect(state.campaigns[0]!.state).toBe('publishing');
  });
});

/* -------------------------------------------------------------- failures */

describe('one bad campaign does not cost the others their pass', () => {
  it('catches a transport throw and carries on', async () => {
    const other = campaignRow({
      id: '22222222-2222-4222-8222-222222222222',
      created_at: '2026-08-29T11:00:00.000Z',
    });
    const { client, state } = makeDb({ campaigns: [campaignRow(), other] });
    const recorder = recordingLog();

    let first = true;
    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: recorder.log,
      adapters: () => {
        if (first) {
          first = false;
          return stubAdapter(() => {
            throw new Error('socket hang up');
          }).adapter;
        }
        return createFakeAdapter();
      },
    });

    expect(result.attempted).toBe(2);
    expect(result.published).toBe(1);
    expect(result.waiting).toBe(1);
    // The one that threw stays where it was, for the next pass to re-drive.
    expect(state.campaigns[0]!.state).toBe('publishing');
    expect(recorder.lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('publishes even when the event cannot be written', async () => {
    // An event that failed to write must not undo a publish that happened.
    const recorder = recordingLog();
    const { client, state } = makeDb({ failEvents: true });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: recorder.log,
      adapters: () => createFakeAdapter(),
    });

    expect(result.published).toBe(1);
    expect(state.campaigns[0]!.state).toBe('live');
    expect(recorder.lines.some((l) => l.msg.includes('not recorded'))).toBe(true);
  });

  it('is a quiet no-op when there is nothing to publish', async () => {
    const { client } = makeDb({ campaigns: [] });
    const result = await publishSweep({ admin: client, maxPerPass: 5, log: silentLog });

    expect(result).toEqual({ attempted: 0, published: 0, failed: 0, waiting: 0 });
  });

  it('warns and skips when a project has no room to publish into', async () => {
    const recorder = recordingLog();
    const { client } = makeDb({
      projects: [{ id: PROJECT, status: 'active', source_embed_id: null }],
    });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: recorder.log,
      adapters: () => createFakeAdapter(),
    });

    expect(result.waiting).toBe(1);
    expect(recorder.lines.some((l) => l.msg.includes('no room'))).toBe(true);
  });
});

describe('the registry is the authority on providers', () => {
  it('does not publish through a provider nobody registered', async () => {
    const spy = vi.fn();
    const { client, log, state } = makeDb({ connections: [connectionRow({ provider: 'meta' })] });

    const result = await publishSweep({
      admin: client,
      maxPerPass: 5,
      log: silentLog,
      adapters: () => {
        spy();
        return createFakeAdapter();
      },
    });

    expect(spy).not.toHaveBeenCalled();
    expect(result.waiting).toBe(1);
    expect(state.campaigns[0]!.state).toBe('ready');
    expect(String(log.messages[0]!.body)).toContain('cannot publish through');
  });
});
