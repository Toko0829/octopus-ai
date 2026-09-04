/**
 * The two properties that make a file artifact safe, against a mocked storage
 * client.
 *
 * Both are invisible when they break. A path built without sanitising the
 * filename still uploads; it just lands in the wrong tenant folder, or in none,
 * and nothing errors. An orphaned object after a failed insert costs money and
 * is unreachable by every path in the product, so nothing will ever report it.
 */

import { describe, expect, it } from 'vitest';
import {
  ARTIFACTS_BUCKET,
  artifactObjectPath,
  safeFilename,
  writeFileArtifact,
  type WriteFileArtifactInput,
} from './artifact-files';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';

function input(over: Partial<WriteFileArtifactInput> = {}): WriteFileArtifactInput {
  return {
    taskId: TASK,
    projectId: PROJECT,
    kind: 'asset',
    title: 'Launch creative',
    bytes: new Uint8Array([1, 2, 3]),
    contentType: 'image/png',
    filename: 'launch.png',
    ...over,
  };
}

/**
 * A stand-in for the parts of the service client this module touches. Built by
 * hand rather than with a Supabase mock library, so what is being asserted is
 * visible in the file that asserts it.
 */
function fakeAdmin(opts: { uploadError?: string; insertError?: string; noRow?: boolean } = {}) {
  const uploaded: Array<{ path: string; contentType: string; upsert: boolean }> = [];
  const removed: string[][] = [];
  const inserted: Array<Record<string, unknown>> = [];

  const storage = {
    from: (bucket: string) => ({
      upload: async (
        path: string,
        _bytes: Uint8Array,
        o: { contentType: string; upsert: boolean },
      ) => {
        expect(bucket).toBe(ARTIFACTS_BUCKET);
        uploaded.push({ path, contentType: o.contentType, upsert: o.upsert });
        return opts.uploadError ? { error: { message: opts.uploadError } } : { error: null };
      },
      remove: async (paths: string[]) => {
        expect(bucket).toBe(ARTIFACTS_BUCKET);
        removed.push(paths);
        return { error: null };
      },
    }),
  };

  const admin = {
    storage,
    from: (_table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          select: () => ({
            maybeSingle: async () =>
              opts.insertError
                ? { data: null, error: { message: opts.insertError } }
                : { data: opts.noRow ? null : { id: row.id }, error: null },
          }),
        };
      },
    }),
  };

  return { admin: admin as never, uploaded, removed, inserted };
}

describe('the path is the tenancy scheme', () => {
  it('puts the project id first, because that is what the storage policy reads', () => {
    const path = artifactObjectPath(PROJECT, 'aaaa', 'brief.pdf');

    expect(path).toBe(`${PROJECT}/aaaa/brief.pdf`);
    expect(path.split('/')[0]).toBe(PROJECT);
  });

  it('cannot be climbed out of by a filename', () => {
    // The name arrives from an artifact title or a provider response, so it is
    // untrusted (rule 8). A `../` that escaped the tenant folder would make the
    // object invisible at best, and visible to the wrong project at worst.
    for (const nasty of ['../../etc/passwd', 'a/b/c.pdf', '..\\..\\win.ini', '/absolute.pdf']) {
      const path = artifactObjectPath(PROJECT, 'aaaa', nasty);

      expect(path.split('/')[0]).toBe(PROJECT);
      expect(path.split('/')).toHaveLength(3);
      expect(path).not.toContain('..');
    }
  });

  it('always produces a filename, even from one made entirely of separators', () => {
    expect(safeFilename('///')).toBe('file');
    expect(safeFilename('')).toBe('file');
    expect(safeFilename('...')).toBe('file');
  });

  it('keeps an ordinary name readable', () => {
    expect(safeFilename('Q3 launch (final).png')).toBe('Q3-launch-final-.png');
  });
});

describe('the object and the row land together', () => {
  it('uploads, then writes a row with the storage path and a null body', async () => {
    const { admin, uploaded, inserted } = fakeAdmin();

    const result = await writeFileArtifact(admin, input());

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.path).toBe(result.storagePath);
    // Never overwrite: the path carries a fresh uuid, so a collision means our
    // own id generation is wrong, and silently replacing another artifact's file
    // is the wrong way to discover that.
    expect(uploaded[0]?.upsert).toBe(false);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.storage_path).toBe(result.storagePath);
    // `artifacts_have_content` accepts storage_path with no body. A placeholder
    // string would render the file artifact as an empty paragraph in the panel.
    expect(inserted[0]?.body).toBeNull();
    expect(inserted[0]?.project_id).toBe(PROJECT);
  });

  it('does not write a row when the upload failed', async () => {
    const { admin, inserted } = fakeAdmin({ uploadError: 'bucket unavailable' });

    await expect(writeFileArtifact(admin, input())).rejects.toThrow(/Could not store/);
    // A row pointing at nothing would satisfy the check constraint and 404 on
    // download, which lies to a person about what was delivered.
    expect(inserted).toHaveLength(0);
  });

  it('removes the object when the row could not be written', async () => {
    const { admin, uploaded, removed } = fakeAdmin({ insertError: 'fk violation' });

    await expect(writeFileArtifact(admin, input())).rejects.toThrow(/Could not record/);

    // The orphan this prevents is unreachable by every path in the product: no
    // row lists it, no route reads it, and the storage policy resolves tenancy
    // from the path rather than from anything that tells a person it exists.
    expect(removed).toEqual([[uploaded[0]?.path]]);
  });

  it('treats a silent no-row insert as a failure, not as success', async () => {
    // The shape that would otherwise slip through: no error, no row. Returning
    // an artifactId of `undefined` here would surface much later as a broken
    // link rather than as a failed write.
    const { admin, removed } = fakeAdmin({ noRow: true });

    await expect(writeFileArtifact(admin, input())).rejects.toThrow(/Could not record/);
    expect(removed).toHaveLength(1);
  });

  it('reports the insert failure rather than a cleanup failure', async () => {
    // The compensating delete is best-effort on purpose. Replacing the caller's
    // error with the cleanup's would report the second symptom and hide the
    // first, which is the whole reason that catch is empty.
    const { admin } = fakeAdmin({ insertError: 'fk violation' });
    const failingRemove = {
      ...(admin as unknown as Record<string, unknown>),
      storage: {
        from: () => ({
          upload: async () => ({ error: null }),
          remove: async () => {
            throw new Error('storage is down too');
          },
        }),
      },
    };

    await expect(writeFileArtifact(failingRemove as never, input())).rejects.toThrow(
      /Could not record/,
    );
  });
});

describe('the bytes are whatever the caller had', () => {
  it('passes the declared content type through unchanged', async () => {
    const { admin, uploaded } = fakeAdmin();

    await writeFileArtifact(admin, input({ contentType: 'application/pdf', filename: 'a.pdf' }));

    expect(uploaded[0]?.contentType).toBe('application/pdf');
  });

  it('writes the same type onto the row, so the object and the row agree', async () => {
    // One call site knows both, which is the whole reason the column exists: a
    // reader without it would infer the type from the filename, and the filename
    // is sanitised out of untrusted input (ADR-0033).
    const { admin, uploaded, inserted } = fakeAdmin();

    await writeFileArtifact(admin, input({ contentType: 'image/png', filename: 'image-1.png' }));

    expect(inserted[0]?.content_type).toBe('image/png');
    expect(inserted[0]?.content_type).toBe(uploaded[0]?.contentType);
  });
});
