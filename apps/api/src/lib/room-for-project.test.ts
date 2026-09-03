/**
 * Which room a project's work is announced in.
 *
 * The property under test is that **a second plan approved in the same room can
 * still deliver**. `rooms.project_id` is claimed by the first project and never
 * released, so resolving through it meant a real run produced 8 approved tasks
 * and 8 stored artifacts that reached nobody, while the room still pointed at a
 * project from nine days earlier. Nothing raised: the lookup returned no room and
 * the announcement returned early.
 *
 * These tests use a hand-built stub rather than a mock library, so the exact
 * table and column each query touches is visible in the assertions.
 */

import { describe, expect, it } from 'vitest';
import { liveProjectForRoom, roomForProject } from './room-for-project';

type Row = Record<string, unknown> | null;

/** Records which tables were read, and answers with canned rows. */
function stub(rows: Record<string, Row>, errors: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const client = {
    from(table: string) {
      seen.push(table);
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: errors[table] ?? null }),
      };
      return builder;
    },
  };
  return { client: client as never, seen };
}

describe('the room a project delivers into', () => {
  it('resolves through the plan card the project was created from', async () => {
    const { client, seen } = stub({
      projects: { source_embed_id: 'embed-1' },
      action_embeds: { room_id: 'room-1' },
    });

    expect(await roomForProject(client, 'project-1')).toBe('room-1');
    // Deliberately NOT via `rooms`: that is the column a second project in the
    // same room can never claim.
    expect(seen).toEqual(['projects', 'action_embeds']);
    expect(seen).not.toContain('rooms');
  });

  it('returns null when the project has no source card', async () => {
    const { client } = stub({ projects: { source_embed_id: null } });
    expect(await roomForProject(client, 'project-1')).toBeNull();
  });

  it('returns null when the project does not exist', async () => {
    const { client } = stub({ projects: null });
    expect(await roomForProject(client, 'missing')).toBeNull();
  });

  it('throws rather than reporting no room when the read fails', async () => {
    // The distinction is the whole point. "No room" makes the caller give up
    // quietly; a failed read is a fault and must not be able to impersonate it,
    // because that is how delivered work goes missing without a word.
    const { client } = stub({}, { projects: { message: 'connection reset' } });
    await expect(roomForProject(client, 'project-1')).rejects.toMatchObject({
      message: 'connection reset',
    });
  });

  it('throws when the card read fails, for the same reason', async () => {
    const { client } = stub(
      { projects: { source_embed_id: 'embed-1' } },
      { action_embeds: { message: 'timeout' } },
    );
    await expect(roomForProject(client, 'project-1')).rejects.toMatchObject({
      message: 'timeout',
    });
  });
});


/**
 * Which project a mention in a room is about.
 *
 * Same argument as the function above, inverted: a room's projects are found
 * through the plan cards posted in it, because `rooms.project_id` is claimed
 * permanently by the first plan approved there. Resolving no project would turn
 * a mention into a fresh intake, which is the regeneration a replan card exists
 * to prevent, so "found nothing" has to mean nothing is running rather than
 * "the lookup took the wrong route".
 */
function listStub(rows: Record<string, Row[]>) {
  const seen: string[] = [];
  const client = {
    from(table: string) {
      seen.push(table);
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          filters[`in:${col}`] = vals;
          return builder;
        },
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          const all = rows[table] ?? [];
          const matched = all.filter((r) =>
            Object.entries(filters).every(([key, val]) => {
              if (key.startsWith('in:')) {
                return (val as unknown[]).includes((r as Record<string, unknown>)[key.slice(3)]);
              }
              return (r as Record<string, unknown>)[key] === val;
            }),
          );
          return resolve({ data: matched, error: null });
        },
      });
      return builder;
    },
  };
  return { client: client as never, seen };
}

const proj = (id: string, status: string, createdAt: string, embed: string | null) => ({
  id,
  goal: `goal ${id}`,
  status,
  created_at: createdAt,
  source_embed_id: embed,
});

describe('the project a mention is about', () => {
  it('finds a project through a plan card posted in the room', async () => {
    const { client } = listStub({
      rooms: [{ project_id: null }],
      action_embeds: [{ id: 'embed-1', room_id: 'room-1', component: 'plan' }],
      projects: [proj('p1', 'active', '2026-09-01T00:00:00Z', 'embed-1')],
    });

    expect(await liveProjectForRoom(client, 'room-1')).toMatchObject({ id: 'p1', status: 'active' });
  });

  it('still finds one linked only by rooms.project_id', async () => {
    // The legacy link. A room whose first plan predates the card lookup would
    // otherwise answer "nothing running" and send a mention into a fresh plan.
    const { client } = listStub({
      rooms: [{ project_id: 'p-legacy' }],
      action_embeds: [],
      projects: [proj('p-legacy', 'active', '2026-08-01T00:00:00Z', null)],
    });

    expect(await liveProjectForRoom(client, 'room-1')).toMatchObject({ id: 'p-legacy' });
  });

  it('takes the newest when a room has run more than one venture', async () => {
    const { client } = listStub({
      rooms: [{ project_id: null }],
      action_embeds: [
        { id: 'e1', room_id: 'room-1', component: 'plan' },
        { id: 'e2', room_id: 'room-1', component: 'plan' },
      ],
      projects: [
        proj('old', 'active', '2026-07-01T00:00:00Z', 'e1'),
        proj('new', 'active', '2026-09-01T00:00:00Z', 'e2'),
      ],
    });

    expect((await liveProjectForRoom(client, 'room-1'))?.id).toBe('new');
  });

  it('ignores a project that is finished or cancelled', async () => {
    // Proposing a change to a completed project is proposing a change to
    // nothing. The mention falls through to an ordinary goal instead.
    const { client } = listStub({
      rooms: [{ project_id: null }],
      action_embeds: [{ id: 'e1', room_id: 'room-1', component: 'plan' }],
      projects: [proj('done', 'completed', '2026-09-01T00:00:00Z', 'e1')],
    });

    expect(await liveProjectForRoom(client, 'room-1')).toBeNull();
  });

  it('returns null for a room with nothing in it', async () => {
    const { client } = listStub({ rooms: [{ project_id: null }], action_embeds: [], projects: [] });
    expect(await liveProjectForRoom(client, 'room-1')).toBeNull();
  });
});
