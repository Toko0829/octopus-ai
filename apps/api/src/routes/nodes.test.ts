/**
 * Route tests rather than unit tests, for the reason `connections.test.ts` gives
 * about itself: **the route is the entire control on the write path, and an
 * untested control is a comment.**
 *
 * None of the four marketplace tables has an INSERT or UPDATE grant to
 * `authenticated`, so every write here runs under the service key. RLS therefore
 * defends nothing on the way in; what stands between an authenticated stranger
 * and somebody else's node record is the as-the-caller read at the top of each
 * handler and the fact that every writer is constrained on the id it returned.
 *
 * The properties pinned:
 *
 *   1. **A non-node gets 404, never 403.** Whether somebody is a node is not a
 *      fact a stranger gets to confirm.
 *   2. **A body carrying a server-only field is refused, not trimmed.** A silent
 *      drop returns 200 and lets somebody believe a control applied.
 *   3. **Nothing writes a node id the caller did not prove.** Asserted by reading
 *      what the stubbed writers were handed.
 *   4. **No response carries a verification record.** The subject of one is
 *      refused it by grant; projecting it through the service key would hand back
 *      exactly what the grant withheld.
 *   5. **An unknown skill and an unregistered verifier are both refused.**
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const NODE = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';

/** What the stubbed clients answer. Reassigned per test. */
let profileRow: Record<string, unknown> | null;
let skillRows: Record<string, unknown>[];
let credentialRows: Record<string, unknown>[];
/** Every table a writer touched, with the values and the filters it applied. */
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let filters: { column: string; value: unknown }[];
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let insertError: { code: string } | null;
let updateError: { code: string } | null;

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const rowsFor = () =>
        table === 'node_skills' ? skillRows : table === 'node_credentials' ? credentialRows : [];
      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          return b;
        },
        is: (column: string, value: unknown) => {
          filters.push({ column, value });
          return b;
        },
        order: async () => ({ data: rowsFor(), error: null }),
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          if (insertError && table !== 'events') {
            return Object.assign(b, {
              maybeSingle: async () => ({ data: null, error: insertError }),
              then: undefined,
            });
          }
          // `events` is inserted without a `.select()`, so the builder itself has
          // to be awaitable the way postgrest-js's is.
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          if (updateError) {
            return Object.assign(b, {
              maybeSingle: async () => ({ data: null, error: updateError }),
              then: (resolve: (v: unknown) => unknown) =>
                resolve({ data: null, error: updateError }),
            });
          }
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        delete: () => {
          written.push({ table, op: 'delete' });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: skillRows, error: null }),
          });
        },
        maybeSingle: async () => {
          if (table === 'node_profiles') return { data: profileRow, error: null };
          if (table === 'node_skills') return { data: skillRows[0] ?? null, error: null };
          if (table === 'node_credentials') return { data: credentialRows[0] ?? null, error: null };
          return { data: null, error: null };
        },
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      return { data: 'verified', error: null };
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { nodeRoutes } = await import('./nodes');
const { fakeVerificationRef } = await import('@octopus/marketplace');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(nodeRoutes, {
    // Stands in for JWKS verification. The token is the subject, so a test can
    // choose who is calling without minting a real JWT.
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
  });
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

function aProfile(over: Record<string, unknown> = {}) {
  return {
    user_id: NODE,
    kyc_status: 'unverified',
    availability: 'paused',
    trust_score: null,
    completed_engagements: 0,
    service_jurisdictions: ['US-TX'],
    languages: ['en'],
    rate: null,
    rate_period: null,
    currency: 'USD',
    ...over,
  };
}

beforeEach(() => {
  profileRow = aProfile();
  skillRows = [];
  credentialRows = [];
  written = [];
  filters = [];
  rpcCalls = [];
  insertError = null;
  updateError = null;
});

