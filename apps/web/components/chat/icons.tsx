import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = (p: P): P => ({
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  ...p,
});

/**
 * The mark lives in components/brand/Logo.tsx and is re-exported here so the
 * chat's existing imports keep working. One drawing, one place: the stylesheet
 * already learned this lesson when two copies of `.sr-only` drifted apart.
 */
export { OctopusMark } from '../brand/Logo';

export function IconHash(p: P) {
  return (
    <svg {...base(p)}>
      <line x1="4" y1="9" x2="20" y2="9" />
      <line x1="4" y1="15" x2="20" y2="15" />
      <line x1="10" y1="3" x2="8" y2="21" />
      <line x1="16" y1="3" x2="14" y2="21" />
    </svg>
  );
}

export function IconTopic(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 6h16M4 12h10M4 18h7" />
    </svg>
  );
}

export function IconSend(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M7 17L17 7M17 7H9M17 7v8" />
    </svg>
  );
}

export function IconSearch(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );
}

export function IconPlus(p: P) {
  return (
    <svg {...base(p)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconCheck(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function IconEdit(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.5V20z" />
    </svg>
  );
}

export function IconRefresh(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M20 11a8 8 0 1 0-1.5 5" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function IconSun(p: P) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

export function IconMoon(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    </svg>
  );
}

export function IconCommand(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M9 6a2.5 2.5 0 1 0-2.5 2.5H18a2.5 2.5 0 1 0-2.5-2.5v12A2.5 2.5 0 1 0 18 15.5H6A2.5 2.5 0 1 0 8.5 18z" />
    </svg>
  );
}

export function IconLink(p: P) {
  return (
    <svg {...base(p)}>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}
