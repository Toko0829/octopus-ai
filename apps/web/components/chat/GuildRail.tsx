import type { CSSProperties } from 'react';
import type { Business } from '../../lib/types';
import { OctopusMark, IconPlus } from './icons';

interface Props {
  businesses: Business[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function GuildRail({ businesses, activeId, onSelect }: Props) {
  return (
    <nav className="rail" aria-label="Your businesses">
      <div className="rail-home" title="Octopus">
        <OctopusMark width={26} height={26} />
      </div>
      <div className="rail-sep" />
      {businesses.map((b) => (
        <button
          key={b.id}
          className={`guild${b.id === activeId ? ' active' : ''}`}
          style={{ '--guild-accent': b.accent } as CSSProperties}
          onClick={() => onSelect(b.id)}
          title={b.name}
          aria-label={b.name}
          aria-current={b.id === activeId}
        >
          {b.mark}
        </button>
      ))}
      <button className="rail-add" aria-label="Add business" title="Add business">
        <IconPlus width={18} height={18} />
      </button>
    </nav>
  );
}
