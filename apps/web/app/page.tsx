import Link from 'next/link';
import { FIRST_VERTICAL } from '@octopus/config';
import { OctopusMark } from '../components/brand/Logo';
import { CitationProof } from '../components/landing/CitationProof';
import { GoalComposer } from '../components/landing/GoalComposer';
import { HeroStage } from '../components/landing/HeroStage';
import { LimitCard } from '../components/landing/LimitCard';
import { LIMITS } from '../components/landing/limits-data';
import { NodeReach } from '../components/landing/NodeReach';
import { PlanTheatre } from '../components/landing/PlanTheatre';
import { SceneCite, SceneGate, SceneGoal } from '../components/landing/StepScenes';
import { Reveal, Stagger, StaggerItem, StaggerList } from '../components/landing/motion';
import './hero.css';
import './landing.css';

/**
 * Landing — editorial / calm minimal (design-system.md). The real product
 * surface is the Discord-style chat at /app.
 *
 * Every value comes from a token; the page carries no raw numbers. The plan in
 * the hero and the card below it are labelled as illustrations and are
 * structurally true to what the planner returns: the six stages of `FunnelStage`,
 * an owner, a risk tier, and a citation. **The quoted source text is real**, from
 * `services/ai/corpus`, because the one page whose subject is "you can check
 * this" is the last place to bluff.
 *
 * Each claim section demonstrates its claim rather than describing it. That is
 * the whole organising rule: the limits section shows the refusals happening, the
 * plan section lets you hide the unsupported stages and watch the plan flatter
 * itself, and the hero gives you the composer instead of a picture of one.
 *
 * The page stays a Server Component. Only the interactive pieces are client.
 */

const STEPS = [
  {
    n: '01',
    title: 'Tell it what you are building',
    body: 'One sentence is enough to start. Where something is missing, Octopus asks for it rather than filling the gap with a guess and calling it a plan.',
    scene: <SceneGoal />,
  },
  {
    n: '02',
    title: 'It returns a plan you can audit',
    body: 'Every step names the document it was written from, and you can open it. A step with nothing behind it is labelled unsupported, in words, not hidden.',
    scene: <SceneCite />,
  },
  {
    n: '03',
    title: 'It runs, and stops where it should',
    body: 'Reversible work runs on its own. Anything that spends, publishes, or connects an account waits for your approval, and the plan says so before you approve it.',
    scene: <SceneGate />,
  },
];

