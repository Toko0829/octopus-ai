import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { IntakeSlot } from '@octopus/contracts';

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

/**
 * What intake established about the person this project belongs to.
 *
 * Read from the same card, for the same reason: it is the record of what was
 * approved, and `projects.source_embed_id` already points at it. Storing the
 * slots there rather than in a new column meant no migration, and it keeps the
 * context inseparable from the plan it shaped.
 *
 * Returns `[]` rather than throwing when a card predates this field or carries a
 * malformed one. The executor writes for the reader the sources describe when
 * context is absent, which is exactly the behaviour that shipped before this
 * existed, so a missing context degrades to the old output rather than failing.
 */
export async function planContextForProject(
  admin: SupabaseClient,
  projectId: string,
): Promise<IntakeSlot[]> {
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('source_embed_id')
    .eq('id', projectId)
    .maybeSingle<{ source_embed_id: string | null }>();

  if (projectError) throw projectError;
  if (!project?.source_embed_id) return [];

  const { data: embed, error: embedError } = await admin
    .from('action_embeds')
    .select('payload')
    .eq('id', project.source_embed_id)
    .maybeSingle<{ payload: unknown }>();

  if (embedError) throw embedError;

  // Parsed rather than cast. This payload is old data written by an earlier
  // version of the code, so its shape is a claim to be checked and not a fact.
  const parsed = z
    .array(IntakeSlot)
    .safeParse((embed?.payload as { context?: unknown } | null)?.context ?? []);
  return parsed.success ? parsed.data : [];
}
