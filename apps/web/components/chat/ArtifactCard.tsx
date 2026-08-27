'use client';

import type { ArtifactActionEmbed } from '@octopus/contracts';

/**
 * A deliverable the agent produced for one approved step.
 *
 * The gap this closes is the one that made the product look like it stopped: an
 * AI-owned step wrote a full artifact, title, body and sources, into a table only
 * a developer with SQL could reach. The person approved a plan, waited, and saw
 * nothing. Planning visibly and delivering invisibly is worse than doing neither.
 *
 * Three rules it holds, all of them the plan card's rules applied to work rather
 * than to a proposal.
 *
 * **An uncited deliverable is labelled, not merely styled the same.** Rule 10 says
 * uncited claims cannot gate action, so the card must never let one pass as
 * grounded. The label is text, never colour alone.
 *
 * **Nothing renders that the agent did not produce.** No invented dates, no
 * progress figures. This surface exists to be checked.
 *
 * **It reports rather than asks.** There is no approve button, because reviewing a
 * deliverable is a real decision that belongs with the marketplace's maker-checker.
 * A button that records a verdict nobody thought about is worse than no button.
 */

type Props = { embed: ArtifactActionEmbed };

export function ArtifactCard({ embed }: Props) {
  const { step, stage, title, body, citations } = embed.payload;
  const grounded = citations.length > 0;

  /**
   * Deduplicated, because citations are per CHUNK and a document usually
   * contributes several. Listing the label once per chunk showed one source
   * three times, which reads as three independent sources corroborating the
   * work: an overstatement of its support, on the one surface built for
   * checking that support.
   *
   * The plan card was corrected for exactly this and the artifact card was not,
   * which nobody could see because the card never rendered: `messages.ts` had no
   * `artifact` arm in its embed union, so every one of these was dropped on read.
   * Fixing that read path is what surfaced this.
   */
  const sources = [...new Set(citations)];

  return (
    <article className="artifact-card" aria-label={`Deliverable for ${step}`}>
      <header className="artifact-head">
        <p className="artifact-step">
          {stage ? <span className="artifact-stage">{stage}</span> : null}
          {step}
        </p>
        <h3 className="artifact-title">{title}</h3>
      </header>

      {/* Preserves the drafter's paragraphs. The body is prose the person will
          read and act on, and running it together would make it unusable. */}
      <div className="artifact-body">
        {body.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>

      <footer className="artifact-sources">
        {grounded ? (
          <>
            <span className="artifact-sources-label">Sources</span>
            <ul>
              {sources.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="artifact-unverified">
            No sources are cited for this, so treat it as unverified.
          </p>
        )}
      </footer>
    </article>
  );
}
