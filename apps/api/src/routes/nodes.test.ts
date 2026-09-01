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
let offerRows: Record<string, unknown>[];
let taskRows: Record<string, unknown>[];
/** Rows a conditional offer update should report as moved. */
let offerUpdateMoves: Record<string, unknown> | null;
/** Slice 5: what the accept path reads on its way through. */
let engagementRow: Record<string, unknown> | null;
/** What the replay short-circuit finds, looked up by `offer_id`. */
let replayEngagement: Record<string, unknown> | null;
let projectRow: Record<string, unknown> | null;
let campaignRows: Record<string, unknown>[];
let holdRows: Record<string, unknown>[];
let threadRows: Record<string, unknown>[];
let embedRow: Record<string, unknown> | null;
/** What `accept_offer` answers. Set to an error to exercise the raise path. */
let rpcResult: { data: unknown; error: { code: string; message: string } | null };

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      // Per-builder as well as global. `filters` is what assertions read; this
      // is what the stub itself branches on, because two different reads of
      // `engagements` in one request are told apart by which column they filter.
      const applied: Record<string, unknown> = {};
      const rowsFor = () =>
        table === 'node_skills'
          ? skillRows
          : table === 'node_credentials'
            ? credentialRows
            : table === 'offers'
              ? offerRows
              : table === 'tasks'
                ? taskRows
                : table === 'campaigns'
                  ? campaignRows
                  : table === 'escrow_holds'
                    ? holdRows
                    : table === 'threads'
                      ? threadRows
                      : [];
      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          filters.push({ column, value });
          applied[column] = value;
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
        in: () => b,
        not: (column: string, _op?: string, _value?: unknown) => {
          filters.push({ column, value: 'not' });
          return b;
        },
        gt: (column: string, value: unknown) => {
          filters.push({ column, value });
          return b;
        },
        maybeSingle: async () => {
          if (table === 'node_profiles') return { data: profileRow, error: null };
          if (table === 'engagements') {
            // The replay short-circuit looks up by `offer_id`; reading back what
            // was just accepted looks up by `id`.
            return {
              data: 'offer_id' in applied ? replayEngagement : engagementRow,
              error: null,
            };
          }
          if (table === 'projects') return { data: projectRow, error: null };
          if (table === 'action_embeds') return { data: embedRow, error: null };
          if (table === 'threads') return { data: threadRows[0] ?? null, error: null };
          if (table === 'node_skills') return { data: skillRows[0] ?? null, error: null };
          if (table === 'node_credentials') return { data: credentialRows[0] ?? null, error: null };
          if (table === 'offers') {
            // An update carries the conditional result; a plain read returns the row.
            const isUpdate = written.some((w) => w.table === 'offers' && w.op === 'update');
            if (isUpdate) return { data: offerUpdateMoves, error: null };
            return { data: offerRows[0] ?? null, error: null };
          }
          if (table === 'tasks') return { data: taskRows[0] ?? null, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsFor(), error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === 'accept_offer') return rpcResult;
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
  offerRows = [];
  taskRows = [];
  offerUpdateMoves = null;
  engagementRow = null;
  replayEngagement = null;
  projectRow = null;
  campaignRows = [];
  holdRows = [];
  threadRows = [];
  embedRow = null;
  rpcResult = { data: null, error: null };
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

/* ------------------------------------------------------------------ offers */

const OFFER = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '66666666-6666-4666-8666-666666666666';

function anOffer(over: Record<string, unknown> = {}) {
  return {
    id: OFFER,
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    node_id: NODE,
    round: 0,
    status: 'open',
    expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-09-01T00:00:00.000Z',
    declined_at: null,
    decline_reason: null,
    ...over,
  };
}

describe('GET /api/node/offers', () => {
  it('is a 404 for somebody who is not a node', async () => {
    profileRow = null;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node/offers', headers: as(STRANGER) });
    expect(res.statusCode).toBe(404);
  });

  it('carries the task words a person needs and nothing identifying the owner', async () => {
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    offerRows = [anOffer()];
    taskRows = [
      {
        id: TASK_ID,
        title: 'Write the launch emails',
        stage: 'conversion',
        detail: 'Five emails.',
      },
    ];

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node/offers', headers: as(NODE) });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { offers: Record<string, unknown>[] };
    expect(body.offers).toHaveLength(1);
    const offer = body.offers[0] as Record<string, unknown>;
    expect((offer.task as Record<string, unknown>).title).toBe('Write the launch emails');

    // The projection IS the access control here, so assert the absences directly
    // rather than trusting a reviewer to notice one creeping back in. A node has
    // no grant on tasks or projects, and the owner-sees-node pair stays closed
    // until the engagement slice opens it on purpose.
    const flat = JSON.stringify(offer);
    expect(flat).not.toContain(TASK_ID);
    expect(flat).not.toContain(PROJECT_ID);
    expect(offer).not.toHaveProperty('ownerId');
    expect(offer).not.toHaveProperty('nodeId');
  });

  it('presents an offer past its deadline as expired, before any sweep has run', async () => {
    // Expiry is compared at read time. Without this a node could open a
    // live-looking offer, click Decline, and be told it had already expired.
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    offerRows = [anOffer({ status: 'open', expires_at: '2020-01-01T00:00:00.000Z' })];
    taskRows = [{ id: TASK_ID, title: 'Old work', stage: 'content', detail: null }];

    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/node/offers', headers: as(NODE) });

    const body = res.json() as { offers: { status: string }[] };
    expect(body.offers[0]?.status).toBe('expired');
  });
});

describe('POST /api/node/offers/:offerId/decline', () => {
  it('declines an open offer and records who did it', async () => {
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    offerRows = [anOffer()];
    taskRows = [
      { id: TASK_ID, title: 'Write the launch emails', stage: 'conversion', detail: null },
    ];
    offerUpdateMoves = anOffer({ status: 'declined', declined_at: '2026-09-02T00:00:00.000Z' });

    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/offers/${OFFER}/decline`,
      headers: as(NODE),
      payload: { reason: 'Outside what I do' },
    });

    expect(res.statusCode).toBe(200);

    // The conditional update carries every precondition, so two clicks racing
    // cannot both win and the deadline is judged by Postgres rather than by us.
    const update = written.find((w) => w.table === 'offers' && w.op === 'update');
    expect((update?.values as Record<string, unknown>).status).toBe('declined');
    expect(filters.some((f) => f.column === 'status' && f.value === 'open')).toBe(true);
    expect(filters.some((f) => f.column === 'node_id' && f.value === NODE)).toBe(true);
    expect(filters.some((f) => f.column === 'expires_at')).toBe(true);

    // The event is project-scoped and names the node, unlike every other event
    // in this file: a decline is a fact about somebody's step, not about a node.
    const event = written.find((w) => w.table === 'events');
    const values = event?.values as Record<string, unknown>;
    expect(values.verb).toBe('offer.declined');
    expect(values.actor_kind).toBe('node');
    expect(values.actor_id).toBe(NODE);
    expect(values.project_id).toBe(PROJECT_ID);
  });

  it('never touches the task, because the sweep is its only writer', async () => {
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    offerRows = [anOffer()];
    taskRows = [{ id: TASK_ID, title: 'Work', stage: 'content', detail: null }];
    offerUpdateMoves = anOffer({ status: 'declined', declined_at: '2026-09-02T00:00:00.000Z' });

    const app = await build();
    await app.inject({
      method: 'POST',
      url: `/api/node/offers/${OFFER}/decline`,
      headers: as(NODE),
      payload: {},
    });

    // Two writers racing on one task, one reacting to a person and one to a
    // clock, is how a step gets offered to two nodes at once.
    expect(written.some((w) => w.table === 'tasks' && w.op === 'update')).toBe(false);
  });

  it('is a 404 for an offer belonging to somebody else', async () => {
    // Not theirs and not existing are the same answer, the 404-not-403 idiom.
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    offerRows = [];
    offerUpdateMoves = null;

    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/offers/${OFFER}/decline`,
      headers: as(NODE),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it('refuses a reason longer than the column allows, rather than truncating it', async () => {
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/offers/${OFFER}/decline`,
      headers: as(NODE),
      payload: { reason: 'x'.repeat(501) },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses a body carrying anything but a reason', async () => {
    // `.strict()`, for the PatchNodeBody reason: a silently dropped field
    // returns 200 and lets somebody believe a control applied.
    profileRow = aProfile({ kyc_status: 'verified', availability: 'available', rate: 120 });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/node/offers/${OFFER}/decline`,
      headers: as(NODE),
      payload: { reason: 'no thanks', status: 'accepted' },
    });

    expect(res.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------ slice 5 */

const ENGAGEMENT = '77777777-7777-4777-8777-777777777777';
const ROOM = '88888888-8888-4888-8888-888888888888';
const THREAD = '99999999-9999-4999-8999-999999999999';

/** A node who can actually be paid: verified, available, task-rated, in USD. */
function anAcceptingNode(over: Record<string, unknown> = {}) {
  return aProfile({
    kyc_status: 'verified',
    availability: 'available',
    rate: 500,
    rate_period: 'task',
    currency: 'USD',
    ...over,
  });
}

/** Everything the accept path reads, set up to succeed. */
function acceptableWorld() {
  profileRow = anAcceptingNode();
  offerRows = [anOffer()];
  taskRows = [
    {
      id: TASK_ID,
      title: 'Write the launch emails',
      stage: 'conversion',
      detail: null,
      state: 'escrow_funded',
    },
  ];
  threadRows = [{ id: THREAD, room_id: ROOM, task_id: TASK_ID }];
  projectRow = { budget_ceiling: '1000.00', currency: 'USD', source_embed_id: 'embed-1' };
  campaignRows = [];
  holdRows = [];
  embedRow = { room_id: ROOM };
  engagementRow = {
    id: ENGAGEMENT,
    task_id: TASK_ID,
    project_id: PROJECT_ID,
    node_id: NODE,
    agreed_price: '500.00',
    currency: 'USD',
    accepted_at: '2026-09-04T00:00:00.000Z',
    ended_at: null,
    outcome: null,
  };
  rpcResult = { data: ENGAGEMENT, error: null };
}

const acceptUrl = `/api/node/offers/${OFFER}/accept`;

describe('POST /api/node/offers/:offerId/accept', () => {
  it('accepts, and hands the rpc the offer and a fake charge reference', async () => {
    acceptableWorld();
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(200);

    const rpc = rpcCalls.find((c) => c.name === 'accept_offer');
    expect(rpc?.args.p_offer_id).toBe(OFFER);
    // Derived from the offer, so a retry asks for the same charge and is handed
    // the same reference. Visibly fake, in the column where that matters most.
    expect(String(rpc?.args.p_charge_id)).toContain('ch_fake_');
    expect(String(rpc?.args.p_charge_id)).toContain(OFFER.replace(/-/g, '_'));
  });

  it('returns the room and thread, which the offer projection deliberately hides', async () => {
    // Before acceptance an id would only invite the next surface to try. After
    // it, these two ARE the admission: `room_members` carries them and the
    // node's own client cannot read or post in their thread without both.
    acceptableWorld();
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    const body = res.json() as { engagement: Record<string, unknown> };
    expect(body.engagement.roomId).toBe(ROOM);
    expect(body.engagement.threadId).toBe(THREAD);
    // numeric arrives as a string over PostgREST and must not reach a client as one.
    expect(body.engagement.agreedPrice).toBe(500);
  });

  it('records the acceptance as the node, against the project', async () => {
    acceptableWorld();
    const app = await build();
    await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    const event = written
      .filter((w) => w.table === 'events')
      .map((w) => w.values as Record<string, unknown>)
      .find((v) => v.verb === 'offer.accepted');
    expect(event?.actor_kind).toBe('node');
    expect(event?.actor_id).toBe(NODE);
    expect(event?.project_id).toBe(PROJECT_ID);
  });

  it('tells the owner in their room, keyed so a retry says it once', async () => {
    acceptableWorld();
    const app = await build();
    await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    const message = written.find((w) => w.table === 'messages');
    const values = message?.values as Record<string, unknown>;
    expect(values.room_id).toBe(ROOM);
    expect(values.idempotency_key).toBe(`offer-accepted:${OFFER}`);
    expect(values.author_kind).toBe('system');
    // Rule 22, on a sentence that reaches a person on a money surface.
    expect(String(values.body)).not.toContain('\u2014');
  });

  it('is a 404 for an offer belonging to somebody else', async () => {
    // Read as the caller under `offers_select_own`, so not-theirs and
    // not-existing are the same answer.
    acceptableWorld();
    offerRows = [];
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(404);
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
  });

  it('refuses an expired offer with its own sentence, before any rpc', async () => {
    acceptableWorld();
    offerRows = [anOffer({ expires_at: '2020-01-01T00:00:00.000Z' })];
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/expired/i);
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
  });

  it('refuses an hourly rate as defense in depth behind the pool filter', async () => {
    acceptableWorld();
    profileRow = anAcceptingNode({ rate_period: 'hour' });
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/per step/i);
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
  });

  it('refuses over the ceiling and says how much escrow already holds', async () => {
    // ADR-0020's two classes, surfaced. Escrow does not appear in the campaign
    // list, so a refusal quoting one number a person cannot account for reads as
    // a broken check rather than as a full budget.
    acceptableWorld();
    campaignRows = [{ budget_cap: '200.00', state: 'ready' }];
    holdRows = [{ amount: '400.00' }];
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/escrow/i);
    expect(res.json().message).toContain('400');
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
  });

  it('refuses a project with no authorised budget, and says whose problem it is', async () => {
    acceptableWorld();
    projectRow = { budget_ceiling: null, currency: 'USD', source_embed_id: 'embed-1' };
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/owner/i);
  });

  it('surfaces the raise from the database verbatim, because SQL is authoritative', async () => {
    // The pre-checks pass and the row lock refuses anyway: two nodes accepting
    // two steps on one project at the same instant both pass a check made in
    // Node. The raise names what it found, and a 409 saying only "that step
    // moved" is the one message a node cannot act on.
    acceptableWorld();
    rpcResult = {
      data: null,
      error: {
        code: '23514',
        message: 'step 555 is cancelled, not offered, so it cannot be claimed',
      },
    };
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('cancelled');
  });

  it('replays into the engagement it already made, without re-checking the ceiling', async () => {
    // A retry of a request whose response the node never saw. Short-circuited
    // before the pre-checks, so a ceiling that has moved since cannot refuse
    // work they already hold.
    acceptableWorld();
    replayEngagement = { id: ENGAGEMENT };
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(NODE) });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { engagement: { id: string } }).engagement.id).toBe(ENGAGEMENT);
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
    expect(written.some((w) => w.table === 'messages')).toBe(false);
  });

  it('refuses a body, rather than ignoring one', async () => {
    // Accepting takes no body: the price is the node's rate and the step is the
    // one offered. A field here would be a person naming what they are paid.
    acceptableWorld();
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: acceptUrl,
      headers: as(NODE),
      payload: { agreedPrice: 9999 },
    });

    expect(res.statusCode).toBe(400);
    expect(rpcCalls.some((c) => c.name === 'accept_offer')).toBe(false);
  });

  it('is 404 for somebody who is not a node at all', async () => {
    acceptableWorld();
    profileRow = null;
    const app = await build();
    const res = await app.inject({ method: 'POST', url: acceptUrl, headers: as(STRANGER) });

    expect(res.statusCode).toBe(404);
  });
});

