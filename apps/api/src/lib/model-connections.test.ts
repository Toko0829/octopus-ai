/**
 * The IO half: what the projection selects, and what a revocation actually does.
 *
 * `SELECTED_COLUMNS` is the only thing standing between a room member and a
 * sealed customer key, so it is pinned as a string rather than trusted to
 * review. A `select *` here would be a silent, total leak of the ciphertext, the
 * IV and the tag to every member, and it is exactly the edit somebody makes
 * while debugging.
 *
 * The revocation test covers the part with no precedent: revoking a key also
 * deletes the routes that pointed at it, so a role can never resolve to a
 * provider whose key is gone.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  SELECTED_COLUMNS,
  revokeModelConnection,
  writeModelConnection,
  writeRoutes,
} from './model-connections';
import { modelConnectionAad, open, parseMasterKey } from './envelope';

const ROOM = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const HEX = 'c'.repeat(64);

describe('SELECTED_COLUMNS', () => {
  it('carries no key column beyond the hint', () => {
    expect(SELECTED_COLUMNS).not.toContain('key_ciphertext');
    expect(SELECTED_COLUMNS).not.toContain('key_iv');
    expect(SELECTED_COLUMNS).not.toContain('key_tag');
    expect(SELECTED_COLUMNS).toContain('key_hint');
  });

  it('is never a wildcard', () => {
    // The one edit that would defeat every assertion above at once.
    expect(SELECTED_COLUMNS).not.toContain('*');
  });
});

/** A Supabase double that records what each table was asked to do. */
function stubClient(rows: Record<string, Record<string, unknown> | null>) {
  const calls: { table: string; op: string; values?: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        neq: () => b,
        delete: () => {
          calls.push({ table, op: 'delete' });
          return b;
        },
        update: (values: Record<string, unknown>) => {
          calls.push({ table, op: 'update', values });
          return b;
        },
        upsert: (values: Record<string, unknown>) => {
          calls.push({ table, op: 'upsert', values });
          return b;
        },
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      });
      return b;
    },
  };
  return { client, calls };
}

const connectionRow = {
  id: CONNECTION,
  provider: 'anthropic',
  key_hint: '4f2a',
  status: 'revoked',
  created_at: '2026-09-13T10:00:00.000Z',
};

describe('writeModelConnection', () => {
  it('refuses to store anything without a master key', async () => {
    // The refusal lives here rather than only in the route, on the reasoning
    // `writeConnection` records: a check three lines into a handler is a check
    // the next handler forgets.
    const { client, calls } = stubClient({});
    await expect(
      writeModelConnection(client as never, {
        roomId: ROOM,
        connectedBy: OWNER,
        provider: 'anthropic',
        apiKey: 'sk-ant-4f2a',
        secret: null,
        now: new Date(),
      }),
    ).rejects.toThrow(/MODEL_KEY_SECRET/);
    expect(calls).toEqual([]);
  });

  it('writes a seal that opens under the row it was written for, and never the key', async () => {
    const { client, calls } = stubClient({
      model_connections: { ...connectionRow, status: 'active' },
    });
    await writeModelConnection(client as never, {
      roomId: ROOM,
      connectedBy: OWNER,
      provider: 'anthropic',
      apiKey: 'sk-ant-secret-4f2a',
      secret: HEX,
      now: new Date('2026-09-13T10:00:00.000Z'),
    });

    const written = calls[0]!.values as Record<string, string>;
    expect(JSON.stringify(written)).not.toContain('sk-ant-secret');
    expect(written.key_hint).toBe('4f2a');
    expect(
      open(
        { ciphertext: written.key_ciphertext!, iv: written.key_iv!, tag: written.key_tag! },
        parseMasterKey(HEX),
        modelConnectionAad(ROOM, 'anthropic', Number(written.key_version)),
      ),
    ).toBe('sk-ant-secret-4f2a');
  });
});

describe('revokeModelConnection', () => {
  it('nulls all three key columns and keeps the row', async () => {
    const { client, calls } = stubClient({ model_connections: connectionRow });
    const result = await revokeModelConnection(client as never, ROOM, CONNECTION, new Date());

    expect(result?.status).toBe('revoked');
    const update = calls.find((c) => c.op === 'update')!.values as Record<string, unknown>;
    expect(update.key_ciphertext).toBeNull();
    expect(update.key_iv).toBeNull();
    expect(update.key_tag).toBeNull();
    // The record survives: "connected on this date, by this person, disconnected
    // on that one" is audit trail worth keeping, and the credential is not.
    expect(update.status).toBe('revoked');
  });

  it('deletes the routes that pointed at that provider', async () => {
    // Without this a role resolves to a provider whose key is gone, and
    // `resolveGeneration` would have to choose between failing the run and
    // silently using the house key. The state is made unreachable instead.
    const { client, calls } = stubClient({ model_connections: connectionRow });
    await revokeModelConnection(client as never, ROOM, CONNECTION, new Date());

    expect(calls.some((c) => c.table === 'model_routes' && c.op === 'delete')).toBe(true);
  });

  it('touches no routes when nothing was revoked', async () => {
    const { client, calls } = stubClient({ model_connections: null });
    const result = await revokeModelConnection(client as never, ROOM, CONNECTION, new Date());

    expect(result).toBeNull();
    expect(calls.some((c) => c.table === 'model_routes')).toBe(false);
  });
});

describe('writeRoutes', () => {
  it('deletes rather than storing a null, because no row is what Auto means', async () => {
    const { client, calls } = stubClient({});
    await writeRoutes(
      client as never,
      ROOM,
      OWNER,
      [{ role: 'strategist', provider: null, model: null }],
      new Date(),
    );

    expect(calls).toEqual([{ table: 'model_routes', op: 'delete' }]);
  });

  it('upserts a set role', async () => {
    const { client, calls } = stubClient({});
    await writeRoutes(
      client as never,
      ROOM,
      OWNER,
      [{ role: 'ads', provider: 'openai', model: 'gpt-5.4' }],
      new Date('2026-09-13T10:00:00.000Z'),
    );

    expect(calls[0]!.op).toBe('upsert');
    expect(calls[0]!.values).toMatchObject({
      room_id: ROOM,
      role: 'ads',
      provider: 'openai',
      model: 'gpt-5.4',
      updated_by: OWNER,
    });
  });
});
