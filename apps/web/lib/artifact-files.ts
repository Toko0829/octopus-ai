import type { ArtifactEmbedPayload } from '@octopus/contracts';

/**
 * Reading the file half of a delivered artifact.
 *
 * Pure, and in `lib` rather than inside the card, for the reason every helper
 * here is: the card is a rendering decision and this is a rule about what a
 * payload means, and a rule with a test beside it is a rule that stays true.
 */

/**
 * The generated images on a deliverable, ignoring anything that is not one.
 *
 * **Filtered on the content type rather than trusted wholesale**, because `files`
 * is a stored payload and this decides whether the browser is asked to render
 * bytes as a picture. Today the only producer writes PNGs (ADR-0033), so the
 * filter removes nothing; it exists so that the first non-image file artifact,
 * whenever it arrives, is a download in the panel and not a broken `<img>` on a
 * card.
 */
export function imageFilesOf(payload: Pick<ArtifactEmbedPayload, 'files'>) {
  return (payload.files ?? []).filter((f) => f.contentType.startsWith('image/'));
}

/**
 * Whether a stored artifact is a picture the panel should render.
 *
 * Takes the row rather than the card payload, so the panel and the card read the
 * same rule from the same place. Null `contentType` is every file written before
 * the column existed, and its answer is no: those rows keep the download they
 * already had.
 */
export function isImageArtifact(artifact: {
  contentType?: string | null;
  storagePath?: string | null;
}): boolean {
  return Boolean(artifact.storagePath) && (artifact.contentType ?? '').startsWith('image/');
}

/**
 * What the card says about them, in words rather than as a bare number.
 *
 * The card deliberately does not render the pictures. A download link is a
 * ten-minute bearer credential minted per request, and the message stream
 * re-renders on every broadcast, so an inline image would mint one link per
 * artifact per re-render for everyone with the room open. The panel fetches one
 * on a click, which is where the images live.
 */
export function imageCountLine(count: number): string | null {
  if (count <= 0) return null;
  const noun = count === 1 ? 'image' : 'images';
  return `${count} ${noun}, in the project panel.`;
}
