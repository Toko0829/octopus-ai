'use client';

import { useEffect, useState } from 'react';
import type { UiChannel } from '../../lib/types';
import { IconCommand, IconHash } from './icons';

interface Props {
  open: boolean;
  channels: UiChannel[];
  onClose: () => void;
  onJump: (channelId: string) => void;
  onNotify: (text: string) => void;
}

/**
 * ⌘K actions. Only actions that actually do something are listed. Approve-plan,
 * invite-a-node and connect-an-ad-account belong here per the design spec, but
 * they arrive with the orchestrator and marketplace in Phase 2, and a palette
 * entry that silently does nothing is worse than its absence.
 */
export function CommandPalette({ open, channels, onClose, onJump, onNotify }: Props) {
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  if (!open) return null;

  const needle = q.trim().toLowerCase();
  const matches = channels.filter((c) => c.name.toLowerCase().includes(needle));

  function toggleTheme() {
    const el = document.documentElement;
    const next = el.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', next);
    try {
      localStorage.setItem('oc-theme', next);
    } catch {
      /* storage unavailable; the toggle still applies for this session */
    }
    onNotify(`Switched to ${next} theme`);
    onClose();
  }

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
          placeholder="Jump to a channel..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && matches[0]) onJump(matches[0].id);
          }}
        />
        <div className="cmdk-list">
          {matches.map((c) => (
            <button key={c.id} className="cmdk-item" onClick={() => onJump(c.id)}>
              <IconHash width={15} height={15} />
              {c.name}
            </button>
          ))}
          <button className="cmdk-item" onClick={toggleTheme}>
            <IconCommand width={15} height={15} />
            Toggle theme
            <span className="k">T</span>
          </button>
          {matches.length === 0 && needle.length > 0 && (
            <div className="cmdk-none">No channel matches “{q}”</div>
          )}
        </div>
      </div>
    </div>
  );
}
