/**
 * The write path, and the two things slice 5 added to it.
 *
 * **`author_kind` is derived, never accepted.** A client that could name its own
 * kind could file a message as a node's in somebody's audit trail. The route
 * reads the caller's own `room_members` row and decides; `messages_insert_own`
 * re-checks the same fact from the same table independently
 * (`20260904127000`), which is the defense in depth rule 6 asks for rather than
 * a route somebody could later call with a different thread.
 *
 * **The thread decides the channel.** A request naming both could name two
 * different ones, and the table would then have to arbitrate. Deriving it
 * removes the disagreement instead of catching it.
 *
 * The stub answers as PostgREST does rather than as a database would: a read the
 * caller cannot make comes back as **zero rows**, not as an error, which is
 * precisely how `20260827110000` hid for two weeks.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '11111111-1111-4111-8111-111111111111';
const ROOM = '88888888-8888-4888-8888-888888888888';
const OTHER_ROOM = '55555555-5555-4555-8555-555555555555';
const THREAD = '99999999-9999-4999-8999-999999999999';
const CHANNEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const THREAD_CHANNEL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Rows each table answers with, filtered by whatever the query applied. */
let tables: Record<string, Record<string, unknown>[]>;
let inserted: Record<string, unknown>[];

function client() {
  return {
    from(table: string) {
      const applied: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      const matches = () =>
        (tables[table] ?? []).filter((row) =>
          Object.entries(applied).every(([col, val]) => row[col] === val),
        );

      Object.assign(b, {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied[column] = value;
          return b;
        },
        gt: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        single: async () => ({ data: matches()[0] ?? null, error: null }),
        insert: (values: Record<string, unknown>) => {
          inserted.push(values);
          const row = {
            id: 'm1',
            seq: 1,
            created_at: '2026-09-04T00:00:00.000Z',
            action_embeds: null,
            ...values,
          };
          return Object.assign(b, {
            select: () => ({
              single: async () => ({ data: row, error: null }),
              maybeSingle: async () => ({ data: row, error: null }),
            }),
          });
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: matches(), error: null }),
      });
      return b;
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { messageRoutes, MESSAGE_COLUMNS, MessageRow } = await import('./messages');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(messageRoutes, {
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
  });
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });

function post(payload: Record<string, unknown>) {
  return {
    method: 'POST' as const,
    url: `/api/rooms/${ROOM}/messages`,
    headers: as(USER),
    payload: { body: 'hello', idempotencyKey: 'k-0000001', ...payload },
  };
}

beforeEach(() => {
  inserted = [];
  tables = {
    rooms: [{ id: ROOM }, { id: OTHER_ROOM }],
    channels: [
      { id: CHANNEL, room_id: ROOM },
      { id: THREAD_CHANNEL, room_id: ROOM },
    ],
    threads: [{ id: THREAD, room_id: ROOM, channel_id: THREAD_CHANNEL }],
    room_members: [],
    messages: [],
  };
});

describe('posting to the room stream', () => {
  it('writes author_kind user when the caller holds no thread membership', async () => {
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'user', scope: 'room', thread_id: null },
    ];

    const app = await build();
    const res = await app.inject(post({ channelId: CHANNEL }));

    expect(res.statusCode).toBe(201);
    expect(inserted[0]?.author_kind).toBe('user');
    expect(inserted[0]?.thread_id).toBeNull();
    expect(inserted[0]?.author_id).toBe(USER);
  });

  it('still refuses a channel from another room', async () => {
    const app = await build();
    const res = await app.inject(post({ channelId: 'not-in-this-room' }));

    expect(res.statusCode).toBe(400);
  });
});

