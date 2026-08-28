import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Who owns a project, resolved the one way this codebase resolves it.
 *
 * Extracted rather than copied into a second caller, on the lesson
 * `20260827110000` cost: `roomForProject` and `private.is_project_member` were
 * answering the same question in two places, one of them wrongly, and the fix
 * went into one and not the other. **Three copies is where drift starts**, and
 * this is the third caller.
 *
 * **Through the plan card, never through `rooms.project_id`.** That column is
 * written once, under `where ... and project_id is null`, so the first project
 * approved in a room claims it forever and every project after it resolves to
 * nothing. `projects.source_embed_id` is unique, set at creation and never
 * changed: a project came from exactly one card, posted in exactly one room.
 *
 * **Read as the caller.** Pass a user-scoped client and RLS decides what is
 * visible, so a project they cannot see yields no owner and the check fails
 * closed rather than confirming the project exists.
 *
 * A null result means nobody owns it, never "anybody may act", which is the same
 * safe default `rooms.owner_id` takes for approvals.
 */
export async function resolveProjectOwner(
  db: SupabaseClient,
  projectId: string,
): Promise<{ ownerId: string | null; roomId: string | null }> {
  const { data: project, error: projectErr } = await db
    .from('projects')
    .select('source_embed_id')
    .eq('id', projectId)
    .maybeSingle<{ source_embed_id: string | null }>();
  if (projectErr) throw projectErr;
  if (!project?.source_embed_id) return { ownerId: null, roomId: null };

  const { data: embed, error: embedErr } = await db
    .from('action_embeds')
    .select('room_id')
    .eq('id', project.source_embed_id)
    .maybeSingle<{ room_id: string }>();
  if (embedErr) throw embedErr;
  if (!embed) return { ownerId: null, roomId: null };

  const { data: room, error: roomErr } = await db
    .from('rooms')
    .select('owner_id')
    .eq('id', embed.room_id)
    .maybeSingle<{ owner_id: string | null }>();
  if (roomErr) throw roomErr;

  return { ownerId: room?.owner_id ?? null, roomId: embed.room_id };
}
