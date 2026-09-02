import { OctopusMark } from '../brand/Logo';
import { Engraving } from './Engraving';
import { LimitCard } from './LimitCard';
import { LIMITS } from './limits-data';
import { SceneCite, SceneGate, SceneGoal } from './StepScenes';
import { Stagger, StaggerItem, StaggerList } from './motion';

/**
 * The paper panel: the loop, written as a ledger.
 *
 * The reference's white panel is a poster grid of six features. Ours carries the
 * six beats of the core loop (core-loop.md), which is a real sequence, so the
 * `#1` … `#6` markers encode order rather than decorate it: tell, plan, run,
 * gate, hand off, learn. Each entry is an engraving, an upper-case display
 * heading, and a short mono paragraph.
 *
 * After the entries come the two things the previous page already demonstrated
 * rather than described, unchanged: the three drawn mechanisms (StepScenes,
 * which stay diagrams because a diagram must change when the mechanism does)
 * and the four refusals you can trip (LimitCard).
 *
 * The panel ends with the wordmark at ground scale, clipped by the panel edge,
 * which is the reference's closing move and the one bold thing on the page.
 *
 * **A subtree skin paints its own ground.** `data-skin="light"` declares the
 * tokens; `.ledger` sets background, color and color-scheme, because `body`
 * sits outside and still resolves from `:root`. This page has shipped that
 * defect once already.
 */

const ENTRIES = [
  {
    n: '#1',
    verb: 'Tell',
    title: 'One sentence to start',
    body: 'Tell it what you are building. Where something is missing it asks, rather than guessing and calling the guess a plan.',
    art: 'entry-tell',
  },
  {
    n: '#2',
    verb: 'Plan',
    title: 'A plan you can check',
    body: 'Six funnel stages, every step named against the document it was written from. A stage with nothing behind it is shown empty, in words.',
    art: 'entry-plan',
  },
  {
    n: '#3',
    verb: 'Run',
    title: 'It runs, and stops',
    body: 'Reversible work runs on its own. Anything that spends, publishes, or connects an account waits for you, and the plan says so first.',
    art: 'entry-run',
  },
  {
    n: '#4',
    verb: 'Gate',
    title: 'Your approval is the key',
    body: 'Spend caps, permissions and idempotency are checked in the code that runs the tools. A prompt can be talked out of a rule. A server cannot.',
    art: 'entry-gate',
  },
  {
    n: '#5',
    verb: 'Hand off',
    title: 'A person where the law needs one',
    body: 'Steps closed to software by law or by taste go to a verified expert, scoped to that one task, with the money held in escrow until you approve the work.',
    art: 'entry-node',
  },
  {
    n: '#6',
    verb: 'Learn',
    title: 'The receipts stay',
    body: 'Every approval, refusal and payout is written to one ledger, and every verdict you give is kept as labelled data the next plan is written from.',
    art: 'entry-learn',
  },
];

const STEPS = [
  {
    title: 'Tell it what you are building',
    body: 'One sentence is enough to start. Where something is missing, Octopus asks for it rather than filling the gap with a guess.',
    scene: <SceneGoal />,
  },
  {
    title: 'It returns a plan you can audit',
    body: 'Every step names the document it was written from, and you can open it. A step with nothing behind it is labelled unsupported, in words.',
    scene: <SceneCite />,
  },
  {
    title: 'It runs, and stops where it should',
    body: 'Reversible work runs on its own. Anything that spends, publishes, or connects an account waits for your approval.',
    scene: <SceneGate />,
  },
];

export function LedgerPanel() {
  return (
    <section className="ledger" id="ledger" data-skin="light">
      <div className="ledger-inner">
        <span className="ledger-badge" aria-hidden="true">
          <OctopusMark width={28} height={28} />
        </span>

        <header className="ledger-head">
          <p className="t-eyebrow eyebrow">The loop</p>
          <p className="t-label ledger-head-note">Six beats, in the order they happen</p>
        </header>

        <ol className="entries">
          {ENTRIES.map((e, i) => (
            <li className="entry" key={e.n} id={`entry-${i + 1}`}>
              <p className="t-eyebrow entry-n">
                {e.n} {e.verb}
              </p>
              <h2 className="entry-h2">{e.title}</h2>
              <Engraving name={e.art} tone="paper" width={1536} height={1024} />
              <p className="entry-body">{e.body}</p>
            </li>
          ))}
        </ol>

        <div className="ledger-how" id="how">
          <p className="t-eyebrow eyebrow">How it works</p>
          <h2 className="ledger-h2">You describe the outcome. It works out the steps.</h2>
          <Stagger className="steps">
            {STEPS.map((s) => (
              <StaggerItem className="step" key={s.title}>
                <div className="step-scene">{s.scene}</div>
                <h3 className="t-heading">{s.title}</h3>
                <p>{s.body}</p>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        <div className="ledger-limits" id="limits">
          <p className="t-eyebrow eyebrow">Guarantees</p>
          <h2 className="ledger-h2">Here is what it will not do.</h2>
          <p className="ledger-lede">
            These are enforced in the code that runs the tools, not requested in a prompt. Hover or
            focus a card to watch the refusal happen.
          </p>
          <StaggerList className="limits">
            {LIMITS.map((limit) => (
              <LimitCard limit={limit} key={limit.claim} />
            ))}
          </StaggerList>
        </div>
      </div>

      {/* The wordmark at ground scale, clipped by the panel. Decoration. */}
      <div className="ledger-ghost" aria-hidden="true">
        Octopus
      </div>
    </section>
  );
}
