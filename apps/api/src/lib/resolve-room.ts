import type { FastifyReply, FastifyRequest } from 'fastify';
import { createUserClient, type SupabaseConfig } from './supabase';

/**
 * Membership and ownership in one read, **as the caller**.
 *
 * Extracted from `routes/connections.ts`, where it was a closure, because the
 * model routes are its second caller and a second copy would be a second place
 * for the 404-not-403 rule to drift.
 *
 * That rule is the whole of why this exists. Both route groups govern tables
 * with no client grant, so the route is the entire control and membership has to
 * be established before any service-role client touches anything. Reading the
 * room as the caller is how: RLS answers the membership question, so the check
 * cannot be got wrong by a handler that forgot it.
 *
 * **404 rather than 403 for a room the caller cannot see**, matching every other
 * route: a non-member is not told the room exists. 403 is for a member who is not
 * the owner, which is a different sentence and a different fact.
 */
export async function resolveRoom(
  request: FastifyRequest,
  reply: FastifyReply,
  supabase: SupabaseConfig,
  roomId: string,
  fail: (reply: FastifyReply, status: number, error: string, message: string) => unknown,
): Promise<{ ownerId: string | null } | null> {
  const db = createUserClient(supabase, request.accessToken as string);
  const { data: room, error } = await db
    .from('rooms')
    .select('owner_id')
    .eq('id', roomId)
    .maybeSingle<{ owner_id: string | null }>();

  if (error) {
    request.log.error({ err: error, roomId }, 'room read failed');
    void fail(reply, 500, 'internal_error', 'Could not load the workspace.');
    return null;
  }
  if (!room) {
    void fail(reply, 404, 'not_found', 'Workspace not found.');
    return null;
  }
  return { ownerId: room.owner_id };
}
