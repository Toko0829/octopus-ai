import { Reveal, Stagger, StaggerItem } from './motion';

/**
 * The human-nodes band: "Software cannot sign a lease. A person can."
 *
 * This section used to be a heading and one paragraph, three DOM nodes, holding a
 * full screen of height. It was the flattest thing on the page.
 *
 * **It is also the room `brand.md` has been waiting for.** That doc has carried an
 * open item since Phase 0: "a large editorial variant, where one arm extends out of
 * the silhouette to a coral node. That is the tentacles reaching out to human nodes
 * half of the metaphor, and it needs room a 24px grid does not have." 626px of
 * empty band is that room.
 *
 * **The picture is an argument, not a decoration.** A teal arm with no edges at all,
 * narrowing across the frame to one small solid coral point. The agent is diffuse
 * and everywhere; the person is one place. Teal means the agent and coral means
 * "a person does this" (design-system.md), so the image says what the heading says
 * using nothing but the two brand hues.
 *
 * The band is `data-skin="dark"` and paints its own ground, because `body` sits
 * outside it and still resolves from `:root`. It is a direct child of `<main>` and
 * already full width, so there is no `100vw` bleed: that trick counts the scrollbar
 * and overflowed this document by its width the last time it was used here.
 *
 * The four beats are the real mechanic from `core-loop.md` steps 7 to 9, not a
 * marketing sequence invented to fill a row.
 */

const BEATS = [
  {
    n: '01',
    label: 'The step is marked',
    line: 'While the plan is still a proposal, the steps a person has to do are labelled as theirs. You see them before you approve anything.',
  },
  {
    n: '02',
    label: 'Escrow is held',
    line: 'The scope and the price are agreed and the money is held before the work starts, so neither can quietly move afterwards.',
  },
  {
    n: '03',
    label: 'An expert is matched',
    line: 'Matched on skill, credential and jurisdiction, then admitted to that one task thread. Not to the rest of your project.',
  },
  {
    n: '04',
    label: 'The work comes back',
    line: 'You approve it, escrow releases, and the run picks up from the step it suspended on rather than starting again.',
  },
];

export function NodeReach() {
  return (
    <section className="reach" data-skin="dark">
      <div className="wrap reach-inner">
        <Reveal className="section-head">
          <p className="t-eyebrow eyebrow reach-eyebrow">Human nodes</p>
          <h2 className="t-title">Software cannot sign a lease. A person can.</h2>
          <p className="t-prose lede">
            Some work is closed to software by law, and some is closed to it by taste. Octopus
            routes those steps to a verified person, scoped to that one task and paid through
            escrow, and it tells you which steps those are while the plan is still a proposal.
          </p>
        </Reveal>

        <Stagger className="reach-beats">
          {BEATS.map((b) => (
            <StaggerItem key={b.n} className="reach-beat">
              <span className="t-label reach-beat-n">{b.n}</span>
              <b>{b.label}</b>
              <span>{b.line}</span>
            </StaggerItem>
          ))}
        </Stagger>
      </div>

      {/*
        After the copy in the DOM, deliberately. On desktop this is an absolutely
        positioned backdrop and source order is irrelevant, because z-index decides.
        On a phone it becomes a normal block, and flowing after the copy is the only
        order that reads: placed first it arrived as a 146px stripe above the
        heading, which is a 2.56:1 picture squeezed until the arm is a smudge.
      */}
      <div className="reach-art" aria-hidden="true">
        <Reveal className="reach-plate-wrap">
          <img
            className="reach-plate"
            src="/node-reach-2560.webp"
            srcSet="/node-reach-1024.webp 1024w, /node-reach-1600.webp 1600w, /node-reach-2560.webp 2560w"
            sizes="100vw"
            width={2560}
            height={1000}
            alt=""
            loading="lazy"
            decoding="async"
          />
        </Reveal>
        {/* Protects the copy column only. The arm and the node are on the right and
            the gradient has fallen to nothing by the time it reaches them. */}
        <div className="reach-scrim" />
      </div>
    </section>
  );
}
