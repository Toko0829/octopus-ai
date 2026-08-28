'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { OctopusMark } from '../brand/Logo';

/**
 * The hero visual: the product doing the thing the page claims it does.
 *
 * A miniature of the real chat shell, drawn with the same tokens, running the
 * loop the landing describes: a goal is posted, the agent works, a grounded plan
 * assembles a stage at a time, and one step is marked as a person's. For a tool
 * whose output IS an interface, the most credible image available is the
 * interface, and it cannot go stale against the product.
 *
 * **It is scroll-scrubbed now, not timed.** It used to be a loop that played at
 * you regardless of what you were doing, which is a video, not a demonstration.
 * The section is over-tall, the frame pins to the top of it, and the reader's own
 * scrolling drives the plan being written. The reference does exactly this with a
 * video of its own app; ours needs no video because the interface is the asset.
 *
 * **The failure direction is REVERSED from the timed version, deliberately.** The
 * old loop opened on phase 1, because an observer that never fired would
 * otherwise park it on an empty frame. A scrubbed one must default to the
 * FINISHED plan: no JavaScript, a failed hydration and a dead scroll listener all
 * have to land on a complete, readable plan rather than on the first frame of a
 * sequence nobody can advance. `phase` therefore starts at `LAST`.
 *
 * **Below 900px the pin is dropped entirely** and the original timed loop runs
 * unchanged. Pinning 220vh on a phone is worse than the thing it replaces, and
 * the timed version is already responsive and already correct.
 *
 * **`prefers-reduced-motion` gets the finished state**, not a faster loop: the
 * destination is a complete plan, which is the whole content.
 *
 * Progress is computed from the wrapper's own rect rather than with Framer's
 * `useScroll`. It always yields a value on the first call, so there is no "did
 * the driver ever report" ambiguity to write a backstop for, and it keeps Framer
 * off a code path that does not need it. Framer already costs this page 44 kB.
 *
 * It stays `aria-hidden` with a `.sr-only` summary: a screen reader should not
 * have to scrub through a staged conversation to get past the page.
 */

/** ms spent in each phase by the mobile/timed fallback. The index IS the phase. */
const PHASE_MS = [
  500, // 0  empty frame
  900, // 1  the goal is posted
  1100, // 2  agent picks it up, reading
  1100, // 3  checking scope
  1000, // 4  writing
  500, // 5  agent resolves, pulse off
  500, // 6  card frame
  600, // 7  stage 1
  600, // 8  stage 2
  600, // 9  stage 3
  4200, // 10 stage 4, then hold and loop
];
const LAST = PHASE_MS.length - 1;
/** Phase 0 is the blank clear at the end of the loop; scrubbing never shows it. */
const FIRST_SCRUB = 1;

const WORKING = ['Reading the corpus', 'Checking what applies here', 'Writing the plan'];

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

