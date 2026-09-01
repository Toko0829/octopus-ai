/**
 * Route tests for the ops console, and **the only tests anywhere that exercise
 * an authorisation reading `profiles.role`.**
 *
 * `nodes.test.ts` states the rule these follow: the route is the entire control
 * on the write path, and an untested control is a comment. That applies harder
 * here than anywhere else in this codebase, for two reasons `require-ops.ts`
 * states about itself:
 *
 *   1. **There is no RLS backstop to catch a mistake.** `ledger_entries` and
 *      `ops_actions` carry no policy and no client grant at all, and every read
 *      in that file runs as `service_role`. `requireOps` is not one layer of
 *      two here; it is the layer.
 *   2. **The way to get it wrong is silent.** `request.user.role` exists, looks
 *      exactly like the thing to check, and is `'user'` for every caller
 *      including a real operator, because Supabase mints `role = 'authenticated'`
 *      and `toRole()` maps anything unrecognised to `'user'`. A check written
 *      against the claim refuses everybody while looking like a working
 *      deny-by-default. "ignores a role claimed in the token" is the test that
 *      pins it: an admin claim over a `user` row must still be refused.
 *
 * The rest is the money path. `resolve_dispute` is one transaction, and this
 * route's whole job is to refuse readably before that transaction starts, so
 * what is pinned is the refusals and that **nothing is written when one fires**.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Provider names a test has declared to move real money.
 *
 * **Why this exists rather than a second registry entry.** The 503 branch below
 * is unreachable today: `PAYMENT_PROVIDER_REGISTRY` holds exactly `fake`, whose
 * `carriesRealMoney` is false, so every other name *raises* instead of
 * answering true. That is the registry working as designed, and the premise is
 * asserted rather than assumed in "the counsel gate" below.
 *
 * It also leaves the branch that will run on the day somebody registers Stripe
 * untested, which is the one day it matters. Everything else stays real: the
 * override answers true only for a name a test names, and falls through to the
 * genuine `carriesRealMoney` for every other, including the raise on an unknown
 * one.
 */
const money = vi.hoisted(() => ({ realProviders: new Set<string>() }));

vi.mock('@octopus/payments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@octopus/payments')>();
  return {
    ...actual,
    carriesRealMoney: (provider: string) =>
      money.realProviders.has(provider) ? true : actual.carriesRealMoney(provider),
  };
});