describe('the real-money refusal', () => {
  it('is enforced by the registry rather than described in a paragraph', async () => {
    // The enforced half of the counsel gate in payments-billing.md: the first
    // person to register Stripe hits a failing write rather than a paragraph
    // they did not read. Asserted against the registry, because the route names
    // the only registered provider and the property under test is the registry's
    // refusal rather than the route's string.
    const { carriesRealMoney, registeredPaymentProviders } = await import('@octopus/payments');

    expect(registeredPaymentProviders()).toEqual(['fake']);
    expect(carriesRealMoney('fake')).toBe(false);
    expect(() => carriesRealMoney('stripe')).toThrow(/Unknown payment provider/);
  });
});

describe('GET /api/node/engagements', () => {
  it('returns the work this node took', async () => {
    profileRow = anAcceptingNode();
    taskRows = [
      {
        id: TASK_ID,
        title: 'Write the launch emails',
        stage: 'conversion',
        detail: null,
        state: 'escrow_funded',
      },
    ];
    threadRows = [{ id: THREAD, room_id: ROOM, task_id: TASK_ID }];

    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/node/engagements',
      headers: as(NODE),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('engagements');
  });

  it('is 404 for somebody who is not a node', async () => {
    profileRow = null;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/node/engagements',
      headers: as(STRANGER),
    });

    expect(res.statusCode).toBe(404);
  });
});
