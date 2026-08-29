'use client';

import { useEffect, useState } from 'react';
import type { ChannelConnection, MarketingChannel } from '@octopus/contracts';
import { disconnectConnection, getConnections, startConnection } from '../../lib/api-client';

/**
 * The accounts this workspace has connected, and the surface for connecting one.
 *
 * **Room-scoped, and that is why it is not a card.** A connection is made once
 * for a workspace and serves every project in it (`20260829121000`), so
 * attaching it to one project's plan step would mean re-authorising the same ad
 * account for every goal somebody posts. It is also the wrong shape for a card a
 * second time: every card in this product is approve-or-reject where approving
 * commits through one function, and approving a connection cannot commit
 * anything, because the credential does not exist until after a redirect round
 * trip.
 *
 * **It lives in the room rail, and it did not at first.** The first version put
 * it in the project panel, which satisfied the room-scoping argument on paper
 * and failed the only test that matters: the first person to use it could not
 * find it. That panel is called "The work", it opens as a modal from the top
 * bar, and nobody hunting for account settings opens it. Worse, putting it
 * behind a project view implies a connection belongs to a project, which is the
 * exact impression the room-scoping exists to prevent. **A structurally correct
 * home that nobody opens is not a home.** The rail is the room's own column, is
 * on screen all the time, and already carries the other room-level fact.
 *
 * **The list never carries a token**, and it is not this component's discretion.
 * `ChannelConnection` has no field for one, so the projection could not hand a
 * credential to a browser without a change that fails to typecheck first.
 *
 * **Status is words plus a badge, never colour** (rule 15), and expired reads
 * differently from revoked because the actions differ: one is reconnectable in
 * place and the other is a decision somebody made.
 */

/** What can be connected today. Only the fake is registered, and it says so. */
const CONNECTABLE: { channel: MarketingChannel; label: string }[] = [
  { channel: 'meta', label: 'Meta Ads' },
  { channel: 'google', label: 'Google Ads' },
  { channel: 'email', label: 'Email' },
  { channel: 'organic_social', label: 'Organic social' },
];

const CHANNEL_LABEL: Record<MarketingChannel, string> = {
  meta: 'Meta Ads',
  google: 'Google Ads',
  email: 'Email',
  organic_social: 'Organic social',
};

const STATUS_COPY: Record<ChannelConnection['status'], string> = {
  active: 'Connected',
  expired: 'Expired, reconnect to use it',
  revoked: 'Disconnected',
};

export function ConnectedAccounts({ roomId, canAct }: { roomId: string; canAct: boolean }) {
  const [connections, setConnections] = useState<ChannelConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    getConnections(roomId)
      .then((r) => live && setConnections(r.connections))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load accounts.'));
    return () => {
      live = false;
    };
  }, [roomId, refresh]);

  async function connect(channel: MarketingChannel) {
    setBusy(channel);
    setPicking(false);
    setError(null);
    try {
      const { authorizeUrl } = await startConnection(roomId, 'fake', channel);
      // A full navigation rather than a popup. The consent screen has to be able
      // to show its own origin, and a person checking where they are about to
      // approve something is doing the right thing.
      window.location.assign(authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start connecting.');
      setBusy(null);
    }
  }

  async function disconnect(connection: ChannelConnection) {
    setBusy(connection.id);
    setError(null);
    try {
      await disconnectConnection(roomId, connection.id);
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(null);
    }
  }

  const live = (connections ?? []).filter((c) => c.status !== 'revoked');

  return (
    <section className="ctx-connections">
      {/* `ctx-label` rather than a heading of its own, so this reads as a second
          section of the rail beside "In this room" instead of a panel that has
          been dropped into one. */}
      <h3 className="ctx-label">Connected accounts</h3>

      {error && (
        <p className="ctx-conn-error" role="alert">
          {error}
        </p>
      )}

      {/* Loading and empty are different answers, as everywhere else in this
          product: "nothing connected" while a request is in flight is false. */}
      {connections === null && !error && <p className="ctx-empty">Loading.</p>}

      {connections !== null && live.length === 0 && (
        <p className="ctx-empty">
          Nothing connected. Octopus cannot publish or spend anywhere until you connect an account.
        </p>
      )}

      {live.length > 0 && (
        <ul className="ctx-conn-list">
          {live.map((c) => (
            <li key={c.id} className="ctx-conn">
              <div className="ctx-conn-head">
                <span className="ctx-conn-name">{CHANNEL_LABEL[c.channel]}</span>
                <span className={`ctx-conn-status ${c.status}`}>
                  <span aria-hidden="true" className="ctx-conn-dot" />
                  {STATUS_COPY[c.status]}
                </span>
              </div>
              <p className="ctx-conn-detail mono">
                {c.provider}
                {c.externalAccountId ? ` · ${c.externalAccountId}` : ''}
              </p>
              <p className="ctx-conn-detail">
                {c.grantedScopes.length > 0
                  ? `Granted: ${c.grantedScopes.join(', ')}`
                  : 'No permissions granted, so nothing can use this.'}
              </p>
              {canAct && (
                <button
                  type="button"
                  className="ctx-conn-link"
                  disabled={busy === c.id}
                  onClick={() => disconnect(c)}
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* A disclosure rather than four buttons always on show. The rail is a
          narrow column that is on screen the whole time, so a permanent stack of
          "Connect X" is four pieces of furniture for an action most people take
          once. Closed by default and closed again after a choice. */}
      {canAct && (
        <div className="ctx-conn-actions">
          {!picking ? (
            <button type="button" className="ctx-conn-link" onClick={() => setPicking(true)}>
              Connect an account
            </button>
          ) : (
            <>
              {CONNECTABLE.map((option) => (
                <button
                  key={option.channel}
                  type="button"
                  className="ctx-conn-choice"
                  disabled={busy !== null}
                  onClick={() => connect(option.channel)}
                >
                  {option.label}
                </button>
              ))}
              <button type="button" className="ctx-conn-link" onClick={() => setPicking(false)}>
                Cancel
              </button>
              {/* Said out loud rather than implied by the word "fake" appearing
                  in a row. Somebody about to click through a consent screen
                  should know what is on the other side of it. */}
              <p className="ctx-empty">
                Only the built-in test provider is available today. It authorises nothing and
                reaches no real platform.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