const OPS = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const PLAIN = '33333333-3333-4333-8333-333333333333';
const DISPUTE = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const PROJECT = '66666666-6666-4666-8666-666666666666';
const ENGAGEMENT = '77777777-7777-4777-8777-777777777777';
const NODE = '88888888-8888-4888-8888-888888888888';
const OWNER = '99999999-9999-4999-8999-999999999999';
const ROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THREAD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOLD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_HOLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** `profiles.role` per user id. What `requireOps` reads, and never the claim. */
let roleByUser: Record<string, string | null>;
/** Set to make the role read fail, which must be a 503 and never a 403. */
let roleError: { code: string; message: string } | null;
let disputeRows: Record<string, unknown>[];
let disputeRow: Record<string, unknown> | null;
/** What the post-rpc read of `disputes` answers once the rpc has run. */
let settledDispute: Record<string, unknown> | null;
let taskRows: Record<string, unknown>[];
let engagementRow: Record<string, unknown> | null;
let holdRows: Record<string, unknown>[];
let payoutRows: Record<string, unknown>[];
let ledgerRows: Record<string, unknown>[];
let threadRow: Record<string, unknown> | null;
let rosterRows: Record<string, unknown>[];
let profileRows: Record<string, unknown>[];
let projectRow: Record<string, unknown> | null;
let embedRow: Record<string, unknown> | null;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
let rpcError: { code: string; message: string } | null;
/** Every write a request made, so a refusal can be asserted to have made none. */
let written: { table: string; op: string; values?: Record<string, unknown> }[];
let filters: { column: string; value: unknown }[];
let orders: { column: string; ascending: boolean | undefined }[];

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      const applied: Record<string, unknown> = {};
      const rowsFor = () =>
        table === 'disputes'
          ? disputeRows
          : table === 'tasks'
            ? taskRows
            : table === 'escrow_holds'
              ? holdRows
              : table === 'payouts'
                ? payoutRows
                : table === 'ledger_entries'
                  ? ledgerRows
                  : table === 'room_members'
                    ? rosterRows
                    : table === 'profiles'
                      ? profileRows
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
        not: (column: string, op?: string, value?: unknown) => {
          filters.push({ column, value: `not.${op}.${String(value)}` });
          return b;
        },
        in: () => b,
        limit: () => b,
        order: (column: string, o?: { ascending?: boolean }) => {
          orders.push({ column, ascending: o?.ascending });
          return b;
        },
        insert: (values: Record<string, unknown>) => {
          written.push({ table, op: 'insert', values });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          return Object.assign(b, {
            then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
          });
        },
        maybeSingle: async () => {
          if (table === 'profiles') {
            // The role read. Filtered on `user_id`, which is what tells it apart
            // from the two-name lookup the detail view runs.
            if (roleError) return { data: null, error: roleError };
            const sub = applied.user_id as string;
            const role = roleByUser[sub];
            return { data: role ? { role } : null, error: null };
          }
          if (table === 'disputes') {
            // Before the rpc, the row as it stands; after it, the settled row.
            // The resolve route reads this table twice in one request and the
            // two reads are meant to see different things.
            const ran = rpcCalls.some((c) => c.name === 'resolve_dispute');
            return { data: ran ? settledDispute : disputeRow, error: null };
          }
          if (table === 'tasks') return { data: taskRows[0] ?? null, error: null };
          if (table === 'engagements') return { data: engagementRow, error: null };
          if (table === 'threads') return { data: threadRow, error: null };
          if (table === 'projects') return { data: projectRow, error: null };
          if (table === 'action_embeds') return { data: embedRow, error: null };
          return { data: null, error: null };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: rowsFor(), error: null }),
      });
      return b;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: DISPUTE, error: null };
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { opsRoutes } = await import('./ops');

interface BuildOpts {
  /** What the token claims. Settable on purpose, so the claim can be wrong. */
  claimedRole?: 'user' | 'admin' | 'ops';
  paymentProvider?: string;
}