describe('posting into a thread', () => {
  it('derives the channel from the thread rather than trusting the request', async () => {
    // A request naming both could name two different ones. Deriving removes the
    // disagreement instead of catching it.
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'human_node', scope: 'thread', thread_id: THREAD },
    ];

    const app = await build();
    const res = await app.inject(post({ threadId: THREAD, channelId: CHANNEL }));

    expect(res.statusCode).toBe(201);
    expect(inserted[0]?.channel_id).toBe(THREAD_CHANNEL);
    expect(inserted[0]?.thread_id).toBe(THREAD);
  });

  it('writes author_kind node for a live human_node thread membership', async () => {
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'human_node', scope: 'thread', thread_id: THREAD },
    ];

    const app = await build();
    await app.inject(post({ threadId: THREAD }));

    expect(inserted[0]?.author_kind).toBe('node');
  });

  it('keeps a room-scoped member as user even inside a thread', async () => {
    // The owner reads and writes in their own room's threads. They are not a
    // node, and labelling them one would put a wrong actor in the audit trail.
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'user', scope: 'room', thread_id: null },
    ];

    const app = await build();
    await app.inject(post({ threadId: THREAD }));

    expect(inserted[0]?.author_kind).toBe('user');
    expect(inserted[0]?.thread_id).toBe(THREAD);
  });

  it('keeps a thread-scoped member who is not a human_node as user', async () => {
    // `scope = 'thread'` alone is not the fact. The role is what says which kind
    // of participant this is, and `accept_offer` sets both.
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'user', scope: 'thread', thread_id: THREAD },
    ];

    const app = await build();
    await app.inject(post({ threadId: THREAD }));

    expect(inserted[0]?.author_kind).toBe('user');
  });

  it('keeps a node posting into somebody else s thread as user', async () => {
    // Their membership names a different thread, so the derivation fails closed
    // and RLS refuses the row outright. Both layers, neither relied on alone.
    tables.room_members = [
      {
        room_id: ROOM,
        user_id: USER,
        role: 'human_node',
        scope: 'thread',
        thread_id: 'some-other-thread',
      },
    ];

    const app = await build();
    await app.inject(post({ threadId: THREAD }));

    expect(inserted[0]?.author_kind).toBe('user');
  });

  it('refuses a thread that belongs to another room', async () => {
    // Read as the caller, so a thread they are not admitted to is simply not
    // there and this is a 400 rather than a 403 confirming it exists.
    tables.threads = [{ id: THREAD, room_id: OTHER_ROOM, channel_id: THREAD_CHANNEL }];

    const app = await build();
    const res = await app.inject(post({ threadId: THREAD }));

    expect(res.statusCode).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it('never lets a client name its own author_kind', async () => {
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'user', scope: 'room', thread_id: null },
    ];

    const app = await build();
    const res = await app.inject(post({ authorKind: 'node' }));

    // `PostMessageBody` is not `.strict()`, so an unknown field is dropped by
    // Zod rather than refused. What matters is that it never reaches the insert.
    expect(res.statusCode).toBe(201);
    expect(inserted[0]?.author_kind).toBe('user');
  });

  it('never lets a client name a persona', async () => {
    // The same guarantee as `author_kind` above, and it needs its own case: a
    // client that could set this could file a message under the Ads
    // specialist's name in somebody's audit trail. The route never sends the
    // column at all, and `messages_insert_own` refuses one independently
    // (`20260912120000`), which is the layer this test cannot reach.
    tables.room_members = [
      { room_id: ROOM, user_id: USER, role: 'user', scope: 'room', thread_id: null },
    ];

    const app = await build();
    const res = await app.inject(post({ persona: 'ads' }));

    expect(res.statusCode).toBe(201);
    expect(inserted[0]).not.toHaveProperty('persona');
  });
});

describe('the messages select and MessageRow', () => {
  // The `PROJECT_COLUMNS` argument, applied to the other pinned select in this
  // service: a PostgREST select is a string, so a column the schema requires and
  // the query omits is invisible to the type checker and fails at runtime. For
  // `persona` the failure would be quieter still, because the row parses either
  // way and every specialist would simply render as the legacy Octopus.
  it('selects every column MessageRow requires', () => {
    const selected = new Set(MESSAGE_COLUMNS.split(',').map((c) => c.trim()));

    for (const column of Object.keys(MessageRow.shape)) {
      // The embedded relation is selected with its own column list, so it does
      // not appear as a bare name.
      if (column === 'action_embeds') continue;
      expect(selected.has(column), `MessageRow requires "${column}" and the read omits it`).toBe(
        true,
      );
    }
  });
});

describe('reading', () => {
  it('returns thread_id on every message', async () => {
    // `20260901121000` added the column and left the pinned select alone,
    // saying the reader lands with the slice that has something to read. This
    // is it: the owner's stream now interleaves two conversations.
    tables.messages = [
      {
        id: 'm1',
        room_id: ROOM,
        channel_id: THREAD_CHANNEL,
        author_id: USER,
        author_kind: 'node',
        body: 'on it',
        seq: 4,
        created_at: '2026-09-04T00:00:00.000Z',
        thread_id: THREAD,
        action_embeds: null,
      },
    ];

    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${ROOM}/messages`,
      headers: as(USER),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: { threadId: string | null; authorKind: string }[] };
    expect(body.messages[0]?.threadId).toBe(THREAD);
    expect(body.messages[0]?.authorKind).toBe('node');
  });
});
