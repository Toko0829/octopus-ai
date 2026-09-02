import Link from 'next/link';
import { GoalComposer } from './GoalComposer';

/**
 * The hero: the ask, centred over the water.
 *
 * The reference puts a three-line upper-case display headline in the left
 * column with an engraving in the right half of the viewport, and ours had
 * that for an afternoon: an octopus seen from below, which the owner called
 * creepy, and which was the literal creature brand.md has always said the mark
 * must not scale into. With the picture gone the copy sat beside half a
 * viewport of nothing, so the split went with it. The copy is centred over the
 * eight arms of light rising through the plate (Ground.tsx), which is where
 * the previous hero had it and is the metaphor carried by light.
 *
 * Two things kept from the previous version on purpose.
 *
 * - **The composer is the hero's one ask**, not a pair of buttons. The product
 *   is a thing you type into, so the page gives you the thing.
 * - **The disclaimer is in the hero**, under the composer, where mercury.com
 *   puts "not an FDIC-insured bank". A limit nobody scrolls to has not been
 *   disclosed (brand.md, AGENTS rule 19).
 */
export function HeroSplit() {
  return (
    <section className="hero" id="top">
      <div className="hero-copy">
        <p className="t-eyebrow eyebrow hero-eyebrow">
          Full-funnel marketing · expert humans in the loop
        </p>

        <h1 className="hero-h1">
          Octopus runs
          <br />
          your business.
          <br />
          <span className="quiet">You decide.</span>
        </h1>

        <p className="hero-lede">
          An AI that runs digital marketing end to end for solo founders and creators, and brings in
          a verified person only where judgment, taste, or the law requires one.
        </p>

        <div className="hero-ask">
          <p className="t-label hero-ask-label">Tell it what you are building</p>
          <GoalComposer id="hero-goal" />
        </div>

        <Link href="#ledger" className="t-label hero-secondary">
          See how it works
        </Link>

        <p className="hero-note">
          Octopus is informational. It is not a legal, tax, or financial advisor. Anything that
          spends money, publishes in your name, or needs a licence routes to you or to a verified
          person before it happens.
        </p>
      </div>
    </section>
  );
}