export default function Home() {
  return (
    <div className="page" data-skin="light">
      <header className="nav-shell" data-skin="dark">
        <div className="wrap nav">
          <Link href="/" className="wordmark" aria-label="Octopus, home">
            <OctopusMark width={20} height={20} className="wordmark-glyph" />
            <span>Octopus</span>
          </Link>
          <span className="nav-spacer" />
          <Link href="/sign-in" className="t-label nav-link">
            Sign in
          </Link>
          <Link href="/app" className="btn btn-quiet">
            Open the app
          </Link>
        </div>
      </header>

      <main>
        {/* ------------------------------------------------------ hero */}
        <HeroStage
          note={
            <>
              Octopus is informational. It is not a legal, tax, or financial advisor. Anything that
              spends money, publishes in your name, or needs a licence routes to you or to a
              verified person before it happens.
            </>
          }
        >
          <p className="t-eyebrow eyebrow">Full-funnel marketing</p>

          <h1 className="t-display">
            Octopus runs your business. <span className="quiet">You just decide.</span>
          </h1>

          <p className="t-prose lede">
            An AI that runs full-funnel digital marketing end to end for solo founders and creators,
            with expert humans dropped in only where judgment, taste, or access is required.
          </p>

          {/* The page's one ask, and the product's actual entry point. */}
          <GoalComposer id="hero-goal" />

          <Link href="#how" className="t-label hero-secondary">
            See how it works
          </Link>
        </HeroStage>

        {/* -------------------------------------------------- the workspace */}
        <section className="wrap section section-flush">
          <Reveal className="section-head">
            <p className="t-eyebrow eyebrow-quiet">The workspace</p>
            <h2 className="t-title">This is the room the work happens in.</h2>
            <p className="t-prose lede">
              One channel per workstream. The agent posts inline as a member of the room rather than
              from a bubble in the corner, and every plan it writes lands here for you to approve
              before anything runs.
            </p>
          </Reveal>
          <PlanTheatre />
        </section>

        {/* ------------------------------------------------- how it works */}
        <section className="wrap section" id="how">
          <Reveal className="section-head">
            <p className="t-eyebrow eyebrow-quiet">How it works</p>
            <h2 className="t-title">You describe the outcome. It works out the steps.</h2>
          </Reveal>

          <Stagger className="steps">
            {STEPS.map((s) => (
              <StaggerItem className="step" key={s.n}>
                <div className="step-scene">{s.scene}</div>
                <span className="t-label step-n">{s.n}</span>
                <h3 className="t-heading">{s.title}</h3>
                <p>{s.body}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </section>

        {/* ------------------------------------------------- the plan card */}
        <section className="wrap section">
          <div className="sample-grid">
            <Reveal className="section-head">
              <p className="t-eyebrow eyebrow-quiet">Grounding</p>
              <h2 className="t-title">A plan you can check. Not a plan you have to trust.</h2>
              <p className="t-prose lede">
                Octopus writes against a corpus rather than from memory, and shows its working. All
                six funnel stages are always listed, including the ones it could not support: a
                stage left empty tells you the corpus had nothing in scope, and that is information
                you need in order to judge the rest.
              </p>
              <p className="t-prose lede">
                Open a citation to read the passage the step came from. Or turn the empty stages off
                and see what the same plan looks like when it is allowed to flatter itself.
              </p>
            </Reveal>

            <Reveal delay={0.08}>
              <CitationProof />
            </Reveal>
          </div>
        </section>

        {/* ------------------------------------------------------ pull quote */}
        <section className="wrap pull">
          <Reveal>
            <blockquote className="t-title pull-quote">
              An uncited claim cannot authorise an action. It escalates to a person instead.
            </blockquote>
            <p className="t-label pull-src">Rule 10 · enforced in the planner, not in the prompt</p>
          </Reveal>
        </section>

        {/* --------------------------------------------------- human nodes */}
        <NodeReach />

        {/* -------------------------------------------------- what it won't */}
        <section className="wrap section">
          <Reveal className="section-head">
            <p className="t-eyebrow eyebrow-quiet">Guarantees</p>
            <h2 className="t-title">Here is what it will not do.</h2>
            <p className="t-prose lede">
              These are enforced in the code that runs the tools, not requested in a prompt. A
              prompt can be talked out of a rule. A spend cap checked server-side cannot.
            </p>
          </Reveal>

          <StaggerList className="limits">
            {LIMITS.map((limit) => (
              <LimitCard limit={limit} key={limit.claim} />
            ))}
          </StaggerList>
        </section>

        {/* ------------------------------------------------------- closing */}
        <section className="wrap close">
          <Reveal>
            <h2 className="t-title">Tell it what you want to build.</h2>
            <GoalComposer id="close-goal" />
            <div className="cta-row close-meta">
              <span className="t-label chip chip-owner">Phase 1 · planner preview</span>
              <span className="t-label quiet-label">first vertical: {FIRST_VERTICAL}</span>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="wrap foot">
        <span className="t-label foot-brand">
          <OctopusMark width={14} height={14} />
          Octopus
        </span>
        <Link href="/app" className="t-label">
          Open the app
        </Link>
        <Link href="/sign-in" className="t-label">
          Sign in
        </Link>
        <p className="t-label foot-note">
          Octopus is informational and is not a legal, tax, or financial advisor. Regulated steps
          route to a licensed human, and every claim that gates one carries its source and the date
          that source was read.
        </p>
      </footer>
    </div>
  );
}
