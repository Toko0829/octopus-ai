import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The inbox routes.
 *
 * **The load-bearing test in this file is the one about which client is built.**
 * Every other route group in `apps/api` reaches for `createServiceClient` because
 * it needs to write something a client may not write; these three deliberately do
 * not, because `public.notifications` carries own-row policies and an `update`
 * grant narrowed to `read_at`, so the database is the authorisation. Swapping in
 * the service client would keep every functional test below green while removing
 * the only thing standing between an authenticated stranger and somebody else's
 * inbox, and there is no assertion about output that would notice. So the stub
 * records which factory ran.
 *
 * The second is the one about a second click. Reading something twice is not an
 * error, and a 409 there would make an idempotent act look like a conflict to
 * anybody with two tabs open.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const ROW_A = '22222222-2222-4222-8222-222222222222';
const ROW_B = '33333333-3333-4333-8333-333333333333';
const MISSING = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const PROJECT = '66666666-6666-4666-8666-666666666666';

/** Which client factory each request reached for. The point of the file. */
let clientsBuilt: string[];
/** Every filter applied, so an absent one can be asserted absent. */
let filters: { column: string; op: string; value: unknown }[];
let orders: { column: string; ascending?: boolean }[];
/** Every write, so a refusal can be asserted to have made none. */
let written: { table: string; op: string; values: Record<string, unknown> }[];
let selects: { columns: string; head?: boolean; count?: string }[];

let listRows: Record<string, unknown>[];
let unreadCount: number;
/** What the row looks like on the re-read after an update moved nothing. */
let existingRow: Record<string, unknown> | null;
/** Rows the guarded update actually moves. Empty means it moved nothing. */
let movedRows: Record<string, unknown>[];
let listError: { message: string } | null;

function aRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_A,
    kind: 'offer.created',
    recipient_role: 'node',
    subject_type: 'offer',
    subject_id: ROW_B,
    project_id: PROJECT,
    payload: { task_id: TASK, task_title: 'Draft the launch email' },
    created_at: '2026-09-09T10:00:00.000Z',
    read_at: null,
    ...over,
  };
}

beforeEach(() => {
  clientsBuilt = [];
  filters = [];
  orders = [];
  written = [];
  selects = [];
  listRows = [aRow()];
  unreadCount = 1;
  existingRow = null;
  movedRows = [aRow({ read_at: '2026-09-09T11:00:00.000Z' })];
  listError = null;
});

function client(kind: string) {
  clientsBuilt.push(kind);
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      let mode: 'select' | 'update' = 'select';
      let isCount = false;

      Object.assign(b, {
        select: (columns: string, opts?: { count?: string; head?: boolean }) => {
          selects.push({ columns, head: opts?.head, count: opts?.count });
          if (opts?.head) isCount = true;
          return b;
        },
        eq: (column: string, value: unknown) => {
          filters.push({ column, op: 'eq', value });
          return b;
        },
        is: (column: string, value: unknown) => {
          filters.push({ column, op: 'is', value });
          return b;
        },
        lt: (column: string, value: unknown) => {
          filters.push({ column, op: 'lt', value });
          return b;
        },
        limit: () => b,
        order: (column: string, o?: { ascending?: boolean }) => {
          orders.push({ column, ascending: o?.ascending });
          return b;
        },
        update: (values: Record<string, unknown>) => {
          written.push({ table, op: 'update', values });
          mode = 'update';
          return b;
        },
        maybeSingle: async () =>
          mode === 'update'
            ? { data: movedRows[0] ?? null, error: null }
            : { data: existingRow, error: null },
        then: (resolve: (v: unknown) => unknown) => {
          if (isCount) return resolve({ data: null, error: null, count: unreadCount });
          if (mode === 'update') return resolve({ data: movedRows, error: null });
          return resolve({ data: listRows, error: listError });
        },
      });
      return b;
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client('user'),
  createServiceClient: () => client('service'),
}));

const { notificationRoutes } = await import('./notifications');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(notificationRoutes, {
    // Stands in for JWKS verification. The token is the subject.
    verify: async (token: string) => ({ sub: token, role: 'user' }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
  } as never);
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

describe('the inbox reads as the caller and never as the service', () => {
  it('builds only user clients for a list', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/notifications', headers: as(ALICE) });
    expect(clientsBuilt).not.toContain('service');
    expect(clientsBuilt).toContain('user');
  });

  it('builds only user clients for a read', async () => {
    const app = await build();
    await app.inject({
      method: 'POST',
      url: `/api/notifications/${ROW_A}/read`,
      headers: as(ALICE),
    });
    expect(clientsBuilt).not.toContain('service');
  });

  it('builds only user clients for read-all', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: as(ALICE) });
    expect(clientsBuilt).not.toContain('service');
  });

  /**
   * There is no `user_id` filter anywhere, and its absence is the design rather
   * than a gap: RLS scopes every one of these queries. A filter here would be a
   * second answer to "whose rows are these", and two answers drift.
   */
  it('never filters on user_id, because the table already does', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/notifications', headers: as(ALICE) });
    await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: as(ALICE) });
    expect(filters.map((f) => f.column)).not.toContain('user_id');
  });
});

