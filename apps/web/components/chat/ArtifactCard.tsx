'use client';

import { useEffect, useRef, useState } from 'react';
import type { ArtifactActionEmbed } from '@octopus/contracts';
import { imageCountLine, imageFilesOf } from '../../lib/artifact-files';
import { getArtifactFileUrl } from '../../lib/api-client';

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
   * The generated images, shown here rather than only counted.
   *
   * **This card used to print "1 image, in the project panel." and that was the
   * wrong call.** The reason recorded against it was that the stream re-renders
   * on every broadcast, so an inline image would mint a signed URL per artifact
   * per re-render. That is not how React works: messages are keyed by id, so a
   * broadcast re-renders the list without re-mounting a card, and an effect keyed
   * on the artifact runs once per mount. The argument was wrong and it was
   * written into an ADR and three module docs before anybody rendered a real
   * picture and asked why it was not there.
   *
   * The real cost is smaller and is handled below: opening a room with many
   * delivered images would mint many ten-minute credentials at once, for every
   * viewer, without anybody asking. `CardImage` fetches only once the card is
   * actually on screen.
   *
   * **And the argument the other way is the reason this card exists.** An
   * approved step used to write its work into a table only SQL could reach, which
   * read as the product having stopped. A picture you have to go and find in a
   * panel is that same defect, one size smaller.
   */
  const images = imageFilesOf(embed.payload);
  const projectId = embed.payload.projectId;

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

      {images.length > 0 &&
        (projectId ? (
          <div className="artifact-images">
            {images.map((file, i) => (
              <CardImage
                key={file.artifactId}
                projectId={projectId}
                artifactId={file.artifactId}
                alt={`${title}, image ${i + 1}`}
              />
            ))}
          </div>
        ) : (
          /* A card written before `projectId` was on the payload. There is no
             way to mint a link without it, so it says what it has rather than
             rendering a broken frame. */
          <p className="artifact-files">{imageCountLine(images.length)}</p>
        ))}

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

/**
 * One generated image, fetched when somebody can actually see it.
 *
 * **The link is minted on intersection, not on mount**, which is what keeps the
 * eager-credential cost the card's old copy worried about from being real. A room
 * with forty delivered images mints nothing when it opens; the one scrolled into
 * view mints one. `IntersectionObserver` is disconnected as soon as it fires, so
 * the fetch happens once per card per session however much the list re-renders.
 *
 * **A failure is a sentence, not an empty frame.** The bytes are stored either
 * way and the panel offers the same file, so a link that could not be prepared is
 * worth saying and not worth shouting about.
 */
function CardImage({
  projectId,
  artifactId,
  alt,
}: {
  projectId: string;
  artifactId: string;
  alt: string;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node || url) return;

    let live = true;
    const load = () => {
      getArtifactFileUrl(projectId, artifactId)
        .then((res) => {
          if (live) setUrl(res.url);
        })
        .catch(() => {
          if (live) setFailed(true);
        });
    };

    // Older browsers without the observer get the image rather than nothing:
    // degrading to eager is the same behaviour with a worse credential profile,
    // and degrading to blank would hide delivered work.
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => {
        live = false;
      };
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        load();
      }
    });
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [projectId, artifactId, url]);

  return (
    <div className="artifact-image-holder" ref={holder}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed URL on
        // Storage's own host, minted per card and expiring in minutes. The image
        // optimiser would proxy and cache it, which is a private object cached on
        // a public path.
        <img className="artifact-image" src={url} alt={alt} />
      ) : failed ? (
        <p className="artifact-files">
          This image could not be loaded. It is in the project panel.
        </p>
      ) : null}
    </div>
  );
}
