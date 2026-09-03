import type { AgentPersona } from '@octopus/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

type Logger = { error: (obj: unknown, msg: string) => void };

/**
 * Post one idempotent line into a room, as the platform or as an agent voice.
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
async function post(
  admin: SupabaseClient,
  log: Logger,
  roomId: string,
  key: string,
  body: string,
  persona: AgentPersona | null,
): Promise<void> {
  const { error } = await admin.from('messages').insert({
    room_id: roomId,
    author_id: null,
    author_kind: persona === null ? 'system' : 'agent',
    persona,
    body,
    idempotency_key: key,
  });
  if (error && error.code !== '23505') {
    log.error({ err: error, key, persona }, 'could not post a message into the room');
  }
}

/**
 * The platform's own voice.
 *
 * **What belongs here is what a person or a platform did**, not what the AI did:
 * an offer accepted, work started, proof submitted, a dispute raised or
 * resolved, a payout, a deadline warning, an embed decision, a run that failed.
 * These are records of somebody else's action, and putting a specialist's name
 * on one would claim the AI had done it. The distinction is enforced by the
 * table as well as by this signature: `messages_persona_agent_only`
 * (`20260912120000`) refuses a persona on a system row.
 */
export async function postSystemMessage(
  admin: SupabaseClient,
  log: Logger,
  roomId: string,
  key: string,
  body: string,
): Promise<void> {
  await post(admin, log, roomId, key, body, null);
}

/**
 * One of the four agent voices, saying what it did or found.
 *
 * The sibling of `postSystemMessage` rather than a parameter on it, because the
 * two are different claims about who acted and a caller should have to choose
 * one. A campaign going live is Ads reporting on its own work; a campaign paused
 * on the cost ceiling is the Analyst reporting on what it measured; an expert
 * accepting a step is neither.
 *
 * **A voice, not a writer** ([ADR-0031](../../../../docs/40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)):
 * nothing about who may act changes because a message is signed.
 */
export async function postPersonaMessage(
  admin: SupabaseClient,
  log: Logger,
  roomId: string,
  key: string,
  body: string,
  persona: AgentPersona,
): Promise<void> {
  await post(admin, log, roomId, key, body, persona);
}