async function build(opts: BuildOpts = {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(opsRoutes, {
    // Stands in for JWKS verification. The token is the subject, so a test can
    // choose who is calling without minting a real JWT.
    verify: async (token: string) => ({ sub: token, role: opts.claimedRole ?? 'user' }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
    ...(opts.paymentProvider ? { paymentProvider: opts.paymentProvider } : {}),
  } as never);
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

function aDispute(over: Record<string, unknown> = {}) {
  return {
    id: DISPUTE,
    task_id: TASK,
    engagement_id: ENGAGEMENT,
    project_id: PROJECT,
    raised_by: OWNER,
    raised_role: 'owner',
    reason: 'The work never arrived.',
    evidence: null,
    from_state: 'in_progress',
    resolution: null,
    release_amount: null,
    refund_amount: null,
    resolution_note: null,
    resolved_at: null,
    created_at: '2026-09-08T10:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  roleByUser = { [OPS]: 'ops', [ADMIN]: 'admin', [PLAIN]: 'user' };
  roleError = null;
  disputeRows = [aDispute()];
  disputeRow = aDispute();
  settledDispute = aDispute({
    resolution: 'refunded',
    refund_amount: '400.00',
    resolved_at: '2026-09-08T12:00:00Z',
    resolution_note: 'Nothing was delivered.',
  });
  taskRows = [{ id: TASK, title: 'Cut the launch video', state: 'disputed', stage: 'consider' }];
  engagementRow = {
    id: ENGAGEMENT,
    node_id: NODE,
    agreed_price: '400.00',
    currency: 'USD',
    accepted_at: '2026-09-06T10:00:00Z',
    deadline_at: '2026-09-13T10:00:00Z',
    ended_at: null,
    outcome: null,
  };
  holdRows = [
    {
      id: HOLD,
      amount: '400.00',
      currency: 'USD',
      state: 'held',
      created_at: '2026-09-06T10:00:00Z',
    },
  ];
  payoutRows = [];
  ledgerRows = [
    {
      account: 'client_escrow',
      debit: '400.00',
      credit: '0.00',
      currency: 'USD',
      ref_type: 'escrow_hold',
      ref_id: HOLD,
      created_at: '2026-09-06T10:00:00Z',
    },
    {
      account: 'escrow_liability',
      debit: '0.00',
      credit: '400.00',
      currency: 'USD',
      ref_type: 'escrow_hold',
      ref_id: HOLD,
      created_at: '2026-09-06T10:00:00Z',
    },
    {
      account: 'client_escrow',
      debit: '900.00',
      credit: '0.00',
      currency: 'USD',
      ref_type: 'escrow_hold',
      ref_id: OTHER_HOLD,
      created_at: '2026-09-06T10:00:00Z',
    },
  ];
  threadRow = { id: THREAD };
  rosterRows = [
    {
      user_id: NODE,
      role: 'human_node',
      scope: 'thread',
      expires_at: '2026-09-08T12:00:00Z',
      created_at: '2026-09-06T10:00:00Z',
    },
  ];
  profileRows = [
    { user_id: OWNER, display_name: 'Ana' },
    { user_id: NODE, display_name: 'Dato' },
  ];
  projectRow = { source_embed_id: 'embed-1' };
  embedRow = { room_id: ROOM };
  rpcCalls = [];
  rpcError = null;
  written = [];
  filters = [];
  orders = [];
  // So a test that declares a provider real cannot leak that into the next one.
  money.realProviders.clear();
});

describe('who reaches an ops surface', () => {
  it('refuses a caller with no token', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me' });
    expect(res.statusCode).toBe(401);
  });

  it('admits an operator and reports the role it read from the database', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: OPS, role: 'ops' });
  });

  it('admits an admin on the same terms, because nothing here tells the two apart', async () => {
    // Deliberate: `user_role` has carried both since the first migration, and
    // inventing a distinction would mean deciding which of the two may release
    // somebody's escrow, on no evidence.
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(ADMIN) });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
  });

  it('refuses an ordinary signed-in person with 403, not 404', async () => {
    // The opposite of this API's neighbours, on purpose. `/api/ops` is a fixed,
    // documented surface whose existence is in the repository, so pretending it
    // is absent protects nothing and makes a misconfigured operator account look
    // like a broken deployment.
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(PLAIN) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('forbidden');
  });

  it('refuses somebody with no profile row at all', async () => {
    roleByUser = {};
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(PLAIN) });
    expect(res.statusCode).toBe(403);
  });

  it('ignores a role claimed in the token and reads the database', async () => {
    // **The load-bearing test in this file.** `request.user.role` is already
    // populated by the auth plugin and looks exactly like the thing to check. A
    // caller whose token says `admin` and whose row says `user` is refused; if
    // this ever passes, the check has moved to a claim the client half controls.
    const app = await build({ claimedRole: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(PLAIN) });
    expect(res.statusCode).toBe(403);
  });

  it('answers 503 rather than 403 when the role cannot be read', async () => {
    // A read that failed is not a role that was refused. Telling somebody they
    // lack permission when the database was unreachable sends them to ask for
    // access they already have.
    roleError = { code: '08006', message: 'connection failure' };
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/me', headers: as(OPS) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('unavailable');
  });

  it('lets no non-operator reach the resolve rpc', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/ops/disputes/${DISPUTE}/resolve`,
      headers: as(PLAIN),
      payload: { resolution: 'refunded', reason: 'because' },
    });
    expect(res.statusCode).toBe(403);
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('guards every route in the group, not just the first', async () => {
    const app = await build();
    for (const url of ['/api/ops/me', '/api/ops/disputes', `/api/ops/disputes/${DISPUTE}`]) {
      const res = await app.inject({ method: 'GET', url, headers: as(PLAIN) });
      expect(res.statusCode, url).toBe(403);
    }
  });
});

describe('the queue', () => {
  it('lists open disputes oldest first', async () => {
    // The longest freeze is the one where somebody has been waiting longest with
    // their money held, so the queue is worked from the top.
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/disputes', headers: as(OPS) });
    expect(res.statusCode).toBe(200);
    expect(filters).toContainEqual({ column: 'resolved_at', value: null });
    expect(orders).toContainEqual({ column: 'created_at', ascending: true });
    expect(res.json().disputes[0].id).toBe(DISPUTE);
  });

  it('lists resolved disputes newest first, on the opposite filter', async () => {
    // Read to check recent decisions rather than worked through, so the ordering
    // is a decision and is asserted as one.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/ops/disputes?status=resolved',
      headers: as(OPS),
    });
    expect(res.statusCode).toBe(200);
    expect(
      filters.some((f) => f.column === 'resolved_at' && String(f.value).startsWith('not.')),
    ).toBe(true);
    expect(orders).toContainEqual({ column: 'resolved_at', ascending: false });
  });

  it('refuses a status that is neither', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/ops/disputes?status=frozen',
      headers: as(OPS),
    });
    expect(res.statusCode).toBe(400);
  });

  it('converts the money out of the strings PostgREST sends', async () => {
    // `numeric(12,2)` arrives as text. Converted at the boundary so nothing
    // downstream does arithmetic on a string.
    disputeRows = [aDispute({ release_amount: '150.00', refund_amount: '250.00' })];
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/disputes', headers: as(OPS) });
    expect(res.json().disputes[0].releaseAmount).toBe(150);
    expect(res.json().disputes[0].refundAmount).toBe(250);
  });

  it('names a step whose title could not be read rather than rendering nothing', async () => {
    taskRows = [];
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ops/disputes', headers: as(OPS) });
    expect(res.json().disputes[0].taskTitle).toBe('a step');
  });
});

describe('the detail an operator decides on', () => {
  it('answers 404 for a dispute that does not exist', async () => {
    disputeRow = null;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/ops/disputes/${DISPUTE}`,
      headers: as(OPS),
    });
    expect(res.statusCode).toBe(404);
  });

  it('shows only the ledger entries belonging to this step', async () => {
    // The filter is in code rather than in the query, because `ref_id` is a uuid
    // across every hold in the system. An operator reading somebody else's
    // ledger entries beside this decision is a disclosure, not a rounding error.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/ops/disputes/${DISPUTE}`,
      headers: as(OPS),
    });
    expect(res.statusCode).toBe(200);
    const refs = res.json().ledger.map((e: { refId: string }) => e.refId);
    expect(refs).toEqual([HOLD, HOLD]);
    expect(refs).not.toContain(OTHER_HOLD);
  });

  it('keeps an ended membership on the roster', async () => {
    // `reassign_engagement` and `resolve_dispute` stamp `expires_at` rather than
    // deleting the row, "so the roster still records that this person was here,
    // which is what a dispute reads". This is that reader.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/ops/disputes/${DISPUTE}`,
      headers: as(OPS),
    });
    expect(res.json().roster).toHaveLength(1);
    expect(res.json().roster[0].expiresAt).toBe('2026-09-08T12:00:00Z');
  });

  it('names both parties, which no policy would give an operator', async () => {
    // Read as `service_role`, because an operator is neither party and
    // `private.engaged_counterparty` would answer false for them.
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/ops/disputes/${DISPUTE}`,
      headers: as(OPS),
    });
    expect(res.json().dispute.raisedByName).toBe('Ana');
    expect(res.json().engagement.nodeName).toBe('Dato');
  });
});

describe('the decision', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    resolution: 'refunded',
    reason: 'Nothing was delivered and the deadline passed.',
    ...over,
  });

  async function resolve(app: FastifyInstance, payload: Record<string, unknown>, who = OPS) {
    return app.inject({
      method: 'POST',
      url: `/api/ops/disputes/${DISPUTE}/resolve`,
      headers: as(who),
      payload,
    });
  }

  it('records the decision and answers with what was settled', async () => {
    const app = await build();
    const res = await resolve(app, body());
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(false);
    expect(res.json().dispute.resolution).toBe('refunded');
    expect(res.json().dispute.refundAmount).toBe(400);
  });

  it('names the operator from the checked role, never from the body', async () => {
    // `ops_actions.actor_id` is `not null` with no `'system'` branch, and the
    // whole reason that table exists is that a person releasing somebody's money
    // must be distinguishable from a sweep. A caller-supplied actor would make
    // the column a formality.
    const app = await build();
    await resolve(app, body({ actorId: PLAIN, p_actor_id: PLAIN }));
    const call = rpcCalls.find((c) => c.name === 'resolve_dispute');
    expect(call?.args.p_actor_id).toBe(OPS);
    expect(call?.args.p_resolution).toBe('refunded');
    expect(call?.args.p_release_amount).toBeNull();
  });

  it('refuses an unexplained decision before anything is written', async () => {
    // `ops_actions.reason` is `not null` and checked non-empty, so an
    // unexplained resolution cannot be recorded and therefore cannot happen. The
    // person deserves to hear that before the request, not as a constraint
    // violation after it.
    const app = await build();
    for (const reason of ['', '   ']) {
      rpcCalls = [];
      const res = await resolve(app, body({ reason }));
      expect(res.statusCode).toBe(400);
      expect(rpcCalls).toEqual([]);
    }
  });

  it('refuses a partial with no amount, and an amount on anything else', async () => {
    // The operator enters what the expert keeps and the refund is derived. Two
    // fields that must sum to a third are two ways to type a number that does
    // not add up.
    const app = await build();
    const noAmount = await resolve(app, body({ resolution: 'partial' }));
    expect(noAmount.statusCode).toBe(400);

    const strayAmount = await resolve(app, body({ resolution: 'released', releaseAmount: 100 }));
    expect(strayAmount.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('passes a partial through with the release amount and nothing else', async () => {
    const app = await build();
    const res = await resolve(app, body({ resolution: 'partial', releaseAmount: 150 }));
    expect(res.statusCode).toBe(200);
    expect(rpcCalls[0]!.args.p_release_amount).toBe(150);
  });

  it('refuses an unknown resolution', async () => {
    const app = await build();
    const res = await resolve(app, body({ resolution: 'forgiven' }));
    expect(res.statusCode).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it('reads back a decision already taken rather than calling it a conflict', async () => {
    // An operator who double-clicked, or a retried request, is told what was
    // decided. `replayed` is honest about it, so nobody is shown a new answer
    // that was not taken.
    disputeRow = aDispute({
      resolution: 'released',
      resolved_at: '2026-09-08T11:00:00Z',
      resolution_note: 'The proof was fine.',
    });
    const app = await build();
    const res = await resolve(app, body());
    expect(res.statusCode).toBe(200);
    expect(res.json().replayed).toBe(true);
    expect(res.json().dispute.resolution).toBe('released');
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('answers 404 for a dispute that does not exist', async () => {
    disputeRow = null;
    const app = await build();
    const res = await resolve(app, body());
    expect(res.statusCode).toBe(404);
    expect(rpcCalls).toEqual([]);
  });

  it('hands back the refusal the database wrote, not a summary of it', async () => {
    // Those messages are written for exactly this moment. Summarising them loses
    // the reason, which is the thing the operator needs.
    rpcError = {
      code: '23514',
      message: 'rejection_upheld answers a dispute the node raised from rejected',
    };
    const app = await build();
    const res = await resolve(app, body({ resolution: 'rejection_upheld' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('rejection_upheld answers a dispute');
  });

  it('tells the room once, keyed on the dispute', async () => {
    const app = await build();
    await resolve(app, body());
    const messages = written.filter((w) => w.table === 'messages');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.values?.idempotency_key).toBe(`dispute-resolved:${DISPUTE}`);
    expect(messages[0]!.values?.author_kind).toBe('system');
  });

  it('writes no em dash into the room, per rule 22', async () => {
    const app = await build();
    for (const resolution of [
      'released',
      'refunded',
      'partial',
      'reassigned',
      'rejection_upheld',
    ]) {
      written = [];
      rpcCalls = [];
      await resolve(
        app,
        body({ resolution, ...(resolution === 'partial' ? { releaseAmount: 150 } : {}) }),
      );
      const line = written.find((w) => w.table === 'messages')?.values?.body as string;
      expect(line, resolution).toBeTruthy();
      expect(line, resolution).not.toContain('—');
    }
  });
});

describe('the counsel gate', () => {
  const body = (resolution: string) => ({
    resolution,
    reason: 'Decided after reading the proof.',
    ...(resolution === 'partial' ? { releaseAmount: 150 } : {}),
  });

  it('has exactly one registered provider, and it moves no money', async () => {
    // The premise the rest of this block rests on, asserted the way
    // `payout.test.ts` asserts it: the 503 below cannot be produced by any name
    // this build could actually be configured with, because the only registered
    // provider moves nothing. Adding a second entry is a reviewed change to a
    // checked-in file, which is what makes flipping that flag a deliberate act.
    const { PAYMENT_PROVIDER_REGISTRY, carriesRealMoney } =
      await vi.importActual<typeof import('@octopus/payments')>('@octopus/payments');

    expect(Object.keys(PAYMENT_PROVIDER_REGISTRY)).toEqual(['fake']);
    expect(carriesRealMoney('fake')).toBe(false);
  });

  it('refuses a provider it has never heard of rather than assuming it is harmless', async () => {
    // The inversion `carriesRealMoney` was written for: "a provider we have
    // never heard of certainly moves no money" is the assumption that would let
    // an unreviewed integration straight through the one check standing in front
    // of payments-billing.md's regulatory gate. It raises, and the route's catch
    // turns that into a 500 having written nothing.
    const app = await build({ paymentProvider: 'some-new-psp' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/ops/disputes/${DISPUTE}/resolve`,
      headers: as(OPS),
      payload: body('refunded'),
    });
    expect(res.statusCode).toBe(500);
    expect(rpcCalls).toEqual([]);
    expect(written).toEqual([]);
  });

  it('refuses to settle escrow through a provider that moves real money', async () => {
    // The branch that runs on the day somebody registers a real provider, which
    // is the one day it matters and the one day nobody will be re-reading this
    // route. Identical to the payout sweep's check and deliberately so: the two
    // money surfaces must not end up gated against different providers.
    money.realProviders.add('stripe');
    for (const resolution of ['refunded', 'partial', 'reassigned']) {
      rpcCalls = [];
      written = [];
      const app = await build({ paymentProvider: 'stripe' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/ops/disputes/${DISPUTE}/resolve`,
        headers: as(OPS),
        payload: body(resolution),
      });
      expect(res.statusCode, resolution).toBe(503);
      expect(rpcCalls, resolution).toEqual([]);
      expect(written, resolution).toEqual([]);
    }
  });

  it('does not gate the two resolutions that settle no escrow', async () => {
    // `released` moves no money here: it returns the step to `approved` and the
    // existing payout sweep pays, behind that sweep's own identical check.
    // `rejection_upheld` moves none at all. Both stay open with a real provider,
    // which is what keeps a dispute resolvable on a day payouts are gated.
    money.realProviders.add('stripe');
    for (const resolution of ['released', 'rejection_upheld']) {
      rpcCalls = [];
      const app = await build({ paymentProvider: 'stripe' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/ops/disputes/${DISPUTE}/resolve`,
        headers: as(OPS),
        payload: body(resolution),
      });
      expect(res.statusCode, resolution).toBe(200);
      expect(rpcCalls, resolution).toHaveLength(1);
    }
  });

  it('settles through the fake without consulting anything else', async () => {
    // The path this build actually takes. The default is the fake, exactly as
    // `payoutSweep` defaults, so the two cannot be configured apart by omission.
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/ops/disputes/${DISPUTE}/resolve`,
      headers: as(OPS),
      payload: body('refunded'),
    });
    expect(res.statusCode).toBe(200);
  });
});
