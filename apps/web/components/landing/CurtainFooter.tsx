import Link from 'next/link';
import { FIRST_VERTICAL } from '@octopus/config';
import { OctopusMark } from '../brand/Logo';
import { GoalComposer } from './GoalComposer';

/**
 * The footer, as a curtain.
 *
 * It is `position: fixed` behind the scrolling content, and the content carries a
 * bottom margin of one viewport, so when the reader reaches the end the page
 * appears to lift off it. The reference does this with its "Nous Portal" close;
 * ours closes on the page's one ask, repeated, and on the human-nodes render
 * that used to be a band in the middle of the page: the arm of light narrowing
 * to a single coral node, which is the "a person does this" half of the brand.
 *
 * Below 900px it is a normal block at the end of the document. A fixed 100dvh
 * footer on a phone is a known trap (address-bar resizing, iOS painting) and the
 * curtain is not worth it there.
 */
export function CurtainFooter() {
  return (
    <footer className="curtain" id="close">
      <div className="curtain-art" aria-hidden="true">
        <img
          className="curtain-plate"
          src="/node-reach-2560.webp"
          srcSet="/node-reach-1024.webp 1024w, /node-reach-1600.webp 1600w, /node-reach-2560.webp 2560w"
          sizes="100vw"
          width={2560}
          height={1000}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <div className="curtain-scrim" />
        <div className="curtain-ghost">Octopus</div>
      </div>

      <div className="curtain-inner">
        <p className="t-eyebrow eyebrow curtain-eyebrow">
          Tell · plan · run · gate · hand off · learn
        </p>
        <h2 className="curtain-h2">Tell it what you want to build.</h2>
        <p className="curtain-lede">
          One sentence. The plan comes back with its sources, and nothing runs until you say so.
        </p>
        <GoalComposer id="close-goal" />
      </div>

      <div className="curtain-meta">
        <span className="t-label curtain-brand">
          <OctopusMark width={14} height={14} />
          Octopus · Phase 1 · planner preview · first vertical: {FIRST_VERTICAL}
        </span>
        <span className="curtain-links">
          <Link href="/app" className="t-label">
            Open the app
          </Link>
          <Link href="/sign-in" className="t-label">
            Sign in
          </Link>
        </span>
        <p className="t-label curtain-note">
          Octopus is informational and is not a legal, tax, or financial advisor. Regulated steps
          route to a licensed human, and every claim that gates one carries its source.
        </p>
      </div>
    </footer>
  );
}