const rise = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0, 0, 0.2, 1] as const },
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function PlanTheatre() {
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<HTMLElement>(null);

  // Starts finished. See the header: for a scrubbed sequence this is the only
  // safe default, because every way the driver can fail ends here.
  const [phase, setPhase] = useState(LAST);
  const [pinned, setPinned] = useState(false);
  const [offscreen, setOffscreen] = useState(false);

  // Pin only where a pin makes sense. Resolved on the client, so the server
  // renders the unpinned, finished markup.
  useEffect(() => {
    if (reduced) return;
    const mq = window.matchMedia('(min-width: 901px)');
    const apply = () => setPinned(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    // Belt and braces. `change` is the correct API and fires on a real resize or
    // an orientation flip, but it did NOT fire under the preview pane's viewport
    // emulation, which left the pin stale at the width it hydrated with. A plain
    // resize listener costs nothing and closes the case where it does not arrive.
    window.addEventListener('resize', apply);
    return () => {
      mq.removeEventListener('change', apply);
      window.removeEventListener('resize', apply);
    };
  }, [reduced]);

  const readScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const travel = rect.height - window.innerHeight;
    if (travel <= 0) return;
    const progress = clamp(-rect.top / travel, 0, 1);
    setPhase(FIRST_SCRUB + Math.round(progress * (LAST - FIRST_SCRUB)));
  }, []);

  useEffect(() => {
    if (!pinned || reduced) return;

    // Read straight off the event, with NO requestAnimationFrame throttle.
    //
    // The throttle was there first and it is a permanent-death pattern: it sets a
    // pending-frame flag, ignores every scroll while the flag is set, and only
    // clears the flag inside the rAF callback. Drop one callback and the handler
    // is dead for the rest of the page's life. That is not hypothetical, it is
    // how this was found: rAF does not fire while a tab is not compositing, so
    // the very first scroll armed the flag and nothing ever advanced again.
    //
    // The work being throttled is one `getBoundingClientRect` and a `setState`
    // that usually computes the same phase it already had, which React drops. A
    // passive listener doing that per scroll event is cheaper than the bug.
    readScroll(); // a value immediately, so there is nothing to back-stop
    window.addEventListener('scroll', readScroll, { passive: true });
    window.addEventListener('resize', readScroll);
    return () => {
      window.removeEventListener('scroll', readScroll);
      window.removeEventListener('resize', readScroll);
    };
  }, [pinned, reduced, readScroll]);

  // Only a positive report of "off screen" pauses the timed fallback: an observer
  // that never delivers is the case that broke the first version of this page.
  useEffect(() => {
    const el = figureRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e) setOffscreen(!e.isIntersecting);
      },
      { rootMargin: '0px 0px -80px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The timed loop is the narrow-viewport path only. When pinned, scroll drives.
  useEffect(() => {
    if (reduced || pinned || offscreen) return;
    const id = setTimeout(() => setPhase((p) => (p >= LAST ? 0 : p + 1)), PHASE_MS[phase]);
    return () => clearTimeout(id);
  }, [phase, offscreen, reduced, pinned]);

  const p = reduced ? LAST : phase;
  const working = p >= 2 && p <= 4;
  const workingLine = WORKING[Math.min(p - 2, WORKING.length - 1)] ?? WORKING[0];
  const shownStages = Math.max(0, Math.min(STAGES.length, p - 6));

  return (
    <div className={`theatre-scroll${pinned ? ' is-pinned' : ''}`} ref={scrollRef}>
      <figure className="theatre" ref={figureRef}>
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
              <AnimatePresence>
                {p >= 1 && (
                  <motion.div className="th-msg" key="you" {...rise}>
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
                  </motion.div>
                )}

                {p >= 2 && (
                  <motion.div className="th-msg th-msg-agent" key="agent" {...rise}>
                    <span className={`th-avatar th-avatar-agent${working ? ' is-working' : ''}`}>
                      <OctopusMark width={18} height={18} />
                    </span>
                    <div className="th-msg-body">
                      <span className="th-msg-head">
                        <b>Octopus</b>
                        <span className="th-badge th-badge-agent">Agent</span>
                      </span>

                      {working ? (
                        <span className="th-working">
                          <AnimatePresence mode="wait">
                            <motion.span
                              key={workingLine}
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -6 }}
                              transition={{ duration: 0.2 }}
                            >
                              {workingLine}
                            </motion.span>
                          </AnimatePresence>
                          <span className="th-dots" />
                        </span>
                      ) : (
                        <p className="th-msg-text">
                          Here is the plan. Six stages, grounded in 4 documents. Two steps need you
                          before anything runs.
                        </p>
                      )}
                    </div>
                  </motion.div>
                )}

                {p >= 6 && (
                  <motion.div className="th-card" key="card" {...rise}>
                    <div className="th-card-bar t-label">Plan · pending your approval</div>
                    <div className="th-card-body">
                      {STAGES.slice(0, shownStages).map((s, i) => (
                        <motion.div
                          className={`th-stage${s.chips.length === 0 ? ' is-empty' : ''}`}
                          key={s.name}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.28, ease: [0, 0, 0.2, 1] }}
                        >
                          <span className="t-label th-stage-name">{s.name}</span>
                          <div className="th-stage-step">
                            {s.step}
                            {s.cite && (
                              <motion.span
                                className="th-stage-cite"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.25, delay: reduced ? 0 : 0.18 }}
                              >
                                {s.cite}
                              </motion.span>
                            )}
                            {s.chips.length > 0 && (
                              <span className="th-chips">
                                {s.chips.map((c, j) => (
                                  <motion.span
                                    className={`chip chip-${c.tone}`}
                                    key={c.label}
                                    initial={{ opacity: 0, scale: 0.92 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    transition={{
                                      duration: 0.22,
                                      delay: reduced ? 0 : 0.28 + j * 0.06,
                                      ease: [0, 0, 0.2, 1],
                                    }}
                                  >
                                    {c.label}
                                  </motion.span>
                                ))}
                              </span>
                            )}
                          </div>
                          <span className="sr-only">{i + 1}</span>
                        </motion.div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Ticks, so a pinned section does not read as a stuck page. One per stage,
            lit as its stage lands. Decoration: the stream beside them is the state. */}
        {pinned && (
          <div className="th-ticks" aria-hidden="true">
            {STAGES.map((s, i) => (
              <span key={s.name} className={`th-tick${shownStages > i ? ' is-on' : ''}`} />
            ))}
          </div>
        )}

        <figcaption className="theatre-caption">
          An illustration of the workspace, drawn with the product&rsquo;s own tokens.
          {pinned ? ' Scroll to watch the plan being written.' : ''} The real planner, with its own
          citations, is in the app.
        </figcaption>

        <p className="sr-only">
          A goal is posted in a workstream channel. The agent reads the corpus, checks what applies,
          and returns a plan of six funnel stages. Each step names the document behind it, steps
          that spend or publish are marked as needing approval, and steps a person must perform are
          marked as such.
        </p>
      </figure>
    </div>
  );
}