describe('who can reach any of this', () => {
  it('refuses an unauthenticated caller', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404, not 403, to somebody who is not a node', async () => {
    // The select-own policy returns zero rows to a stranger and to a signed-in
    // person who was never invited alike, so the route never has to tell them
    // apart, and neither of them learns whether a record exists.
    profileRow = null;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node', headers: as(STRANGER) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('writes nothing when the caller is not a node', async () => {
    profileRow = null;
    const app = await build();
    await app.inject({
      method: 'PATCH',
      url: '/api/node',
      headers: as(STRANGER),
      payload: { availability: 'available' },
    });
    expect(written.filter((w) => w.op !== 'insert' || w.table !== 'events')).toEqual([]);
  });
});

describe('GET /api/node', () => {
  it('returns the caller their own record', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node', headers: as(NODE) });
    expect(res.statusCode).toBe(200);
    expect(res.json().node.userId).toBe(NODE);
  });

  it('carries no verification record of any kind', async () => {
    // The subject of a node_verifications row is refused it by grant, because a
    // face-search result names a third party. Asserted on the serialised body
    // rather than on a field name, since this has to stay true however the
    // projection is spelled.
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node', headers: as(NODE) });
    expect(res.body).not.toContain('verification');
    expect(res.body).not.toContain('matched');
  });

  it('carries no evidence path and no suspension note', async () => {
    credentialRows = [
      {
        id: CREDENTIAL,
        kind: 'notary',
        jurisdiction: 'US-TX',
        issuer: null,
        licence_number: null,
        verified: false,
        revoked_at: null,
      },
    ];
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node', headers: as(NODE) });
    expect(res.body).not.toContain('evidence');
    expect(res.body).not.toContain('suspended_reason');
  });
});

describe('PATCH /api/node', () => {
  it('accepts the fields a node owns', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/node',
      headers: as(NODE),
      payload: { languages: ['en', 'ka'] },
    });
    expect(res.statusCode).toBe(200);
    expect(written.find((w) => w.table === 'node_profiles')?.values).toMatchObject({
      languages: ['en', 'ka'],
    });
  });

  it.each(['kycStatus', 'trustScore', 'completedEngagements', 'suspendedReason'])(
    'refuses a body carrying %s rather than dropping it',
    async (field) => {
      // A trimmed field returns 200 and lets somebody believe the write applied.
      const app = await build();
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/node',
        headers: as(NODE),
        payload: { [field]: field === 'trustScore' ? 1 : 'verified' },
      });
      expect(res.statusCode).toBe(400);
      expect(written.filter((w) => w.table === 'node_profiles')).toEqual([]);
    },
  );

  it('refuses a rate without its period', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/node',
      headers: as(NODE),
      payload: { rate: 120 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('constrains the write to the caller', async () => {
    const app = await build();
    await app.inject({
      method: 'PATCH',
      url: '/api/node',
      headers: as(NODE),
      payload: { currency: 'EUR' },
    });
    expect(filters).toContainEqual({ column: 'user_id', value: NODE });
  });

  it('turns the availability constraint into a sentence, not a 500', async () => {
    updateError = { code: '23514' };
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/node',
      headers: as(NODE),
      payload: { availability: 'available' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/identity is verified/i);
  });
});

