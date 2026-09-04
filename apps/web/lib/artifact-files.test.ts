/**
 * What the card says about the files that came with a deliverable.
 *
 * Pure, and worth a test rather than an inline expression, because it holds one
 * rule that is easy to lose: the card counts the images and never renders them.
 * The bucket is private, so a picture in the stream means a signed URL, which is
 * a ten-minute bearer credential, minted afresh on every broadcast for everybody
 * with the room open (ADR-0033).
 */

import { describe, expect, it } from 'vitest';
import { imageCountLine, imageFilesOf, isImageArtifact } from './artifact-files';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('imageFilesOf', () => {
  it('keeps the images', () => {
    const files = [
      { artifactId: A, contentType: 'image/png' },
      { artifactId: B, contentType: 'image/jpeg' },
    ];
    expect(imageFilesOf({ files })).toHaveLength(2);
  });

  it('drops a file that is not an image, so the first non-image producer is a download', () => {
    const files = [
      { artifactId: A, contentType: 'image/png' },
      { artifactId: B, contentType: 'application/pdf' },
    ];
    expect(imageFilesOf({ files })).toEqual([{ artifactId: A, contentType: 'image/png' }]);
  });

  it('reads a card written before files existed as having none', () => {
    expect(imageFilesOf({ files: [] })).toEqual([]);
    expect(imageFilesOf({} as { files: [] })).toEqual([]);
  });
});

describe('imageCountLine', () => {
  it('says nothing at all when there are none', () => {
    expect(imageCountLine(0)).toBeNull();
  });

  it('counts one and several in the right words', () => {
    expect(imageCountLine(1)).toBe('1 image, in the project panel.');
    expect(imageCountLine(3)).toBe('3 images, in the project panel.');
  });

  it('is product copy: no em dash, and it ends in a period', () => {
    for (const n of [1, 2, 3]) {
      const line = imageCountLine(n)!;
      expect(line).not.toContain('—');
      expect(line.endsWith('.')).toBe(true);
    }
  });
});

describe('isImageArtifact', () => {
  it('is an image when there is a file and the type says so', () => {
    expect(isImageArtifact({ storagePath: 'p/a/image-1.png', contentType: 'image/png' })).toBe(
      true,
    );
  });

  it('is not an image when there is no file, whatever the type claims', () => {
    // A content type on a body-only row is a claim about bytes that do not
    // exist, which the database refuses; this is the reader refusing it too.
    expect(isImageArtifact({ storagePath: null, contentType: 'image/png' })).toBe(false);
  });

  it('reads a file written before the column existed as a download', () => {
    expect(isImageArtifact({ storagePath: 'p/a/proof.pdf', contentType: null })).toBe(false);
  });

  it('leaves a non-image file as a download', () => {
    expect(isImageArtifact({ storagePath: 'p/a/proof.pdf', contentType: 'application/pdf' })).toBe(
      false,
    );
  });
});
