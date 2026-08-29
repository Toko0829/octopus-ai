'use client';

import { useEffect, useRef, useState } from 'react';
import { completeConnection } from '../../../lib/api-client';

/**
 * Hand what the platform returned to the API, and say what happened.
 *
 * **The room comes out of the unverified state, and that is safe for one
 * reason.** The redirect URI is a single fixed address with no room in it, so
 * this page has to get one from somewhere, and the only thing it has is the
 * state. It reads the room id out without checking a signature, then posts to
 * that room's callback, where `verifyState` refuses unless the *signed* payload
 * names the same room. So a tampered room id does not select a different
 * workspace, it fails a comparison. Nothing here is trusted; it only decides
 * which door to knock on.
 *
 * **It runs exactly once.** A ref rather than a state flag, because React's
 * development StrictMode deliberately double-invokes effects, and an
 * authorisation code is single-use: the second exchange would fail at the
 * provider and report an error over a connection that had just succeeded.
 */
export function ConnectionCallback({
  state,
  code,
  error,
}: {
  state: string;
  code?: string;
  error?: string;
}) {
  const [status, setStatus] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const roomId = roomFromUnverifiedState(state);
    if (!roomId) {
      setStatus('failed');
      setMessage('That authorisation link is unreadable. Start connecting the account again.');
      return;
    }

    completeConnection(roomId, { state, code, error })
      .then(() => {
        setStatus('done');
        setMessage(null);
      })
      .catch((err: unknown) => {
        setStatus('failed');
        setMessage(err instanceof Error ? err.message : 'That account was not connected.');
      });
  }, [state, code, error]);

  return (
    <main className="consent" data-skin="light">
      {status === 'working' && (
        <>
          <h1 className="consent-title">Finishing the connection</h1>
          <p className="consent-body">One moment.</p>
        </>
      )}

      {status === 'done' && (
        <>
          <h1 className="consent-title">Account connected</h1>
          {/* Says what did not happen as plainly as what did, matching the
              campaign card. Connecting an account grants access; it does not
              start using it, and somebody who has just authorised something
              reasonably wants to know which. */}
          <p className="consent-body">
            Nothing is published or spent. Octopus will ask you before anything uses this
            connection.
          </p>
          <a className="btn btn-primary" href="/app">
            Back to the workspace
          </a>
        </>
      )}

      {status === 'failed' && (
        <>
          <h1 className="consent-title">That account was not connected</h1>
          <p className="consent-body">{message}</p>
          <a className="btn btn-ghost" href="/app">
            Back to the workspace
          </a>
        </>
      )}
    </main>
  );
}

/**
 * The room id out of an unverified state, for routing only.
 *
 * Deliberately not exported and deliberately named `unverified` at its call
 * site. It decides which endpoint to post to and nothing else; the server checks
 * the signature over this same field and refuses a mismatch.
 */
function roomFromUnverifiedState(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  try {
    const json = atob(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as { roomId?: unknown };
    return typeof parsed.roomId === 'string' ? parsed.roomId : null;
  } catch {
    return null;
  }
}