describe('POST /api/node/skills', () => {
  it('accepts a tag from the taxonomy', async () => {
    skillRows = [{ skill_tag: 'paid-ads', verified: false, verified_at: null }];
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/skills',
      headers: as(NODE),
      payload: { tag: 'paid-ads' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a well-shaped tag nobody registered, before Postgres sees it', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/skills',
      headers: as(NODE),
      payload: { tag: 'growth-hacking' },
    });
    expect(res.statusCode).toBe(400);
    expect(written.filter((w) => w.table === 'node_skills')).toEqual([]);
  });

  it('refuses a jurisdictional skill claimed everywhere', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/skills',
      headers: as(NODE),
      payload: { tag: 'notary' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/jurisdiction/i);
  });

  it('treats a repeat claim as a replay rather than an error', async () => {
    // Answered from the existing row rather than upserted, because an upsert
    // would reset `verified` and let a node un-verify a confirmed skill.
    insertError = { code: '23505' };
    skillRows = [{ skill_tag: 'seo', verified: true, verified_at: '2026-09-01T00:00:00Z' }];
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/skills',
      headers: as(NODE),
      payload: { tag: 'seo' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().skill.verified).toBe(true);
  });

  it('writes the caller as the node, never a value from the body', async () => {
    skillRows = [{ skill_tag: 'seo', verified: false, verified_at: null }];
    const app = await build();
    await app.inject({
      method: 'POST',
      url: '/api/node/skills',
      headers: as(NODE),
      payload: { tag: 'seo', node_id: STRANGER, nodeId: STRANGER },
    });
    expect(written.find((w) => w.table === 'node_skills')?.values).toMatchObject({ node_id: NODE });
  });
});

describe('POST /api/node/credentials', () => {
  it('never records a verified credential', async () => {
    // `verified` is write-once true and needs dated evidence in a bucket that
    // does not exist. A claim is all this slice can honestly store.
    credentialRows = [];
    const app = await build();
    await app.inject({
      method: 'POST',
      url: '/api/node/credentials',
      headers: as(NODE),
      payload: { kind: 'notary', jurisdiction: 'US-TX', verified: true, verifiedAt: 'now' },
    });
    const values = written.find((w) => w.table === 'node_credentials')?.values ?? {};
    expect(values).not.toHaveProperty('verified');
    expect(values).not.toHaveProperty('evidence_path');
  });

  it('refuses an unknown kind', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/credentials',
      headers: as(NODE),
      payload: { kind: 'wizard', jurisdiction: 'US-TX' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/node/verification', () => {
  it('refuses an unregistered provider', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/verification',
      headers: as(NODE),
      payload: { provider: 'persona', sessionRef: 'inquiry-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('moves the node to pending before asking anybody', async () => {
    // A crash after this leaves a status a resubmission can move out of, rather
    // than a person stuck looking untouched.
    const app = await build();
    await app.inject({
      method: 'POST',
      url: '/api/node/verification',
      headers: as(NODE),
      payload: { provider: 'fake', sessionRef: fakeVerificationRef('pass') },
    });
    expect(written.find((w) => w.table === 'node_profiles')?.values).toMatchObject({
      kyc_status: 'pending',
    });
  });

  it('lets Postgres decide the status rather than computing one', async () => {
    const app = await build();
    await app.inject({
      method: 'POST',
      url: '/api/node/verification',
      headers: as(NODE),
      payload: { provider: 'fake', sessionRef: fakeVerificationRef('pass') },
    });
    const call = rpcCalls.find((c) => c.name === 'decide_node_kyc');
    expect(call).toBeDefined();
    expect(call?.args.p_node_id).toBe(NODE);
    expect((call?.args.p_checks as unknown[]).length).toBe(3);
  });

  it('uses a fresh prefix per submission, so a second attempt is a second decision', async () => {
    const app = await build();
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/node/verification',
        headers: as(NODE),
        payload: { provider: 'fake', sessionRef: fakeVerificationRef('inconclusive') },
      });
    await send();
    await send();
    const prefixes = rpcCalls.map((c) => c.args.p_idempotency_prefix);
    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).not.toBe(prefixes[1]);
  });

  it('reports a provider that could not answer as our problem, not a refusal', async () => {
    // `failed` would reject somebody for our plumbing, and rejected has to be
    // appealed out of.
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/verification',
      headers: as(NODE),
      payload: { provider: 'fake', sessionRef: 'persona-inquiry-1' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toMatch(/nothing about you was decided/i);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses to re-verify somebody already verified', async () => {
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available' });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/node/verification',
      headers: as(NODE),
      payload: { provider: 'fake', sessionRef: fakeVerificationRef('pass') },
    });
    expect(res.statusCode).toBe(409);
    expect(rpcCalls).toEqual([]);
  });
});
