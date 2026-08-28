'use client';

import { useState } from 'react';

/**
 * "A plan you can check. Not a plan you have to trust."
 *
 * This section used to hold a **static duplicate** of the card the theatre
 * already animates 700px above it: the same shape, not moving, saying the same
 * thing a second time. It is now the argument itself, operable.
 *
 * Two things the reader can do, and both of them are the section's actual claim
 * rather than decoration.
 *
 * **Open a citation.** The excerpt shown is REAL TEXT from the checked-in corpus
 * (`services/ai/corpus/*.md`), quoted verbatim, with the document's real title
 * and real source label. The one surface whose entire subject is "you can check
 * this" is the last place to paste in plausible-sounding filler.
 *
 * **Hide the unsupported stages.** Default on. Turning it off drops the two empty
 * stages and the header count falls from six to four, so the reader holds the
 * dishonest version of the same plan and can see why the empty ones are shown.
 * That is the section's argument put in their hands instead of asserted at them.
 *
 * **The invented date is gone.** The old sample rendered "read 12 Aug 2026" under
 * each citation while the module doc claimed, in the same breath, that "no cost,
 * date, or metric is invented". It was. These sources are internal playbooks
 * carrying `source_label: Octopus internal playbook` and no URL, so that is
 * exactly what the card shows. When the corpus's externally-sourced documents are
 * illustrated here they can carry a publisher and a genuine read date, because
 * those are real values on the row.
 *
 * Labelled an illustration, because the goal it plans for is one.
 */

type Chip = { label: string; tone: 'owner' | 'human' | 'warn' };

interface Stage {
  name: string;
  step?: string;
  chips?: Chip[];
  cite?: { ref: string; title: string; source: string; excerpt: string };
}

/** All six of `FunnelStage`, in order, because the real card always renders all six. */
const STAGES: Stage[] = [
  {
    name: 'Strategy',
    step: 'Define the audience and the one metric the first campaign is judged on.',
    chips: [{ label: 'AI', tone: 'owner' }],
    cite: {
      ref: '[1]',
      title: 'Positioning and ICP for a solo founder',
      source: 'Octopus internal playbook',
      excerpt:
        'Positioning decides who the product is for and why they should care. Every downstream activity inherits it: ads, content, landing pages, email.',
    },
  },
  { name: 'Content' },
  {
    name: 'Creative',
    step: 'Shoot the founder introduction the scripted ad depends on.',
    chips: [{ label: 'A person does this', tone: 'human' }],
    cite: {
      ref: '[2]',
      title: 'Creative direction and briefs for paid campaigns',
      source: 'Octopus internal playbook',
      excerpt:
        'On platforms with strong automated targeting, the system finds the audience and the creative decides whether the campaign works.',
    },
  },
  {
    name: 'Channels',
    step: 'Open the ad account and set a daily cap before any spend is authorised.',
    chips: [
      { label: 'You', tone: 'owner' },
      { label: 'Needs your approval', tone: 'warn' },
      { label: 'Uses an outside service', tone: 'warn' },
    ],
    cite: {
      ref: '[3]',
      title: 'Controlling CPA on paid social for early-stage products',
      source: 'Octopus internal playbook',
      excerpt:
        'Set a CPA ceiling before launch, derived from unit economics rather than from what feels affordable. Write the ceiling down; it becomes the guardrail that pauses the campaign automatically.',
    },
  },
  {
    name: 'Conversion',
    step: 'Rewrite the landing headline so it repeats the promise the ad made.',
    chips: [{ label: 'AI', tone: 'owner' }],
    cite: {
      ref: '[4]',
      title: 'Landing pages and conversion for early-stage traffic',
      source: 'Octopus internal playbook',
      excerpt:
        'The page has to continue the sentence the ad or the link started. The headline should echo the promise that earned the click, in recognisably the same words.',
    },
  },
  { name: 'Measurement' },
];

const EMPTY_LINE = 'No supported steps. The corpus held nothing in scope for this stage.';

export function CitationProof() {
  const [showUnsupported, setShowUnsupported] = useState(true);

  const visible = showUnsupported ? STAGES : STAGES.filter((s) => s.step);
  const supported = STAGES.filter((s) => s.step).length;

  return (
    <div className="proof">
      <figure className="sample">
        <figcaption className="sample-bar t-label">
          <span>Plan · pending your approval</span>
          <span className="sample-count tnum">
            {visible.length} stages · {supported} supported
          </span>
        </figcaption>

        <div className="sample-body">
          {visible.map((s) => {
            return (
              <div className={`stage${s.step ? '' : ' stage-empty'}`} key={s.name}>
                <span className="t-label stage-name">{s.name}</span>
                <div className="stage-step">
                  {s.step ?? EMPTY_LINE}

                  {/*
                    `<details>`, not a button with state.

                    A button that opens a panel needs JavaScript to do anything, and
                    this file's own repo rule is that an affordance which only fails
                    when used is worse than none. `<details>` discloses natively:
                    with no JS, a failed hydration or a dead client it still opens,
                    and it is keyboard operable for free. Losing "only one open at a
                    time" costs nothing; several open citations is arguably the
                    better reading anyway.
                  */}
                  {s.cite && (
                    <details className="cite" open={s.cite.ref === '[3]'}>
                      <summary className="stage-cite">
                        {s.cite.ref} {s.cite.title}
                        <span className="cite-more">Read source</span>
                      </summary>
                      <blockquote className="cite-open">
                        {s.cite.excerpt}
                        <cite>{s.cite.source}</cite>
                      </blockquote>
                    </details>
                  )}

                  {s.chips && (
                    <span className="chips">
                      {s.chips.map((c) => (
                        <span className={`chip chip-${c.tone}`} key={c.label}>
                          {c.label}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="sample-foot">
          <label className="proof-toggle">
            <input
              type="checkbox"
              checked={showUnsupported}
              onChange={(e) => setShowUnsupported(e.target.checked)}
            />
            <span>Show unsupported stages</span>
          </label>
          <span className="t-label proof-note">
            {showUnsupported
              ? 'Two stages had nothing behind them, and say so.'
              : 'Now it looks like a four stage plan that worked.'}
          </span>
        </div>
      </figure>

      <p className="sample-caption">
        An illustration of the plan card&rsquo;s structure. The quoted text is real, from the
        checked-in corpus. The real output, planning your goal rather than this one, is in the app.
      </p>
    </div>
  );
}
