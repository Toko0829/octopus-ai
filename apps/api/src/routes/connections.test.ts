/**
 * The connect routes, exercised through Fastify rather than as extracted
 * functions, because **the authorisation split is the security property of this
 * slice and it lives in the handlers**.
 *
 * Every other read in this codebase runs as the caller and lets RLS decide, so a
 * route test would mostly be re-testing Postgres. `channel_connections` has no
 * grant to `authenticated` at all, so these handlers cannot do that: they read
 * the room as the caller to establish membership, then touch the table as the
 * service role. The route is the entire control, and an untested control is a
 * comment.
 *
 * Four things are pinned here:
 *
 *   1. **Reading is any member, writing is the owner.** The migration promised
 *      members a view; connecting an account is `high_risk` and is not.
 *   2. **A room RLS hides is 404**, never 403, so the API does not confirm the
 *      existence of a workspace somebody cannot see.
 *   3. **The state is verified before the code is touched**, and a state issued
 *      for another room, user or provider is refused.
 *   4. **A refusal on the consent screen writes nothing** and is reported as the
 *      person's decision rather than as an error.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const ROOM = '11111111-1111-4111-8111-111111111111';

/** What the stubbed clients answer. Reassigned per test. */
let roomRow: { owner_id: string | null } | null;
let connectionRows: Record<string, unknown>[];
let written: Record<string, unknown>[];

vi.mock('../lib/supabase', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      neq: () => b,
      insert: async () => ({ data: null, error: null }),
      upsert: (values: Record<string, unknown>) => {
        written.push(values);
        return b;
      },
      update: (values: Record<string, unknown>) => {
        written.push(values);
        return b;
      },
      order: async () => ({ data: connectionRows, error: null }),
      maybeSingle: async () => ({ data: connectionRows[0] ?? null, error: null }),
    });
    return b;
  };

  return {
    createUserClient: () => ({
      from: () => {
        const b: Record<string, unknown> = {};
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: roomRow, error: null }),
        });
        return b;
      },
    }),
    createServiceClient: () => ({ from: builder }),
  };
});

const { connectionRoutes } = await import('./connections');
const { signState } = await import('../lib/oauth-state');
const { fakeAuthorizationCode } = await import('@octopus/marketing');

const STATE = { secret: 'k'.repeat(48), ttlSeconds: 600 };

async function build(userId: string | null): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(connectionRoutes, {
    // Stands in for JWKS verification. The token is the subject, so a test can
    // choose who is calling without minting a real JWT.
    verify: async (token: string) => {
      if (!userId) throw new Error('no token');
      return { sub: token, role: 'user' as const };
    },
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    webUrl: 'http://localhost:3000',
    state: STATE,
  });
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

beforeEach(() => {
  roomRow = { owner_id: OWNER };
  connectionRows = [];
  written = [];
});

describe('GET /connections', () => {
  it('lets any member read the projection', async () => {
    connectionRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        provider: 'fake',
        channel: 'meta',
        external_account_id: 'fake-acct:x',
        granted_scopes: ['ads:read'],
        status: 'active',
        token_expires_at: null,
        created_at: '2026-08-29T11:00:00.000Z',
      },
    ];
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/connections`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(200);
    // The projection the migration promised: a member sees the account, never
    // the credential.
    expect(res.json().connections[0]).toMatchObject({ provider: 'fake', channel: 'meta' });
    expect(res.payload).not.toContain('access_token');
    expect(res.payload).not.toContain('accessToken');
  });

  it('answers 404 for a room RLS hides, rather than 403', async () => {
    roomRow = null;
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/connections`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /connections/start', () => {
  it('returns an authorize URL carrying a signed state', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/start`,
      headers: as(OWNER),
      payload: { provider: 'fake', channel: 'meta' },
    });

    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().authorizeUrl);
    expect(url.pathname).toBe('/connections/fake-consent');
    // Composed by the API, never accepted from the caller: a client that could
    // name its own redirect URI could send somebody's code elsewhere.
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/connections/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('refuses a member who does not own the workspace', async () => {
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/start`,
      headers: as(MEMBER),
      payload: { provider: 'fake', channel: 'meta' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('refuses an unregistered provider before signing anything', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/start`,
      headers: as(OWNER),
      payload: { provider: 'meta', channel: 'meta' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('meta');
  });

  it('refuses with the variable named when no signing secret is set', async () => {
    const app = Fastify();
    await app.register(connectionRoutes, {
      verify: async (token: string) => ({ sub: token, role: 'user' as const }),
      supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
      webUrl: 'http://localhost:3000',
      state: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/start`,
      headers: as(OWNER),
      payload: { provider: 'fake', channel: 'meta' },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().message).toContain('OAUTH_STATE_SECRET');
  });
});

