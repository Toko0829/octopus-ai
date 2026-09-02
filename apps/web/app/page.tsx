import Link from 'next/link';
import { OctopusMark } from '../components/brand/Logo';
import { CitationProof } from '../components/landing/CitationProof';
import { CurtainFooter } from '../components/landing/CurtainFooter';
import { Engraving } from '../components/landing/Engraving';
import { Frame } from '../components/landing/Frame';
import { Ground } from '../components/landing/Ground';
import { HeroSplit } from '../components/landing/HeroSplit';
import { LedgerPanel } from '../components/landing/LedgerPanel';
import { ProductFrame } from '../components/landing/ProductFrame';
import { SmoothScroll } from '../components/landing/SmoothScroll';
import './landing.css';

/**
 * Landing. The reference is hermes-agent.nousresearch.com, measured on computed
 * values on 2026-09-01 and recorded in design-system-frontend.md; its structure
 * in our palette, our copy and our subjects.
 *
 * The page is four layers, back to front:
 *
 *   .curtain    fixed, the footer, revealed when the content runs out
 *   .hw-scroll  the content, opaque, one viewport of bottom margin
 *     .ground   sticky inside it: the water plate, the arms, the motes
 *     sections  nav, hero, preview, surfaces, the paper ledger panel
 *   .frame      fixed, the ink border around the viewport
 *
 * Every claim section still demonstrates its claim: the composer is real, the
 * plan card is operable, the refusals animate. Nothing here is a screenshot.
 *
 * The page stays a Server Component. Only the composer, the plan proof, the
 * limit cards, the reveal groups and the scroll controller are client.
 */

const SURFACES = [
  {
    n: 'The room',
    title: 'Where the work happens',
    body: 'One channel per workstream. The agent posts inline as a member, never from a bubble in the corner.',
    art: 'surface-room',
    href: '/app',
    cta: 'Open the app',
  },
  {
    n: 'The plan',
    title: 'What you approve',
    body: 'Six stages, cited, with the empty ones left visible. Approving it is what creates the work.',
    art: 'surface-plan',
    href: '#preview',
    cta: 'Read a plan',
  },
  {
    n: 'The thread',
    title: 'Where a person steps in',
    body: 'A verified expert admitted to one task, paid through escrow, and rated when the work comes back.',
    art: 'surface-node',
    href: '#entry-5',
    cta: 'How hand-off works',
  },
];

export default function Home() {
  return (
    <div className="page hw" data-skin="dark">
      <CurtainFooter />
      <Frame />

      <SmoothScroll>
        <div className="hw-scroll">
          <Ground />

          <header className="nav">
            <nav className="nav-left" aria-label="Sections">
              <Link href="#ledger" className="nav-link">
                How it works
              </Link>
              <Link href="#limits" className="nav-link">
                Guarantees
              </Link>
            </nav>
            <Link href="/" className="wordmark" aria-label="Octopus, home">
              <OctopusMark width={22} height={22} className="wordmark-glyph" />
              <span>Octopus</span>
            </Link>
            <div className="nav-right">
              <Link href="/sign-in" className="nav-link">
                Sign in
              </Link>
              <Link href="/app" className="btn btn-primary">
                Open the app
              </Link>
            </div>
          </header>

          <main>
            <HeroSplit />

            {/* ------------------------------------------ the product, framed */}
            <section className="preview" id="preview">
              <div className="preview-head">
                <p className="t-eyebrow eyebrow">The workspace</p>
                <h2 className="h2-display">This is the room the work happens in.</h2>
              </div>
              <ProductFrame />

              <div className="proof-row">
                <div className="proof-copy">
                  <p className="t-eyebrow eyebrow">Grounding</p>
                  <h2 className="h2-display">A plan you can check. Not one you have to trust.</h2>
                  <p className="proof-lede">
                    Octopus writes against a corpus rather than from memory, and shows its working.
                    All six funnel stages are always listed, including the ones it could not
                    support. Open a citation to read the passage the step came from, or turn the
                    empty stages off and see what the same plan looks like when it is allowed to
                    flatter itself.
                  </p>
                </div>
                <CitationProof />
              </div>
            </section>

            {/* ------------------------------------------------- three surfaces */}
            <section className="surfaces" id="surfaces">
              <p className="t-eyebrow eyebrow surfaces-eyebrow">Three surfaces</p>
              <h2 className="h2-display surfaces-h2">One room, one plan, one thread per expert.</h2>
              <ul className="surface-grid">
                {SURFACES.map((s) => (
                  <li className="surface" key={s.n}>
                    <Engraving
                      name={s.art}
                      tone="ink"
                      width={1536}
                      height={1024}
                      className="surface-art"
                    />
                    <p className="t-eyebrow surface-n">{s.n}</p>
                    <h3 className="surface-h3">{s.title}</h3>
                    <p className="surface-body">{s.body}</p>
                    <Link href={s.href} className="btn">
                      {s.cta}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>

            <LedgerPanel />
          </main>
        </div>
      </SmoothScroll>
    </div>
  );
}
