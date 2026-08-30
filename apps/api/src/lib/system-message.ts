import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Post one idempotent system line into a room.
 *
 * Extracted when the optimize sweep would have been the **third** copy, which is
 * the rule `connections.ts` records for `auditConnection`: two copies is a
 * coincidence and three is where drift starts. The publish and metrics sweeps
 * carried identical implementations differing only in the noun of one log line,
 * and the idempotency key already names its origin better than the noun did.
 *
 * The key is the whole contract: a collision is the mechanism working, meaning
 * this pass had nothing new to say, so `23505` is silence rather than an error.
 * Never throws, because a message that failed to post must not undo the act it
 * was describing.
 */
export async function postSystemMessage(
  admin: SupabaseClient,
  log: { error: (obj: unknown, msg: string) => void },
  roomId: string,
  key: string,
  body: string,
): Promise<void> {
  const { error } = await admin.from('messages').insert({
    room_id: roomId,
    author_id: null,
    author_kind: 'system',
    body,
    idempotency_key: key,
  });
  if (error && error.code !== '23505') {
    log.error({ err: error, key }, 'could not post a system message');
  }
}
