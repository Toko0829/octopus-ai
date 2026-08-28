'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Scroll-reveal for the landing page.
 *
 * **The default state is visible, and that is the whole design of this file.**
 * The first attempt rendered `opacity: 0` on the server and relied on
 * IntersectionObserver to bring each section back. When the observer did not
 * deliver, every section below the hero stayed invisible: a marketing page that
 * renders blank is worse than one with no animation, and it fails silently
 * because the HTML is all there and only the paint is missing. Anything that
 * hides content must be added by the client, never shipped by the server.
 *
 * So the hiding is opt-in. `layout.tsx` stamps `js` on the root element before
 * paint; only under `html.js` does `.reveal` start hidden, and `.is-in` brings it
 * back. No JS, a failed hydration, and an observer that never fires all land on
 * the same safe result: the finished page.
 *
 * `prefers-reduced-motion` is handled in the same CSS, by declining to hide
 * anything at all rather than by hiding it and revealing it faster.
 */

/** Longest we will wait for an observer before showing the content anyway. */
const BACKSTOP_MS = 1000;

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;

    // No observer, no problem: show it and stop. The same branch a browser
    // without IntersectionObserver takes, and the same result.
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setSeen(true);
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);

    // Backstop. If the observer has said nothing after a second the page is very
    // likely not compositing at all (a background tab, a hidden pane, a headless
    // capture), and waiting longer only risks showing nothing.
    const t = setTimeout(() => setSeen(true), BACKSTOP_MS);

    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [seen]);

  return { ref, seen };
}

const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ');

export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, seen } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cx(className, 'reveal', seen && 'is-in')}
      style={delay ? { transitionDelay: `${Math.round(delay * 1000)}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * A group whose children arrive one after another. The stagger is 60ms per
 * child, set in CSS: long enough to read as a sequence, short enough that the
 * last item is not still arriving after the reader has looked at it.
 */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, seen } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={cx(className, 'reveal-group', seen && 'is-in')}>
      {children}
    </div>
  );
}

export function StaggerList({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, seen } = useReveal<HTMLUListElement>();
  return (
    <ul ref={ref} className={cx(className, 'reveal-group', seen && 'is-in')}>
      {children}
    </ul>
  );
}

/**
 * The items carry no behaviour: the group's `.is-in` drives them through CSS, so
 * a list of forty would still be one observer rather than forty.
 */
export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>;
}

export function StaggerListItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <li className={className}>{children}</li>;
}
