/**
 * The model routes, exercised through Fastify rather than as extracted
 * functions, for the reason `connections.test.ts` gives: **the authorisation
 * split is the security property of this slice and it lives in the handlers**.
 *
 * `model_connections` has no grant to `authenticated` at all, so these handlers
 * cannot read as the caller and let RLS decide. They read the room as the
 * caller to establish membership, then touch the table as the service role. The
 * route is the entire control, and an untested control is a comment.
 *
 * Five things are pinned here:
 *
 *   1. **Reading is any member, writing is the owner.** Which model wrote a
 *      message is already visible on the message; pasting a key is not.
 *   2. **A room RLS hides is 404**, never 403.
 *   3. **The key is checked with the provider before anything is written**, and
 *      a refused key writes nothing at all.
 *   4. **No master key means nothing is stored**, with the variable named,
 *      rather than a key kept somewhere it cannot be protected.
 *   5. **The response never carries a key**, in any casing, on any route.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ROOM = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const SECRET = 'd'.repeat(64);
const REAL_KEY = 'sk-ant-api03-not-a-real-key-4f2a';

let roomRow: { owner_id: string | null } | null;
let connectionRows: Record<string, unknown>[];
let routeRows: Record<string, unknown>[];
let revokedRow: Record<string, unknown> | null;
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let events: Record<string, unknown>[];

vi.mock('../lib/supabase', () => {
  const serviceBuilder = (table: string) => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      neq: () => b,
      delete: () => {
        written.push({ table, op: 'delete' });
        return b;
      },
      insert: async (values: Record<string, unknown>) => {
        if (table === 'events') events.push(values);
        return { data: null, error: null };
      },
      upsert: (values: Record<string, unknown>) => {
        written.push({ table, op: 'upsert', values });
        return b;
      },
      update: (values: Record<string, unknown>) => {
        written.push({ table, op: 'update', values });
        return b;
      },
      order: async () => ({ data: connectionRows, error: null }),
      maybeSingle: async () => ({
        data: table === 'model_connections' ? (revokedRow ?? connectionRows[0] ?? null) : null,
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: routeRows, error: null }),
    });
    return b;
  };

  return {
    createUserClient: () => ({
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: roomRow, error: null }),
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: table === 'model_routes' ? routeRows : [], error: null }),
        });
        return b;
      },
    }),
    createServiceClient: () => ({ from: serviceBuilder }),
  };
});

/** Stubbed so no test reaches a provider, and so each can choose the answer. */
let verifyResult: { ok: true } | { ok: false; reason: 'invalid_key' | 'unreachable' };
vi.mock('../lib/model-providers', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, verifyKey: async () => verifyResult };
});

/** The AI service is not running in a unit test, so Auto is simply unknown. */
vi.mock('../lib/ai', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, requestHouseDefault: async () => null };
});

const { modelRoutes } = await import('./models');

async function build(
  userId: string | null,
  modelKeySecret: string | null = SECRET,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(modelRoutes, {
    verify: async (token: string) => {
      if (!userId) throw new Error('no token');
      return { sub: token, role: 'user' as const };
    },
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    modelKeySecret,
    aiServiceUrl: 'http://ai:8000',
  });
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

const activeAnthropic = {
  id: CONNECTION,
  provider: 'anthropic',
  key_hint: '4f2a',
  status: 'active',
  created_at: '2026-09-13T10:00:00.000Z',
};

beforeEach(() => {
  roomRow = { owner_id: OWNER };
  connectionRows = [];
  routeRows = [];
  revokedRow = null;
  written = [];
  events = [];
  verifyResult = { ok: true };
});

describe('GET /models', () => {
  it('lets any member read the projection', async () => {
    connectionRows = [activeAnthropic];
    routeRows = [{ role: 'strategist', provider: 'anthropic', model: 'claude-opus-5' }];
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/models`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connections[0]).toMatchObject({ provider: 'anthropic', keyHint: '4f2a' });
    expect(res.json().routes[0]).toMatchObject({ role: 'strategist', model: 'claude-opus-5' });
  });

  it('never carries a key, in any casing', async () => {
    connectionRows = [activeAnthropic];
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/models`,
      headers: as(MEMBER),
    });

    for (const forbidden of ['key_ciphertext', 'apiKey', 'api_key', 'key_iv', 'key_tag']) {
      expect(res.payload).not.toContain(forbidden);
    }
  });

  it('answers 404 for a room RLS hides, rather than 403', async () => {
    roomRow = null;
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/models`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /models/connections', () => {
  const body = { provider: 'anthropic', apiKey: REAL_KEY };

  it('seals the key and never writes the plaintext', async () => {
    connectionRows = [activeAnthropic];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    const upsert = written.find((w) => w.table === 'model_connections')!.values!;
    expect(upsert.key_ciphertext).toBeTruthy();
    expect(upsert.key_iv).toBeTruthy();
    expect(upsert.key_tag).toBeTruthy();
    expect(upsert.key_hint).toBe('4f2a');
    expect(JSON.stringify(upsert)).not.toContain(REAL_KEY);
    expect(res.payload).not.toContain(REAL_KEY);
  });

  it('records the connection as an event, without the key', async () => {
    connectionRows = [activeAnthropic];
    const app = await build(OWNER);
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: body,
    });

    expect(events[0]).toMatchObject({
      verb: 'model.connected',
      actor_id: OWNER,
      actor_kind: 'user',
    });
    expect(JSON.stringify(events[0])).not.toContain(REAL_KEY);
  });

  it('refuses a member who is not the owner', async () => {
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(MEMBER),
      payload: body,
    });

    expect(res.statusCode).toBe(403);
    expect(written).toEqual([]);
  });

  it('refuses an unregistered provider', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: { provider: 'mystery', apiKey: REAL_KEY },
    });

    expect(res.statusCode).toBe(400);
    expect(written).toEqual([]);
  });

  it('writes nothing when the provider refuses the key', async () => {
    verifyResult = { ok: false, reason: 'invalid_key' };
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_key');
    expect(written).toEqual([]);
  });

  it('writes nothing when the provider could not be reached', async () => {
    // A different status and a different sentence: this one is not the person's
    // to fix, and a key stored unchecked would show "connected" for something
    // that may never work.
    verifyResult = { ok: false, reason: 'unreachable' };
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: body,
    });

    expect(res.statusCode).toBe(502);
    expect(written).toEqual([]);
  });

  it('names the missing variable rather than storing a key it cannot protect', async () => {
    const app = await build(OWNER, null);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/models/connections`,
      headers: as(OWNER),
      payload: body,
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('MODEL_KEY_SECRET');
    expect(written).toEqual([]);
  });
});

