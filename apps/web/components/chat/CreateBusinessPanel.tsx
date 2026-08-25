'use client';

import { useState } from 'react';
import { createRoom } from '../../lib/api-client';

/**
 * Adding a second workspace.
 *
 * The rail's `+` had no handler at all, and the only room-creation form lived in
 * the empty state, which stops rendering the moment you have one room. So a
 * person with one workspace had no way to make another and no way to find out
 * that was the case: a button that looks like an affordance and is not.
 *
 * Deliberately not `CreateRoom.tsx`. That component calls `router.refresh()`,
 * which re-runs the server page and hands the shell a new room list without
 * moving the selection, so the new workspace would appear in the rail and the
 * person would still be looking at the old one. Here the caller receives the
 * created room and selects it, which is what "add a business" is expected to do.
 */

interface Props {
  onClose: () => void;
  onCreated: (room: { id: string; name: string; ownerId: string | null }) => void;
}

export function CreateBusinessPanel({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give it a name.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const room = await createRoom(trimmed);
      onCreated({ id: room.id, name: room.name, ownerId: room.ownerId });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be created.');
      setBusy(false);
    }
  }

  return (
    <div className="cmdk-scrim" role="dialog" aria-modal="true" aria-label="Add a business">
      <form className="source-panel" onSubmit={submit}>
        <h2 className="source-title">Add a business</h2>
        <p className="source-lede">
          Each business is its own workspace, with its own plans and its own knowledge.
        </p>

        <label className="source-label" htmlFor="business-name">
          Name
        </label>
        <input
          id="business-name"
          className="source-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bluelly"
          maxLength={80}
          autoFocus
          disabled={busy}
        />

        {error && (
          <p className="source-error" role="alert">
            {error}
          </p>
        )}

        <div className="source-actions">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
