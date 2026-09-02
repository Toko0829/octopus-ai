'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Lenis from 'lenis';

/**
 * Smooth scrolling, from `lenis`, which is what gives the reference its feel:
 * the page moves with inertia rather than in wheel steps, and the curtain
 * footer and the panel overlap read as one continuous motion.
 *
 * Three rules.
 *
 * - **Not under `prefers-reduced-motion`.** Inertial scrolling is motion the
 *   reader did not ask for; the setting says no, and the effect returns before
 *   constructing anything. Native scrolling is the complete page.
 * - **Nothing else knows it is here.** Lenis drives `window.scrollY`, so the
 *   reveal observers and the limit-card replay keep their native listeners and
 *   need no import. Removing this file removes the feel and nothing else.
 * - **Destroyed on unmount**, so a client-side navigation to `/app` does not
 *   leave a scroll controller attached to a page that is no longer there.
 */
export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const lenis = new Lenis({ autoRaf: true, lerp: 0.1 });
    return () => lenis.destroy();
  }, []);

  return <>{children}</>;
}
