/**
 * The two voices a sweep can speak in, and the rule that keeps them apart.
 *
 * **System says what a person or the platform did; a persona says what it did
 * or found.** That distinction is the whole reason these are two exported
 * functions rather than one with a nullable argument, and it is enforced twice:
 * here by the signature, and in Postgres by `messages_persona_agent_only`
 * (`20260912120000`), which refuses a persona on a system row.
 *
 * The idempotency contract is unchanged and is asserted for both: a collision is
 * the mechanism working, so `23505` is silence, and neither ever throws, because
 * a message that failed to post must not undo the act it was describing.
 */

import { describe, expect, it, vi } from 'vitest';
import { postPersonaMessage, postSystemMessage } from './system-message';

const ROOM = '88888888-8888-4888-8888-888888888888';

function admin(error: { code: string } | null = null) {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      insert: async (values: Record<string, unknown>) => {
        inserted.push(values);
        return { error };
      },
    }),
  };
  return { client: client as never, inserted };
}

function logger() {
  return { error: vi.fn() };
}

describe('postSystemMessage', () => {
  it('writes a system row with no persona', async () => {
    const { client, inserted } = admin();
    const log = logger();

    await postSystemMessage(client, log, ROOM, 'offer-accepted:1', 'An expert accepted the step.');

    expect(inserted[0]).toMatchObject({
      room_id: ROOM,
      author_id: null,
      author_kind: 'system',
      persona: null,
      idempotency_key: 'offer-accepted:1',
    });
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('postPersonaMessage', () => {
  it('writes an agent row signed by the voice it was given', async () => {
    const { client, inserted } = admin();

    await postPersonaMessage(client, logger(), ROOM, 'campaign-published:1', 'It is live.', 'ads');

    expect(inserted[0]).toMatchObject({
      author_id: null,
      author_kind: 'agent',
      persona: 'ads',
      idempotency_key: 'campaign-published:1',
    });
  });

  it('says nothing about a duplicate key, because that is the mechanism working', async () => {
    const { client } = admin({ code: '23505' });
    const log = logger();

    await postPersonaMessage(client, log, ROOM, 'campaign-paused:1:0', 'Paused.', 'analyst');

    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs any other failure and still does not throw', async () => {
    // The sweep that called this has already paused a campaign or published
    // one. Throwing here would unwind a caller that has nothing left to undo.
    const { client } = admin({ code: '42501' });
    const log = logger();

    await expect(
      postPersonaMessage(client, log, ROOM, 'campaign-paused:1:0', 'Paused.', 'analyst'),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledOnce();
  });
});
