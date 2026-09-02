/**
 * The page ground: the water, everywhere.
 *
 * The rendered plate used to be the hero band's backdrop and the page below it
 * was paper. The reference (hermes-agent.nousresearch.com, measured 2026-09-01)
 * runs one saturated ground under the whole page and drops a paper panel into
 * the middle of it, and that structure is what this page now has: the plate is
 * the ground of every section, the ledger panel is the paper.
 *
 * **Sticky, not fixed, and that is a load-bearing choice.** The scrolling layer
 * has to be opaque, because a fixed footer sits behind it waiting to be revealed
 * as a curtain when the content runs out. A fixed ground behind a transparent
 * scroll layer would show the curtain through every section. A sticky element
 * inside a track that covers the whole scroll layer stays pinned for the length
 * of that layer and then leaves with it, which is exactly the reveal.
 *
 * The track is an absolutely positioned wrapper rather than a negative bottom
 * margin on the sticky element itself. A sticky element's constraint is its
 * containing block minus its own margins, so `margin-bottom: -100dvh` let the
 * ground stay pinned one full viewport past the end of the content, exactly
 * over the curtain it was supposed to reveal. Found by scrolling to the end and
 * seeing the water where the footer should have been.
 *
 * What still moves is what a still frame cannot supply: the eight arms breathing
 * and the twelve motes rising. Both came over from the old hero unchanged. All
 * of it is decoration and `aria-hidden`.
 */

/** Fixed, not random: the same dots have to render on the server and the client. */
const MOTES = [
  { x: 12, y: 62, r: 2.4, o: 0.5, d: 0 },
  { x: 23, y: 34, r: 1.6, o: 0.35, d: -6 },
  { x: 31, y: 78, r: 3.1, o: 0.45, d: -11 },
  { x: 44, y: 22, r: 1.8, o: 0.28, d: -3 },
  { x: 52, y: 68, r: 2.2, o: 0.55, d: -14 },
  { x: 61, y: 41, r: 1.4, o: 0.3, d: -8 },
  { x: 69, y: 74, r: 2.8, o: 0.42, d: -2 },
  { x: 77, y: 29, r: 1.9, o: 0.33, d: -17 },
  { x: 85, y: 57, r: 2.5, o: 0.48, d: -5 },
  { x: 92, y: 37, r: 1.5, o: 0.26, d: -12 },
  { x: 7, y: 44, r: 1.7, o: 0.3, d: -9 },
  { x: 38, y: 52, r: 1.3, o: 0.24, d: -15 },
];

/**
 * Eight arms, as light. Each arc leaves the bloom below the frame at (800, 1000)
 * and sweeps up and out; the stroke gradient is vertical, so weight falls away
 * toward the tip and gives the taper an SVG stroke cannot.
 */
const ARMS = [
  'M800 1000C700 830 520 740 250 700',
  'M800 1000C745 845 630 715 425 630',
  'M800 1000C772 850 726 700 626 552',
  'M800 1000C792 855 788 690 768 505',
  'M800 1000C808 855 814 690 838 512',
  'M800 1000C830 848 884 706 990 566',
  'M800 1000C858 843 984 718 1188 640',
  'M800 1000C902 828 1086 742 1355 706',
];

export function Ground() {
  return (
    <div className="ground-track" aria-hidden="true">
      <div className="ground">
        {/* A plain <img>, not next/image: the three encodes are hand-tuned, the
          widest is 22 kB, and skipping the optimiser keeps `/` static. This is
          the LCP element, hence fetchpriority. */}
        <img
          className="gd-plate"
          src="/hero-deep-2560.webp"
          srcSet="/hero-deep-1024.webp 1024w, /hero-deep-1600.webp 1600w, /hero-deep-2560.webp 2560w"
          sizes="100vw"
          width={2560}
          height={1440}
          alt=""
          fetchPriority="high"
          decoding="async"
        />

        <svg
          className="gd-svg"
          viewBox="0 0 1600 900"
          preserveAspectRatio="xMidYMax slice"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="arm" x1="0" y1="1" x2="0" y2="0" gradientUnits="objectBoundingBox">
              <stop offset="0%" stopColor="#5fe3d4" stopOpacity="0.85" />
              <stop offset="35%" stopColor="#24c9b8" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#24c9b8" stopOpacity="0" />
            </linearGradient>
            <filter id="softer" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="7" />
            </filter>
          </defs>
          <g className="gd-arms" fill="none" stroke="url(#arm)" filter="url(#softer)">
            {ARMS.map((d, i) => (
              <path
                key={d}
                d={d}
                strokeWidth={i === 3 || i === 4 ? 3.4 : i === 0 || i === 7 ? 1.8 : 2.6}
                strokeLinecap="round"
                style={{ animationDelay: `${-i * 1.6}s` }}
              />
            ))}
          </g>
        </svg>

        <div className="gd-motes">
          {MOTES.map((m) => (
            <span
              key={`${m.x}-${m.y}`}
              style={{
                left: `${m.x}%`,
                top: `${m.y}%`,
                width: `${m.r * 2}px`,
                height: `${m.r * 2}px`,
                opacity: m.o,
                animationDelay: `${m.d}s`,
              }}
            />
          ))}
        </div>

        {/* Grain over the whole field, then a light scrim. Both measured: see the
          notes in landing.css under "Ground". */}
        <div className="gd-grain" />
        <div className="gd-scrim" />
      </div>
    </div>
  );
}
