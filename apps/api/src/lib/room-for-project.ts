import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Which room a project's work should be announced in.
 *
 * **Resolved through the plan card, not through `rooms.project_id`.** That column
 * is written once, by `materialise_plan`, under `where ... and project_id is
 * null`, so the FIRST project approved in a room claims it permanently. Approve a
 * second plan in the same room and its project is never linked. That was not
 * theoretical: a real run produced **8 approved tasks and 8 stored artifacts,
 * none of which reached the chat**, because the room still pointed at a project
 * from nine days earlier. The old lookup then returned no room and gave up
 * silently, so the person saw a plan approved and then nothing at all.
 *
 * `projects.source_embed_id` answers the same question durably. It is unique, set
 * at creation, and never changes: a project came from exactly one card, and that
 * card was posted in exactly one room. Going through it lets a room carry any
 * number of projects over its life, which is what a chat room actually is.
 *
 * `rooms.project_id` keeps its meaning as "the project this room is currently
 * about", which is a fine thing for a UI to read. It is simply not the delivery
 * path, because it answers a question that changes and this one does not.
 *
 * Two plain reads rather than one embedded join. PostgREST can express this as
 * `action_embeds!inner(room_id)`, which depends on it detecting the foreign key
 * and naming the relationship the way we guessed. Guessing wrong there fails
 * silently, and a silent failure in the delivery path is the exact defect this
 * file exists to remove. One extra round trip, once per announcement, buys
 * certainty.
 */
export async function roomForProject(
  admin: SupabaseClient,
  projectId: string,
): Promise<string | null> {
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('source_embed_id')
    .eq('id', projectId)
    .maybeSingle<{ source_embed_id: string | null }>();

  if (projectError) throw projectError;
  if (!project?.source_embed_id) return null;

  const { data: embed, error: embedError } = await admin
    .from('action_embeds')
    .select('room_id')
    .eq('id', project.source_embed_id)
    .maybeSingle<{ room_id: string }>();

  if (embedError) throw embedError;
  return embed?.room_id ?? null;
}
