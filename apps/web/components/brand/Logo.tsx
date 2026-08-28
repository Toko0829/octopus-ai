import type { SVGProps } from 'react';

/**
 * The Octopus mark.
 *
 * Built to the brief that has been sitting unbuilt in `brand.md` since Phase 0:
 * geometric, confident, single-weight, teal used sparingly, no gradient blobs,
 * and it has to read at 16px as a favicon and as a wordmark. In practice the
 * floor is lower than the brief says: the chat already renders it at **13px**
 * next to a system message, so that is the size the geometry is drawn for.
 *
 * Three decisions the drawing makes.
 *
 * - **Filled silhouette, not a stroke.** The previous mark was a 1.6px outline
 *   with a hand-drawn wavy base. An outline at 13px is a grey smudge; a solid
 *   shape holds. "Single-weight" is honoured by there being no stroke at all
 *   rather than by picking one.
 * - **Three deep lobes, not eight thin arms.** Eight arms is the metaphor, not
 *   the drawing: at 13px eight of anything is a texture. Three lobes keep a
 *   silhouette that survives, and the octopus reads from the whole shape.
 * - **The eyes are knocked out, not painted.** `fill-rule="evenodd"` means the
 *   mark is one path in one colour and works on any background, including
 *   inside the coloured agent avatar, without a second fill to keep in sync.
 *
 * The mark is `currentColor` everywhere. The teal only ever arrives from the
 * context it is placed in (the agent avatar, the rail), which is what "used
 * sparingly" has to mean for something rendered this often.
 */

type P = SVGProps<SVGSVGElement>;

/** Head + three lobes, eyes knocked out. One path, one colour. */
const MARK_PATH =
  'M4.6 15.2C4.6 8.6 7.9 4.6 12 4.6C16.1 4.6 19.4 8.6 19.4 15.2' +
  'Q16.93 19.4 14.47 15.2Q12 19.4 9.53 15.2Q7.07 19.4 4.6 15.2Z' +
  'M10.85 11.6A1.35 1.35 0 1 1 8.15 11.6A1.35 1.35 0 1 1 10.85 11.6Z' +
  'M15.85 11.6A1.35 1.35 0 1 1 13.15 11.6A1.35 1.35 0 1 1 15.85 11.6Z';

export function OctopusMark({ width = 16, height = 16, ...p }: P) {
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...p}
    >
      <path d={MARK_PATH} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
