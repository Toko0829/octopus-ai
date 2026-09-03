/**
 * Route tests for the workspace profile: what a room knows about its business.
 *
 * Two properties carry the value. **Only the owner writes**, checked on the
 * route before anything reaches the database, and **only the keys sent are
 * written**, because the same row has three writers (this route, the question
 * card, intake) and a whole-row upsert from any of them would erase what the
 * others established.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333';

let roomRow: Record<string, unknown> | null;
let profileRow: Record<string, unknown> | null;
let upserts: { values: Record<string, unknown>; options: unknown }[];

function client() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => {
          if (table === 'rooms') return { data: roomRow, error: null };
          if (table === 'room_profiles') return { data: profileRow, error: null };
          return { data: null, error: null };
        },
        upsert: (values: Record<string, unknown>, options: unknown) => {
          upserts.push({ values, options });
          profileRow = { ...(profileRow ?? {}), ...values };
          return b;
        },
      });
      return b;
    },
  };
}

vi.mock('../lib/supabase', () => ({
  createUserClient: () => client(),
  createServiceClient: () => client(),
}));

const { roomRoutes } = await import('./rooms');

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(roomRoutes, {
    verify: async (token: string) => ({ sub: token, role: 'user' as const }),
    supabase: { url: 'http://localhost', publishableKey: 'k', secretKey: 's' } as never,
  } as never);
  return app;
}

const as = (userId: string) => ({ authorization: `Bearer ${userId}` });
const url = `/api/rooms/${ROOM}/profile`;

beforeEach(() => {
  roomRow = { id: ROOM, owner_id: OWNER };
  profileRow = {
    room_id: ROOM,
    icp: 'solo founders',
    offer: null,
    budget_band: '500_2k',
    timeline: null,
    updated_at: '2026-09-11T00:00:00Z',
  };
  upserts = [];
});

describe('GET /api/rooms/:roomId/profile', () => {
  it('returns the stored facts in the contract shape', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url, headers: as(OWNER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile).toEqual({
      roomId: ROOM,
      icp: 'solo founders',
      offer: null,
      budgetBand: '500_2k',
      timeline: null,
      updatedAt: '2026-09-11T00:00:00Z',
    });
  });

  it('returns nulls, not a refusal, when RLS shows no row', async () => {
    // A member who is not the owner reads zero rows. The API does not say
    // whether a row exists for a room it will not show them.
    profileRow = null;
    const app = await build();
    const res = await app.inject({ method: 'GET', url, headers: as(STRANGER) });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.icp).toBeNull();
  });

  it('shows a non-canonical chip value as nothing rather than as a chip nobody can select', async () => {
    profileRow = { ...profileRow, budget_band: 'about two thousand' };
    const app = await build();
    const res = await app.inject({ method: 'GET', url, headers: as(OWNER) });
    expect(res.json().profile.budgetBand).toBeNull();
  });
});

describe('PATCH /api/rooms/:roomId/profile', () => {
  it('refuses a member who is not the owner, and writes nothing', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: as(STRANGER),
      payload: { icp: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(upserts).toEqual([]);
  });

  it('refuses when the room has no owner', async () => {
    roomRow = { id: ROOM, owner_id: null };
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: as(OWNER),
      payload: { icp: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes only the keys sent, keyed on the room', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: as(OWNER),
      payload: { offer: 'a course' },
    });
    expect(res.statusCode).toBe(200);
    expect(upserts).toHaveLength(1);
    const { values, options } = upserts[0]!;
    expect(options).toEqual({ onConflict: 'room_id' });
    expect(values).toMatchObject({ room_id: ROOM, offer: 'a course', updated_by: OWNER });
    // The audience typed earlier is not in the statement at all.
    expect('icp' in values).toBe(false);
    expect('budget_band' in values).toBe(false);
  });

  it('clears a field with null and leaves an absent one alone', async () => {
    const app = await build();
    await app.inject({ method: 'PATCH', url, headers: as(OWNER), payload: { budgetBand: null } });
    expect(upserts[0]?.values).toMatchObject({ budget_band: null });
    expect('timeline' in upserts[0]!.values).toBe(false);
  });

  it('refuses a budget band outside the listed values', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: as(OWNER),
      payload: { budgetBand: 'lots' },
    });
    expect(res.statusCode).toBe(400);
    expect(upserts).toEqual([]);
  });

  it('refuses a key it does not know, rather than dropping it', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'PATCH',
      url,
      headers: as(OWNER),
      payload: { targetMetric: '100 customers' },
    });
    expect(res.statusCode).toBe(400);
  });
});
