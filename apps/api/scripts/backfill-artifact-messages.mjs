/**
 * Deliver artifacts that were written before the room lookup was fixed.
 *
 * `rooms.project_id` is claimed by the FIRST project approved in a room and
 * never released, and delivery used to resolve the room through it, so every
 * later project in a room produced finished, cited artifacts that reached
 * nobody. One real run stored eight of them and said nothing. `roomForProject`
 * now goes through `projects.source_embed_id` instead, which fixes new work and
 * cannot retrospectively announce the old.
 *
 * This posts them, using the same shape `postArtifact` writes so the backfilled
 * message is indistinguishable from one delivered on time:
 *
 *   body            step + title + body + the sources tail
 *   idempotency_key artifact:<artifactId>
 *   embed           component 'artifact', state 'reported', required_role owner
 *
 * Idempotent by that key, so running it twice delivers nothing twice. Kept
 * rather than deleted after use: this is the recovery tool for the failure
 * class, and the next one will be found the same way.
 *
 * Lives under `apps/api` rather than the repo root because ESM resolves imports
 * from the script's own directory, and `@supabase/supabase-js` is a workspace
 * dependency of this app rather than of the root.
 *
 * Usage, from the repo root:
 *   node --env-file=apps/api/.env apps/api/scripts/backfill-artifact-messages.mjs [--commit]
 *
 * Without `--commit` it prints what it would deliver and writes nothing.
 */

import { createClient } from '@supabase/supabase-js';

const commit = process.argv.includes('--commit');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SECRET_KEY are required.');
  console.error(
    'Run with: node --env-file=apps/api/.env apps/api/scripts/backfill-artifact-messages.mjs',
  );
  process.exit(1);
}

const admin = createClient(url, key, { auth: { persistSession: false } });

/** The same resolution `apps/api/src/lib/room-for-project.ts` performs. */
async function roomForProject(projectId) {
  const { data: project, error: projectError } = await admin
    .from('projects')
    .select('source_embed_id')
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) throw projectError;
  if (!project?.source_embed_id) return null;

  const { data: embed, error: embedError } = await admin
    .from('action_embeds')
    .select('room_id')
    .eq('id', project.source_embed_id)
    .maybeSingle();
  if (embedError) throw embedError;
  return embed?.room_id ?? null;
}

const { data: artifacts, error } = await admin
  .from('artifacts')
  .select('id, task_id, project_id, title, body, citations, created_at')
  .order('created_at', { ascending: true });
if (error) throw error;

console.log(`${artifacts.length} artifact(s) stored.`);

let delivered = 0;
let already = 0;
let skipped = 0;

for (const artifact of artifacts) {
  const { data: task } = await admin
    .from('tasks')
    .select('title, stage')
    .eq('id', artifact.task_id)
    .maybeSingle();

  const roomId = await roomForProject(artifact.project_id);
  if (!roomId || !task) {
    console.log(`  skip    ${artifact.id} (no room or task)`);
    skipped += 1;
    continue;
  }

  // Deduplicated, matching `postArtifact`. These rows were written before the
  // core deduped, so most of them repeat a document label several times.
  const citations = [...new Set(Array.isArray(artifact.citations) ? artifact.citations : [])];
  const sources = citations.length
    ? `\n\nSources: ${citations.join('; ')}`
    : '\n\nNo sources are cited for this, so treat it as unverified.';
  const body = `${task.title}\n\n${artifact.title}\n\n${artifact.body}${sources}`;
  const idempotencyKey = `artifact:${artifact.id}`;

  if (!commit) {
    console.log(`  would   ${artifact.title} -> room ${roomId.slice(0, 8)}`);
    delivered += 1;
    continue;
  }

  const { data: message, error: messageError } = await admin
    .from('messages')
    .insert({
      room_id: roomId,
      author_id: null,
      author_kind: 'agent',
      body,
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .maybeSingle();

  if (messageError) {
    // Already delivered. The key is what makes re-running safe.
    if (messageError.code === '23505') {
      already += 1;
      continue;
    }
    throw messageError;
  }
  if (!message) continue;

  const { error: embedError } = await admin.from('action_embeds').insert({
    message_id: message.id,
    room_id: roomId,
    component: 'artifact',
    payload: {
      taskId: artifact.task_id,
      artifactId: artifact.id,
      step: task.title.slice(0, 200),
      // Omitted rather than null: the payload treats stage as optional, and a
      // null would fail the enum where an absent field is legitimate.
      ...(task.stage ? { stage: task.stage } : {}),
      title: artifact.title.slice(0, 140),
      // The contract caps the body. Truncating here rather than failing keeps
      // the card renderable, and the full text is in the message above it.
      body: artifact.body.slice(0, 8000),
      citations,
    },
    required_role: 'owner',
    // Not `pending`, which would claim somebody owes an action, and not
    // `approved`, which would invent a human decision. It reports.
    state: 'reported',
  });
  if (embedError && embedError.code !== '23505') throw embedError;

  console.log(`  posted  ${artifact.title} -> room ${roomId.slice(0, 8)}`);
  delivered += 1;
}

console.log(
  commit
    ? `\ndelivered ${delivered}, already present ${already}, skipped ${skipped}`
    : `\n${delivered} would be delivered, ${skipped} skipped. Re-run with --commit to post them.`,
);
