'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createRoom } from '../../lib/api-client';

/**
 * Bootstraps the first room. In the finished loop the orchestrator creates one
 * when a goal is posted (docs/00-overview/core-loop.md step 3); until that exists,
 * this is the explicit `POST /rooms` the same doc allows for.
 */
export function CreateRoom() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await createRoom(trimmed);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the workspace.');
      setBusy(false);
    }
  }

  return (
    <form className="empty-form" onSubmit={submit}>
      <label className="auth-label" htmlFor="room-name">
        Name your first workspace
      </label>
      <div className="empty-row">
        <input
          id="room-name"
          className="auth-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rune"
          maxLength={80}
          required
        />
        <button className="auth-submit empty-submit" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating...' : 'Create'}
        </button>
      </div>
      {error && (
        <div className="auth-msg" data-tone="error" role="status">
          Problem: {error}
        </div>
      )}
    </form>
  );
}
