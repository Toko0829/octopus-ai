import type { ReactNode } from 'react';

/**
 * The cinematic hero band.
 *
 * **The water is now a photograph, not a gradient.** `tools/art/hero-scene.py`
 * renders it in Cycles: a volume the camera sits inside, a sun broken into three
 * shafts by a gobo, red absorbed first so depth falls off to ink, and the
 * bioluminescent presence below the bottom edge so what reaches the frame is only
 * its scatter. Those are photographic properties, and the SVG that used to be here
 * was imitating every one of them with stacked linear gradients.
 *
 * The script is committed and the 16-bit master is not, for the reason
 * `rag-lens.html` is generated rather than stored: a binary in git can only ever go
 * stale. `pnpm art:hero` rebuilds the plate and its derivatives.
 *
 * **What stays SVG is what moves.** A still frame cannot drift, breathe or rise, so
 * the eight arms and the twelve motes are still drawn here and still animated, over
 * the photograph rather than instead of it. Everything the render now supplies is
 * gone from the markup: the water gradient, the surface glow, the bloom ellipse,
 * the three shaft polygons and the vignette.
 *
 * **No literal octopus.** Scaling a mark optimised for 13px up to 1100px gives a
 * large icon, not an image. The creature is eight arcs of light rising out of a
 * bloom, which is the metaphor (eight arms, parallel workstreams) carried by light.
 * They originate at (800, 1000) in the viewBox, which is where the rendered bloom
 * sits, so the drawn arms and the photographed glow share an origin.
 *
 * The band is `data-skin="dark"` and the page around it stays Light Editorial.
 *
 * Everything in `.hs-art` is decoration and `aria-hidden`. The copy is real DOM on
 * top of it.
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

export function HeroStage({ children, note }: { children: ReactNode; note: ReactNode }) {
  return (
    <section className="hero-stage" data-skin="dark">
      <div className="hs-art" aria-hidden="true">
        {/*
          A plain <img>, deliberately, rather than next/image. The three encodes are
          already hand-tuned and the widest is 22KB, which Next's optimiser cannot
          improve on, and going without it keeps `/` static with no image work at
          request time. `fetchpriority="high"` because this IS the LCP element, and
          width/height are set so the band reserves its box before the bytes land.
        */}
        <img
          className="hs-plate"
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
          className="hs-svg"
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

          <g className="hs-arms" fill="none" stroke="url(#arm)" filter="url(#softer)">
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

        {/* Motes drift up through the field. Twelve, large and soft: a starfield
            of forty small ones is the cheap version of this. */}
        <div className="hs-motes">
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

        {/* Grain last over the art. An 8-bit WebP of a field this smooth bands
            visibly, and this dithers it. It was already earning its place over the
            gradient; over a compressed photograph it is doing real work. */}
        <div className="hs-grain" />

        {/* The scrim is an accessibility control, not a mood layer. See hero.css. */}
        <div className="hs-scrim" />
      </div>

      <div className="wrap hs-copy">{children}</div>
      <p className="hs-note">{note}</p>
    </section>
  );
}
