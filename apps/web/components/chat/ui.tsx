'use client';

import { useEffect, useState } from 'react';
import type { Role } from '../../lib/types';
import { IconCheck, IconMoon, IconSun } from './icons';

export function roleLabel(role: Role): string {
  return { you: 'You', agent: 'Agent', node: 'Node', pro: 'Verified', admin: 'Admin' }[role];
}

/** Role marker — always text label (+ icon for Verified), never color alone. */
export function RoleBadge({ role }: { role: Role }) {
  if (role === 'you') return null;
  return (
    <span className={`badge badge-${role}`}>
      {role === 'pro' && <IconCheck width={9} height={9} />}
      {roleLabel(role)}
    </span>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = (() => {
      try {
        return localStorage.getItem('oc-theme');
      } catch {
        return null;
      }
    })();
    const isDark = stored
      ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    setDark(isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    const el = document.documentElement;
    el.setAttribute('data-theme', next ? 'dark' : 'light');
    try {
      localStorage.setItem('oc-theme', next ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }

  return (
    <button className="icon-btn" onClick={toggle} aria-label="Toggle theme" title="Toggle theme">
      {dark ? <IconSun /> : <IconMoon />}
    </button>
  );
}
