'use client';

import { useEffect, useState } from 'react';
import { IconCommand } from './icons';

const ACTIONS = [
  { id: 'new-goal', label: 'New growth goal', k: 'G' },
  { id: 'approve', label: 'Approve current plan', k: 'A' },
  { id: 'invite', label: 'Invite a human node', k: 'N' },
  { id: 'connect', label: 'Connect an ad account', k: 'C' },
  { id: 'jump', label: 'Jump to channel…', k: 'J' },
  { id: 'theme', label: 'Toggle theme', k: 'T' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onAction: (label: string) => void;
}

export function CommandPalette({ open, onClose, onAction }: Props) {
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  if (!open) return null;

  const items = ACTIONS.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="cmdk-scrim" onClick={onClose}>
      <div
        className="cmdk"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          autoFocus
          className="cmdk-input"
          placeholder="Type a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && items[0]) onAction(items[0].label);
          }}
        />
        <div className="cmdk-list">
          {items.map((a) => (
            <button key={a.id} className="cmdk-item" onClick={() => onAction(a.label)}>
              <IconCommand width={15} height={15} />
              {a.label}
              <span className="k">{a.k}</span>
            </button>
          ))}
          {items.length === 0 && (
            <div style={{ padding: 12, color: 'var(--text-faint)', fontSize: 'var(--text-sm)' }}>
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