describe('DELETE /models/connections/:id', () => {
  it('revokes, records it, and answers 409 the second time', async () => {
    revokedRow = { ...activeAnthropic, status: 'revoked' };
    const app = await build(OWNER);
    const first = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${ROOM}/models/connections/${CONNECTION}`,
      headers: as(OWNER),
    });
    expect(first.statusCode).toBe(200);
    expect(events[0]).toMatchObject({ verb: 'model.revoked' });

    // Already revoked, so the conditional update matches nothing. 409 rather
    // than 404, because the caller's next move is the same and distinguishing
    // them would confirm which ids exist in a room.
    revokedRow = null;
    connectionRows = [];
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${ROOM}/models/connections/${CONNECTION}`,
      headers: as(OWNER),
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a member who is not the owner', async () => {
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${ROOM}/models/connections/${CONNECTION}`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(403);
    expect(written).toEqual([]);
  });
});

describe('PATCH /models/routes', () => {
  const patch = (routes: unknown[]) => ({ routes });

  it('sets a route for a connected provider', async () => {
    connectionRows = [activeAnthropic];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'strategist', provider: 'anthropic', model: 'claude-opus-5' }]),
    });

    expect(res.statusCode).toBe(200);
    expect(written.some((w) => w.table === 'model_routes' && w.op === 'upsert')).toBe(true);
    expect(events[0]).toMatchObject({ verb: 'model.route_set' });
  });

  it('refuses a model the provider does not offer', async () => {
    connectionRows = [activeAnthropic];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'strategist', provider: 'anthropic', model: 'gpt-5.4' }]),
    });

    expect(res.statusCode).toBe(400);
    expect(written).toEqual([]);
  });

  it('refuses a provider with no active key', async () => {
    connectionRows = [];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'strategist', provider: 'anthropic', model: 'claude-opus-5' }]),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_connected');
  });

  it('refuses an image model for a text role, and a text model for creative', async () => {
    connectionRows = [{ ...activeAnthropic, provider: 'google' }];
    const app = await build(OWNER);

    const textRoleGetsImage = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'content', provider: 'google', model: 'gemini-3.1-flash-image' }]),
    });
    expect(textRoleGetsImage.statusCode).toBe(400);

    const creativeGetsText = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'creative', provider: 'google', model: 'gemini-3.8-flash' }]),
    });
    expect(creativeGetsText.statusCode).toBe(400);
  });

  it('always allows clearing a role, even for a provider no longer connected', async () => {
    // Going back to Auto must never be blocked by the state that made somebody
    // want to.
    connectionRows = [];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(OWNER),
      payload: patch([{ role: 'strategist', provider: null, model: null }]),
    });

    expect(res.statusCode).toBe(200);
    expect(written.some((w) => w.table === 'model_routes' && w.op === 'delete')).toBe(true);
  });

  it('refuses a member who is not the owner', async () => {
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${ROOM}/models/routes`,
      headers: as(MEMBER),
      payload: patch([{ role: 'strategist', provider: 'anthropic', model: 'claude-opus-5' }]),
    });

    expect(res.statusCode).toBe(403);
    expect(written).toEqual([]);
  });
});
