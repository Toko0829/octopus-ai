/**
 * One engraving, and the light that sweeps across it on hover.
 *
 * The reference's imagery is public-domain engravings screened to one colour
 * and blended onto the ground. Ours are engravings of our own subjects (a
 * ledger, a seal, a signal mast), generated as black ink on white and then
 * split by `tools/art/engrave.mjs` into two encodes per subject:
 *
 * - `*-ink.webp`: inverted and tinted teal on black. Placed with
 *   `mix-blend-mode: screen`, the black disappears into the water and only
 *   the lines remain, as light. This is the version for the ground.
 * - `*-paper.webp`: the ink on white, placed with `mix-blend-mode: multiply`
 *   inside the paper panel, where the white disappears into the paper.
 *
 * The tint is baked by the script rather than done in CSS because a CSS
 * `filter` chain that reliably lands on one hue does not exist, and the hue
 * carries meaning here: teal is the agent (design-system.md, Color).
 *
 * Both encodes ship at 1x and 2x. A plain `<img>`, lazy below the fold, with
 * width and height set so the box is reserved before the bytes land. Every
 * engraving is below the fold now: the hero had one for an afternoon and the
 * owner rejected it, so the water and the arms carry the hero alone.
 */

type Props = {
  /** Basename under /engravings, e.g. `entry-tell`. */
  name: string;
  tone: 'ink' | 'paper';
  /** Intrinsic size of the 1x encode. */
  width: number;
  height: number;
  /** The hero image is above the fold and wants priority; everything else is lazy. */
  eager?: boolean;
  sizes?: string;
  className?: string;
};

export function Engraving({
  name,
  tone,
  width,
  height,
  eager = false,
  sizes = '(max-width: 900px) 100vw, 33vw',
  className,
}: Props) {
  const base = `/engravings/${name}-${tone}`;
  return (
    <figure className={['eng', `eng-${tone}`, className].filter(Boolean).join(' ')}>
      <img
        src={`${base}-1x.webp`}
        srcSet={`${base}-1x.webp ${width}w, ${base}-2x.webp ${width * 2}w`}
        sizes={sizes}
        width={width}
        height={height}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        fetchPriority={eager ? 'high' : 'auto'}
        decoding="async"
      />
      {/* The sweep: a diagonal band of light that crosses the picture while it
          is hovered or focused. CSS only; see landing.css under "Sweep". */}
      <span className="sweep" aria-hidden="true" />
    </figure>
  );
}
