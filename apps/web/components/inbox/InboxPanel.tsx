'use client';

import { useMemo } from 'react';
import type { Notification } from '@octopus/contracts';
import { composeNotification } from '../../lib/notification-copy';
import type { InboxState } from './useInbox';

interface Props {
  inbox: InboxState;
  onOpen: (href: string) => void;
  onClose: () => void;
}

/**
 * How long ago, in the shortest true form.
 *
 * Computed at render rather than stored, and deliberately coarse: a row that
 * says "3m" and does not tick is honest for the two seconds anybody looks at it,
 * and a live-updating clock in a list of fourteen rows is fourteen timers to buy
 * nothing.
 */
function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const mins = Math.max(0, Math.round((now - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

/**
 * The inbox itself.
 *
 * **Anchored under the bell, never bottom-right.** A floating panel in the corner
 * of the viewport is the corner chatbot bubble on the never-ship list
 * (design-system.md), and this one would be the same silhouette doing a different
 * job, which is worse rather than better: it would teach people that the corner
 * is where the machine talks to them.
 *
 * Every row carries a word for its state as well as a colour: "Needs you" in
 * amber against "Update" in the quiet neutral, plus a rule down the leading edge
 * of anything unread. Rule 15 asks for status never by colour alone, and a list
 * where the only difference between two rows is a hue is exactly the case it
 * exists for.
 */
export function InboxPanel({ inbox, onOpen, onClose }: Props) {
  const now = Date.now();
  const { items, unread, liveError, markRead, markAll } = inbox;

  const rows = useMemo(
    () => items.map((n: Notification) => ({ n, composed: composeNotification(n, now) })),
    // `now` is intentionally excluded: recomputing every row on every tick of the
    // clock would rebuild the list under the reader's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );

  return (
    <div className="inbox-panel" role="dialog" aria-modal="false" aria-label="Notifications">
      <header className="inbox-head">
        <span className="inbox-title mono">Notifications</span>
        {unread > 0 && (
          <button type="button" className="inbox-clear mono" onClick={markAll}>
            Mark all as read
          </button>
        )}
      </header>

      {liveError && (
        <p className="inbox-live" role="status">
          {liveError}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="inbox-empty">Nothing new. You will be told here when something needs you.</p>
      ) : (
        <ul className="inbox-list">
          {rows.map(({ n, composed }) => (
            <li key={n.id} className={n.readAt ? 'inbox-item' : 'inbox-item inbox-item-unread'}>
              <button
                type="button"
                className="inbox-row"
                onClick={() => {
                  markRead(n.id);
                  onOpen(composed.href);
                }}
              >
                <span className="inbox-row-head">
                  <span className="inbox-row-title">{composed.title}</span>
                  <span className="inbox-row-when mono">{ago(n.createdAt, now)}</span>
                </span>
                <span className="inbox-row-body">{composed.body}</span>
                <span
                  className={
                    composed.needsAction
                      ? 'inbox-chip mono inbox-chip-needs'
                      : 'inbox-chip mono inbox-chip-update'
                  }
                >
                  {composed.needsAction ? 'Needs you' : 'Update'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="sr-only" onClick={onClose}>
        Close notifications
      </button>
    </div>
  );
}
