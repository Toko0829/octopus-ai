'use client';

import { useState } from 'react';
import type { Limit } from './limits-data';

/**
 * One card in "Here is what it will not do." Four guarantees, each demonstrated.
 *
 * The module doc calls this section "the section a competitor cannot copy without
 * building it", and it was presented as four bullets prefixed with a middot: the
 * strongest argument on the page in its quietest possible form.
 *
 * Each card now shows the refusal happening. The attempt is struck through and a
 * mono verdict names the rule that stopped it.
 *
 * **Nothing here is hidden without `.js`.** The strip renders complete and
 * readable from the server; only the client-stamped `html.js` class introduces
 * the sequence, and `prefers-reduced-motion` gets the finished state. Same rule
 * the reveal machinery answers to, because the failure is silent: the markup is
 * all present and only the paint is missing.
 *
 * **The replay is the only reason this is a client component.** Re-running a
 * finished CSS animation is awkward, so the strip is keyed and the key increments
 * on pointer-enter and on focus: React remounts it and the animation restarts.
 * Ten lines, and it beats every pure-CSS approach to the same problem, all of
 * which also re-trigger on mouse-OUT.
 *
 * The data lives in `limits-data.tsx`, which is deliberately NOT a client module:
 * a Server Component importing a value from a `'use client'` file receives a
 * client reference rather than the value, and the array arrives as something with
 * no `.map`.
 */

export function LimitCard({ limit }: { limit: Limit }) {
  const [run, setRun] = useState(0);
  const replay = () => setRun((r) => r + 1);

  return (
    <li className="limit" onMouseEnter={replay} onFocus={replay} tabIndex={0}>
      <p>
        <b>{limit.claim}</b>
        <span>{limit.line}</span>
      </p>

      <div className="limit-demo" key={run} aria-hidden="true">
        <span className="ld-attempt">{limit.attempt}</span>
        <span className="ld-verdict">{limit.verdict}</span>
      </div>
    </li>
  );
}
