import { OctopusMark } from '../brand/Logo';

/**
 * The product, in a frame: the chat shell with a finished plan in it.
 *
 * This is what `PlanTheatre` became. The theatre pinned for 220vh and let the
 * reader's scrolling write the plan a stage at a time, which needed
 * framer-motion (44 kB, flagged in the module doc from the day it landed) and
 * a scroll driver whose failure modes filled a page of comments. The reference
 * shows its product as one looping video in a frame, and the honest equivalent
 * for a product whose output is an interface is the interface, at rest, with
 * the one thing that is genuinely live still live: the agent's working pulse.
 *
 * So this is a Server Component with no state. The plan it shows is the same
 * finished plan the theatre defaulted to on every failure path, which was the
 * only frame anybody was guaranteed to see anyway.
 *
 * It is captioned as an illustration and `aria-hidden`, with a `.sr-only`
 * summary standing in for it.
 */

type Stage = {
  name: string;
  step: string;
  cite?: string;
  chips: { label: string; tone: 'owner' | 'human' | 'warn' }[];
};

const STAGES: Stage[] = [
  {
    name: 'Strategy',
    step: 'Define the audience and the one metric the first campaign is judged on.',
    cite: '[1] Positioning and ICP for a solo founder',
    chips: [{ label: 'AI', tone: 'owner' }],
  },
  {
    name: 'Channels',
    step: 'Open the ad account and set a daily cap before any spend is authorised.',
    cite: '[2] Controlling CPA on paid social',
    chips: [
      { label: 'You', tone: 'owner' },
      { label: 'Needs your approval', tone: 'warn' },
    ],
  },
  {
    name: 'Creative',
    step: 'Shoot the founder introduction the scripted ad depends on.',
    chips: [{ label: 'A person does this', tone: 'human' }],
  },
  {
    name: 'Measurement',
    step: 'No supported steps. The corpus held nothing in scope for this stage.',
    chips: [],
  },
];

export function ProductFrame() {
  return (
    <figure className="pf">
      <div className="th-frame" aria-hidden="true">
        <div className="th-bar">
          <span className="t-label th-chan"># paid-ads</span>
          <span className="th-bar-sep" />
          <span className="t-label th-topic">Ceramics studio · first campaign</span>
          <span className="th-bar-spacer" />
          <span className="t-label th-budget tnum">$0.00 / $250.00</span>
        </div>

        <div className="th-body">
          <div className="th-rail">
            <span className="th-guild th-guild-on" />
            <span className="th-guild" />
            <span className="th-guild" />
          </div>

          <div className="th-side">
            <span className="t-label th-side-head">Workstreams</span>
            <span className="th-chan-row th-chan-on"># paid-ads</span>
            <span className="th-chan-row"># content</span>
            <span className="th-chan-row"># creative</span>
            <span className="th-chan-row"># measurement</span>
          </div>

          <div className="th-stream">
            <div className="th-msg">
              <span className="th-avatar th-avatar-you">TK</span>
              <div className="th-msg-body">
                <span className="th-msg-head">
                  <b>You</b>
                  <span className="th-badge">You</span>
                </span>
                <p className="th-msg-text">
                  Launch a paid ads test for my ceramics studio, under 250 a month.
                </p>
              </div>
            </div>

            <div className="th-msg th-msg-agent">
              {/* The one sanctioned ambient motion: glow for a live agent. */}
              <span className="th-avatar th-avatar-agent is-working">
                <OctopusMark width={18} height={18} />
              </span>
              <div className="th-msg-body">
                <span className="th-msg-head">
                  <b>Octopus</b>
                  <span className="th-badge th-badge-agent">Agent</span>
                </span>
                <p className="th-msg-text">
                  Here is the plan. Six stages, grounded in 4 documents. Two steps need you before
                  anything runs.
                </p>
              </div>
            </div>

            <div className="th-card">
              <div className="th-card-bar t-label">Plan · pending your approval</div>
              <div className="th-card-body">
                {STAGES.map((s) => (
                  <div
                    className={`th-stage${s.chips.length === 0 ? ' is-empty' : ''}`}
                    key={s.name}
                  >
                    <span className="t-label th-stage-name">{s.name}</span>
                    <div className="th-stage-step">
                      {s.step}
                      {s.cite && <span className="th-stage-cite">{s.cite}</span>}
                      {s.chips.length > 0 && (
                        <span className="th-chips">
                          {s.chips.map((c) => (
                            <span className={`chip chip-${c.tone}`} key={c.label}>
                              {c.label}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <figcaption className="t-label pf-caption">
        An illustration of the workspace, drawn with the product&rsquo;s own tokens. The real
        planner, with its own citations, is in the app.
      </figcaption>

      <p className="sr-only">
        A goal is posted in a workstream channel. The agent returns a plan of six funnel stages.
        Each step names the document behind it, steps that spend or publish are marked as needing
        approval, and steps a person must perform are marked as such.
      </p>
    </figure>
  );
}
