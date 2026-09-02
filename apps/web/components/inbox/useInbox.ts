'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { ListNotificationsResponse, Notification } from '@octopus/contracts';
import { createClient } from '../../lib/supabase/client';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../lib/api-client';
import { composeNotification } from '../../lib/notification-copy';

/**
 * One person's inbox, live.
 *
 * The subscription is `ChatApp`'s, deliberately copied rather than abstracted:
 * `getSession()` then `realtime.setAuth(token)` before the channel is built, a
 * private channel, `broadcast` on `INSERT`, a since-cursor catch-up on
 * `SUBSCRIBED` because a live subscription is not durable catch-up, and a
 * visible line when the socket drops. Two copies of that sequence already exist
 * (`ChatApp` and `NodeConsole`'s `ThreadPanel`) and a third is the point at which
 * extracting it becomes worth doing; this is that third, and it is left alone on
 * purpose. The room and thread subscriptions carry presence, merge into a message
 * list and dedupe embeds, and the shared thing would be four lines of setup
 * wrapped in six parameters. When one of them changes for a real reason, that is
 * the moment to see whether they are the same shape.
 *
 * **The topic is `notify:user:<uid>` and it is not scoped to a room.** That is
 * what makes the count in `/app` correct: an owner running two businesses is
 * told about both, and a node whose work lives in threads they can no longer open
 * is told at all. Both would be impossible on the chat topics.
 */

export interface InboxState {
  items: Notification[];
  unread: number;
  /** How many of the unread ones are waiting on this person. Drives the badge. */
  needsYou: number;
  /** Set when live delivery is not working, so the panel can say so. */
  liveError: string | null;
  markRead: (id: string) => void;
  markAll: () => void;
}

const EMPTY: ListNotificationsResponse = { notifications: [], unread: 0 };

/** Wire row -> the same row, guarded. The broadcast sends the whole NEW row. */
function fromBroadcastRecord(record: unknown): Notification | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.kind !== 'string') return null;
  const role = r.recipient_role;
  if (role !== 'owner' && role !== 'node') return null;

  // Postgres sends jsonb as an object through `realtime.broadcast_changes`, but
  // a string is cheap to survive and expensive to be surprised by.
  let payload: Record<string, unknown> = {};
  if (typeof r.payload === 'string') {
    try {
      payload = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  } else if (r.payload && typeof r.payload === 'object') {
    payload = r.payload as Record<string, unknown>;
  }

  return {
    id: r.id,
    kind: r.kind as Notification['kind'],
    recipientRole: role,
    subjectType: typeof r.subject_type === 'string' ? r.subject_type : '',
    subjectId: typeof r.subject_id === 'string' ? r.subject_id : '',
    projectId: typeof r.project_id === 'string' ? r.project_id : null,
    payload,
    createdAt: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
    readAt: typeof r.read_at === 'string' ? r.read_at : null,
  };
}

function merge(current: Notification[], incoming: Notification): Notification[] {
  if (current.some((n) => n.id === incoming.id)) return current;
  return [incoming, ...current].slice(0, 50);
}

export function useInbox(viewerId: string, initial?: ListNotificationsResponse | null): InboxState {
  const seed = initial ?? EMPTY;
  const [items, setItems] = useState<Notification[]>(seed.notifications);
  const [unread, setUnread] = useState(seed.unread);
  const [liveError, setLiveError] = useState<string | null>(null);

  /**
   * The catch-up runs inside the Realtime callback and must not be a dependency
   * of the effect, or every arriving row would tear the socket down and rebuild
   * it. `ChatApp` holds `messagesRef` for the same reason.
   */
  const catchUp = useCallback(async () => {
    try {
      const res = await listNotifications({ limit: 30 });
      setItems(res.notifications);
      setUnread(res.unread);
      setLiveError(null);
    } catch {
      // The seed already rendered and the socket is up. Saying "could not
      // refresh" over a list that is probably right would be louder than the
      // problem; a genuinely broken socket is reported by the status handler.
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    void (async () => {
      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();
      if (cancelled) return;

      // Returning quietly here is the bug `ChatApp` records: the page renders
      // from its server seed, live updates never start, and nothing says so. The
      // badge would then be right once and wrong forever.
      if (error || !session) {
        console.error('[inbox] no client session; live updates disabled', error);
        setLiveError('Live updates are off. Reload to see new notifications.');
        return;
      }

      await supabase.realtime.setAuth(session.access_token);
      channel = supabase.channel(`notify:user:${viewerId}`, { config: { private: true } });

      channel.on('broadcast', { event: 'INSERT' }, (payload) => {
        const record = (payload as { payload?: { record?: unknown } }).payload?.record;
        const row = fromBroadcastRecord(record);
        if (!row) return;
        setItems((cur) => {
          const next = merge(cur, row);
          // Count only when the row is genuinely new, or a re-delivery would
          // inflate the badge past what the list can explain.
          if (next !== cur && !row.readAt) setUnread((n) => n + 1);
          return next;
        });
      });

      channel.subscribe(async (status, err) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setLiveError(null);
          await catchUp();
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('[inbox] realtime status', status, err?.message ?? '');
          setLiveError('Live updates are disconnected. Reload to catch up.');
        }
      });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [viewerId, catchUp]);

  /**
   * Optimistic, and reverted on failure.
   *
   * Marking read is the one thing in this component that must feel instant: it
   * happens on the way to somewhere else, and a row that stays bold while the
   * page navigates reads as a click that did not land.
   */
  const markRead = useCallback((id: string) => {
    let wasUnread = false;
    setItems((cur) =>
      cur.map((n) => {
        if (n.id !== id || n.readAt) return n;
        wasUnread = true;
        return { ...n, readAt: new Date().toISOString() };
      }),
    );
    if (!wasUnread) return;
    setUnread((n) => Math.max(0, n - 1));

    void markNotificationRead(id).catch(() => {
      setItems((cur) => cur.map((n) => (n.id === id ? { ...n, readAt: null } : n)));
      setUnread((n) => n + 1);
      setLiveError('That did not save. Reload to see what is actually read.');
    });
  }, []);

  /** Read by `markAll` without making the list its dependency. */
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const markAll = useCallback(() => {
    const before = itemsRef.current;
    const at = new Date().toISOString();
    setItems((cur) => cur.map((n) => (n.readAt ? n : { ...n, readAt: at })));
    setUnread(0);

    void markAllNotificationsRead().catch(() => {
      setItems(before);
      setUnread(before.filter((n) => !n.readAt).length);
      setLiveError('That did not save. Reload to see what is actually read.');
    });
  }, []);

  /**
   * The badge's amber half. Counted over unread rows only, because a thing you
   * have already read is not still asking.
   */
  const needsYou = useMemo(
    () => items.filter((n) => !n.readAt && composeNotification(n).needsAction).length,
    [items],
  );

  return { items, unread, needsYou, liveError, markRead, markAll };
}