describe('POST /connections/callback', () => {
  const validState = (over: Partial<Record<string, string>> = {}) =>
    signState(
      { roomId: ROOM, userId: OWNER, provider: 'fake', channel: 'meta', ...over },
      STATE,
      Date.now(),
      'n',
    );

  it('exchanges the code and stores the connection', async () => {
    connectionRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        provider: 'fake',
        channel: 'meta',
        external_account_id: 'fake-acct:x',
        granted_scopes: ['ads:read'],
        status: 'active',
        token_expires_at: '2026-08-29T12:00:00.000Z',
        created_at: '2026-08-29T11:00:00.000Z',
      },
    ];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/callback`,
      headers: as(OWNER),
      payload: { state: validState(), code: fakeAuthorizationCode(['ads:read']) },
    });

    expect(res.statusCode).toBe(201);
    // The token reached the row and never the response.
    expect(written[0]?.access_token).toMatch(/^fake-access:/);
    expect(res.payload).not.toContain('fake-access');
  });

  it('refuses a state issued for another workspace', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/callback`,
      headers: as(OWNER),
      payload: {
        state: validState({ roomId: '99999999-9999-4999-8999-999999999999' }),
        code: fakeAuthorizationCode(['ads:read']),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('refuses a state issued to another person', async () => {
    // The second leg of ADR-0012: a state lifted from one browser's history is
    // useless in somebody else's session.
    roomRow = { owner_id: MEMBER };
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/callback`,
      headers: as(MEMBER),
      payload: { state: validState(), code: fakeAuthorizationCode(['ads:read']) },
    });

    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('writes nothing when the person declined', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/callback`,
      headers: as(OWNER),
      payload: { state: validState(), error: 'access_denied' },
    });

    // Their decision, reported as one: 409 with the reason, not a 500.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('access_denied');
    expect(written).toHaveLength(0);
  });

  it('refuses a code the provider did not issue', async () => {
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${ROOM}/connections/callback`,
      headers: as(OWNER),
      payload: { state: validState(), code: 'someone-elses-code' },
    });

    expect(res.statusCode).toBe(502);
    expect(written).toHaveLength(0);
  });
});

describe('DELETE /connections/:id', () => {
  it('revokes and nulls the tokens', async () => {
    connectionRows = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        provider: 'fake',
        channel: 'meta',
        external_account_id: 'fake-acct:x',
        granted_scopes: [],
        status: 'revoked',
        token_expires_at: null,
        created_at: '2026-08-29T11:00:00.000Z',
      },
    ];
    const app = await build(OWNER);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${ROOM}/connections/44444444-4444-4444-8444-444444444444`,
      headers: as(OWNER),
    });

    expect(res.statusCode).toBe(200);
    expect(written[0]).toMatchObject({
      status: 'revoked',
      access_token: null,
      refresh_token: null,
    });
  });

  it('refuses a member who does not own the workspace', async () => {
    const app = await build(MEMBER);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/rooms/${ROOM}/connections/44444444-4444-4444-8444-444444444444`,
      headers: as(MEMBER),
    });

    expect(res.statusCode).toBe(403);
    expect(written).toHaveLength(0);
  });
});