describe('listing', () => {
  it('refuses without a token', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the rows in camelCase with the unread count', async () => {
    unreadCount = 7;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unread).toBe(7);
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]).toMatchObject({
      id: ROW_A,
      kind: 'offer.created',
      recipientRole: 'node',
      subjectType: 'offer',
      projectId: PROJECT,
      readAt: null,
    });
    expect(body.notifications[0].payload.task_title).toBe('Draft the launch email');
  });

  /**
   * The count is over the whole inbox, not over the page. A badge derived from
   * the page would under-count the moment somebody has more than fits, silently.
   */
  it('counts unread with a head query rather than from the page', async () => {
    listRows = [];
    unreadCount = 240;
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?limit=30',
      headers: as(ALICE),
    });
    expect(res.json().unread).toBe(240);
    expect(res.json().notifications).toHaveLength(0);
    expect(selects.some((s) => s.head === true && s.count === 'exact')).toBe(true);
  });

  it('narrows to unread only when asked', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/notifications', headers: as(ALICE) });
    const listOnly = filters.filter((f) => f.column === 'read_at');
    // One `is read_at null`, from the count query, never from the list.
    expect(listOnly).toHaveLength(1);

    filters = [];
    await app.inject({ method: 'GET', url: '/api/notifications?unread=1', headers: as(ALICE) });
    expect(filters.filter((f) => f.column === 'read_at')).toHaveLength(2);
  });

  it('applies the keyset cursor when given one', async () => {
    const app = await build();
    await app.inject({
      method: 'GET',
      url: '/api/notifications?before=2026-09-09T09:00:00.000Z',
      headers: as(ALICE),
    });
    expect(filters).toContainEqual({
      column: 'created_at',
      op: 'lt',
      value: '2026-09-09T09:00:00.000Z',
    });
  });

  /** `id` breaks the tie, because two rows from one event share a timestamp. */
  it('orders newest first and breaks ties on id', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/notifications', headers: as(ALICE) });
    expect(orders).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
  });

  it('refuses a limit above a hundred', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?limit=500',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a cursor that is not a timestamp', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications?before=yesterday',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(400);
  });

  it('says so rather than answering an empty inbox when the read fails', async () => {
    listError = { message: 'boom' };
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(500);
  });
});

describe('marking one read', () => {
  it('refuses without a token', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: `/api/notifications/${ROW_A}/read` });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an id that is not a uuid', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/not-an-id/read',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(400);
    expect(written).toHaveLength(0);
  });

  it('marks it once and guards the update on it being unread', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notifications/${ROW_A}/read`,
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notification.readAt).toBe('2026-09-09T11:00:00.000Z');
    expect(written).toHaveLength(1);
    expect(filters).toContainEqual({ column: 'read_at', op: 'is', value: null });
  });

  /**
   * A second click. The update moves nothing, the row is read back, and the
   * answer is the row with its original timestamp: `read_at` is written once by
   * the database, so a replay must not appear to move it.
   */
  it('answers a second click with the original timestamp', async () => {
    movedRows = [];
    existingRow = aRow({ read_at: '2026-09-09T11:00:00.000Z' });
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notifications/${ROW_A}/read`,
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notification.readAt).toBe('2026-09-09T11:00:00.000Z');
    // One attempted update, and it moved nothing. Not a second write.
    expect(written).toHaveLength(1);
  });

  /** Absent and somebody else's are the same answer, because RLS returns neither. */
  it('is a 404 for a row that is not in this inbox', async () => {
    movedRows = [];
    existingRow = null;
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: `/api/notifications/${MISSING}/read`,
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('marking everything read', () => {
  it('refuses without a token', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/api/notifications/read-all' });
    expect(res.statusCode).toBe(401);
  });

  it('reports how many moved and zeroes the badge', async () => {
    movedRows = [aRow(), aRow({ id: ROW_B })];
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ marked: 2, unread: 0 });
    expect(written).toHaveLength(1);
  });

  /**
   * Not an optimisation. `guard_notification_read` raises on re-stamping a row
   * that was already read, so an unfiltered update would fail for anybody who
   * had ever read anything.
   */
  it('touches only the unread rows', async () => {
    const app = await build();
    await app.inject({ method: 'POST', url: '/api/notifications/read-all', headers: as(ALICE) });
    expect(filters).toContainEqual({ column: 'read_at', op: 'is', value: null });
  });

  it('is a 200 with nothing marked when the inbox is already clear', async () => {
    movedRows = [];
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/read-all',
      headers: as(ALICE),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ marked: 0, unread: 0 });
  });
});
