/**
 * Writing an artifact that is a file rather than a paragraph.
 *
 * `artifacts` has carried a `storage_path` since `20260813160000` and nothing
 * could ever fill it: no bucket, no policy, no reader, no writer. `20260829124000`
 * added the first three and this is the fourth.
 *
 * **The object and the row are written together, and the object is removed if the
 * row fails.** An object with no row is unreachable by every path in the system:
 * the project detail route lists rows, the download route reads a row, and the
 * `storage.objects` policy resolves a tenant out of the path rather than out of
 * anything that would tell a person the file exists. So a failure that left one
 * behind would leave a file nobody could find, nobody could delete through the
 * product, and everybody would keep paying to store. Postgres has no transaction
 * that spans object storage, so the compensation is explicit.
 *
 * The other order (row first, then upload) was considered and is worse: the row
 * would satisfy `artifacts_have_content` while pointing at nothing, and the
 * download route would 404 on an artifact the panel lists as delivered. A missing
 * file that is visible is worse than a stored file that is invisible, because the
 * first one lies to a person and the second one only costs money.
 *
 * **Uploads are Node-initiated only, and that is a decision rather than a
 * scheduling accident.** The Python service has no storage keys by design
 * (ADR-0006) and never handles bytes. That stayed true when the byte-producer
 * arrived: `generate_image` is a proposal `services/ai` writes and `apps/api`
 * executes with the workspace's own key, so the bytes are minted on this side and
 * the seam is exactly where it was (ADR-0033). The wire shape was designed with
 * its producer rather than ahead of it, which is why that proposal carries a
 * prompt, a count and an aspect, and carries no bytes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const ARTIFACTS_BUCKET = 'artifacts';

export interface WriteFileArtifactInput {
  taskId: string;
  projectId: string;
  kind: 'draft' | 'analysis' | 'asset' | 'proof' | 'answer';
  title: string | null;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  /**
   * Who produced it. Defaults to `agent`, which is what this writer hardcoded
   * while it had no caller at all; slice 6 gave it one and the default became
   * wrong for it. A node's proof written as `agent` is a row that lies about its
   * author on the one surface where authorship is the point, and `author_kind`
   * has carried `'node'` since `20260728120000`.
   */
  createdBy?: 'agent' | 'user' | 'node' | 'system';
  /** Which attempt produced it, so the file ties back to a trace. */
  taskRunId?: string | null;
  citations?: unknown;
}

export interface WriteFileArtifactResult {
  artifactId: string;
  storagePath: string;
}

/**
 * The tenancy scheme, as a function, because it is stated in three places and
 * two of them are not code.
 *
 * `<project_id>/<artifact_id>/<filename>`. The first segment is what the
 * `storage.objects` policy reads, so a file written anywhere else in this bucket
 * is visible to nobody. That is the safe direction for the convention to fail in,
 * and it is why this is not built inline at the call site.
 */
export function artifactObjectPath(
  projectId: string,
  artifactId: string,
  filename: string,
): string {
  return `${projectId}/${artifactId}/${safeFilename(filename)}`;
}

/**
 * A filename that cannot change which folder the object lands in.
 *
 * The name reaches here from an artifact title or a provider's response, so it is
 * untrusted (rule 8). A `../` or a bare `/` in it would move the object out of
 * its tenant folder, and the object would then either be invisible or, if it
 * climbed to another project's uuid, be visible to the wrong people. Separators
 * and traversal are removed rather than rejected, because a file with an awkward
 * name should still be delivered.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file';
}

/**
 * Upload the bytes, then write the row that makes them findable.
 *
 * `admin` is the service client: Storage writes need a key no client may hold,
 * and the callers of this are trusted server code that has already decided the
 * artifact should exist. It is never reachable from a request that has not been
 * authorised, which is the same contract every other `service_role` use here has.
 */
export async function writeFileArtifact(
  admin: SupabaseClient,
  input: WriteFileArtifactInput,
): Promise<WriteFileArtifactResult> {
  // The id is minted here rather than by the database default, because the path
  // contains it and the object has to be uploaded before the row exists.
  const artifactId = crypto.randomUUID();
  const storagePath = artifactObjectPath(input.projectId, artifactId, input.filename);

  const { error: uploadError } = await admin.storage
    .from(ARTIFACTS_BUCKET)
    .upload(storagePath, input.bytes, {
      contentType: input.contentType,
      // Never overwrite. The path carries a fresh uuid, so a collision means
      // something is wrong with our own id generation, and silently replacing
      // another artifact's file is the wrong way to find that out.
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Could not store the artifact file: ${uploadError.message}`);
  }

  const { data: row, error: insertError } = await admin
    .from('artifacts')
    .insert({
      id: artifactId,
      task_id: input.taskId,
      project_id: input.projectId,
      kind: input.kind,
      title: input.title,
      // Null on purpose. `artifacts_have_content` accepts a row with a
      // storage_path and no body, and writing a placeholder string would make a
      // file artifact render as an empty paragraph in the panel.
      body: null,
      storage_path: storagePath,
      // The same value the object was uploaded with, written by the one call
      // site that knows both, so the row and the object cannot disagree. A
      // reader without it would infer the type from the filename, which this
      // file sanitises out of untrusted input, so the panel would be deciding
      // whether to render an image from a string a model chose.
      content_type: input.contentType,
      citations: input.citations ?? [],
      task_run_id: input.taskRunId ?? null,
      created_by: input.createdBy ?? 'agent',
    })
    .select('id')
    .maybeSingle<{ id: string }>();

  if (insertError || !row) {
    // Compensate. A failure here is rare and the orphan it would leave is
    // permanent and invisible, which is exactly the trade that justifies the
    // extra call.
    await admin.storage
      .from(ARTIFACTS_BUCKET)
      .remove([storagePath])
      .catch(() => {
        // Deliberately swallowed, and this is the one place in this file where
        // that is right: the caller's problem is the failed insert, and
        // replacing that error with a cleanup error would report the second
        // symptom and hide the first.
      });
    throw new Error(
      `Could not record the artifact row: ${insertError?.message ?? 'no row returned'}`,
    );
  }

  return { artifactId: row.id, storagePath };
}
