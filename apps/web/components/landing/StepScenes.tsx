import type { ReactNode } from 'react';

/**
 * Three micro-scenes for "You describe the outcome. It works out the steps."
 *
 * That section was fifteen DOM nodes of prose in three columns and 610px of
 * height, with no picture in it at all.
 *
 * **These stay drawn rather than rendered, on purpose.** The hero and the
 * human-nodes band are photographs because they are pictures of a place. These
 * are **diagrams**: they show a mechanism, and a diagram of a mechanism must
 * change when the mechanism does. A screenshot of a plan card goes stale the day
 * somebody edits the card; a drawing of "a citation attaches to a step" does not.
 *
 * **No new JavaScript.** Each scene animates off the `.reveal-group.is-in` class
 * the existing stagger already sets, using `stroke-dashoffset` and opacity. Under
 * no-JS, a dead observer or reduced motion, every one of them renders finished,
 * which is the hard rule in design-system.md: nothing the server renders may be
 * invisible.
 *
 * They are `aria-hidden`. The step's own heading and paragraph say the same
 * thing, so a screen reader is not made to sit through a diagram of a sentence.
 */

function Scene({ children }: { children: ReactNode }) {
  return (
    <svg
      className="scene"
      viewBox="0 0 200 116"
      fill="none"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

/**
 * 01 — a sentence resolves into a task graph.
 * Three text rules on the left collapse into three connected nodes.
 */
export function SceneGoal() {
  return (
    <Scene>
      <g className="sc-text">
        <rect x="6" y="30" width="58" height="4" rx="2" />
        <rect x="6" y="42" width="44" height="4" rx="2" />
        <rect x="6" y="54" width="52" height="4" rx="2" />
      </g>

      <g className="sc-edge">
        <path d="M104 44 L136 26" />
        <path d="M104 50 L136 58" />
        <path d="M136 58 L136 90" />
      </g>

      <g className="sc-node">
        <rect x="82" y="38" width="22" height="18" rx="3" />
        <rect x="136" y="16" width="46" height="18" rx="3" />
        <rect x="136" y="48" width="46" height="18" rx="3" />
        <rect x="136" y="80" width="46" height="18" rx="3" />
      </g>
    </Scene>
  );
}

/**
 * 02 — a citation attaches, and an uncited step is labelled rather than hidden.
 * The marker travels to the first row and locks; the second row takes a word.
 */
export function SceneCite() {
  return (
    <Scene>
      <g className="sc-node">
        <rect x="10" y="20" width="120" height="20" rx="3" />
        <rect x="10" y="52" width="120" height="20" rx="3" />
      </g>
      <g className="sc-text">
        <rect x="18" y="28" width="62" height="4" rx="2" />
        <rect x="18" y="60" width="48" height="4" rx="2" />
      </g>

      {/* the marker that flies in and locks onto the cited row */}
      <g className="sc-cite">
        <rect x="98" y="24" width="24" height="12" rx="2" />
        <rect x="103" y="29" width="14" height="2" rx="1" className="sc-cite-bar" />
      </g>

      {/* the uncited row is labelled, in a word, not merely styled the same */}
      <g className="sc-flag">
        <rect x="98" y="56" width="24" height="12" rx="2" />
        <rect x="102" y="61" width="16" height="2" rx="1" />
      </g>

      <g className="sc-edge">
        <path d="M138 30 L176 30" />
        <path d="M138 62 L176 62" />
      </g>
      <g className="sc-doc">
        <rect x="164" y="18" width="24" height="24" rx="3" />
        <rect x="164" y="50" width="24" height="24" rx="3" className="sc-doc-empty" />
      </g>
    </Scene>
  );
}

/**
 * 03 — the run proceeds and then stops at a gate.
 * Three steps fill along the track; the fourth is held behind a bar.
 */
export function SceneGate() {
  return (
    <Scene>
      <g className="sc-track">
        <path d="M14 58 L186 58" />
      </g>

      <g className="sc-done">
        <circle cx="28" cy="58" r="9" />
        <circle cx="62" cy="58" r="9" />
        <circle cx="96" cy="58" r="9" />
      </g>

      {/* the gate: the run reaches it and does not pass */}
      <g className="sc-gate">
        <path d="M126 26 L126 90" />
        <rect x="118" y="26" width="16" height="8" rx="2" />
      </g>

      <g className="sc-held">
        <circle cx="112" cy="58" r="9" />
      </g>

      <g className="sc-waiting">
        <rect x="146" y="49" width="40" height="18" rx="9" />
      </g>
    </Scene>
  );
}
