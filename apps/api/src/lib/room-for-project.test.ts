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
import { roomForProject } from './room-for-project';

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
