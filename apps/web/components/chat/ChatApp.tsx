'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Channel, Message, Room, RoomMember } from '@octopus/contracts';
import type { Presence, UiMember, UiMessage } from '../../lib/types';
import {
  fromBroadcastRecord,
  mergeMessages,
  toBusiness,
  toChannel,
  toMember,
  toMessage,
} from '../../lib/adapt';
import { getChannels, getMembers, getMessages, postMessage } from '../../lib/api-client';
import { createClient } from '../../lib/supabase/client';
import { GuildRail } from './GuildRail';
import { ChannelSidebar } from './ChannelSidebar';
import { TopBar } from './TopBar';
import { MessageStream } from './MessageStream';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { CommandPalette } from './CommandPalette';

interface Props {
  viewerId: string;
  viewerEmail: string | null;
  rooms: Room[];
  initialRoomId: string;
  initialChannels: Channel[];
  initialMembers: RoomMember[];
  initialMessages: Message[];
}

export function ChatApp({
  viewerId,
  viewerEmail,
  rooms,
  initialRoomId,
  initialChannels,
  initialMembers,
  initialMessages,
}: Props) {
  const [roomId, setRoomId] = useState(initialRoomId);
  const [channels, setChannels] = useState<Channel[]>(initialChannels);
  const [members, setMembers] = useState<RoomMember[]>(initialMembers);
  const [messages, setMessages] = useState<UiMessage[]>(() => initialMessages.map(toMessage));
  const [activeChan, setActiveChan] = useState<string | null>(initialChannels[0]?.id ?? null);
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Read inside the Realtime callback without making it a dependency, which would
  // tear down and rebuild the subscription on every message.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const businesses = useMemo(() => rooms.map(toBusiness), [rooms]);
  const uiChannels = useMemo(() => channels.map(toChannel), [channels]);
  const uiMembers = useMemo<UiMember[]>(
    () => members.map((m) => toMember(m, viewerId, presence[m.userId] ?? 'offline')),
    [members, viewerId, presence],
  );
  const membersById = useMemo(
    () => Object.fromEntries(uiMembers.map((m) => [m.id, m] as const)),
    [uiMembers],
  );

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  /** Pull anything that landed while we were not subscribed. */
  const catchUp = useCallback(async (id: string) => {
    const highest = messagesRef.current.reduce(
      (max, m) => (m.seq !== null && m.seq > max ? m.seq : max),
      0,
    );
    try {
      const res = await getMessages(id, highest || undefined);
      if (res.messages.length > 0) {
        setMessages((cur) => mergeMessages(cur, res.messages.map(toMessage)));
      }
    } catch (err) {
      console.error('[chat] catch-up failed', err);
      setBanner('Could not load recent messages. They may be missing until you reload.');
    }
  }, []);

  /**
   * Live delivery. The database broadcasts on insert (ADR-0003), so this listens
   * rather than polling. On (re)subscribe it also runs a since-cursor catch-up,
   * because a live subscription is not durable catch-up.
   */
  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session || cancelled) return;

      await supabase.realtime.setAuth(session.access_token);
      channel = supabase.channel(`chat:room:${roomId}`, {
        config: { private: true, presence: { key: viewerId } },
      });

      channel.on('broadcast', { event: 'INSERT' }, (payload) => {
        const record = (payload as { payload?: { record?: unknown } }).payload?.record;
        const msg = fromBroadcastRecord(record);
        if (msg) setMessages((cur) => mergeMessages(cur, [msg]));
      });

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel?.presenceState() ?? {};
        const next: Record<string, Presence> = {};
        for (const key of Object.keys(state)) next[key] = 'online';
        setPresence(next);
      });

      channel.subscribe(async (status) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setBanner(null);
          await channel?.track({ at: new Date().toISOString() });
          await catchUp(roomId);
        }
        // Silence here would mean messages quietly stop arriving, which is the
        // exact failure the write path cannot detect on its own.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setBanner('Live updates are disconnected. Reload to catch up.');
        }
      });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [roomId, viewerId, catchUp]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkOpen((v) => !v);
      }
      if (e.key === 'Escape') setCmdkOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function selectRoom(id: string) {
    if (id === roomId) return;
    setRoomId(id);
    setMessages([]);
    setPresence({});
    try {
      const [ch, mem, msg] = await Promise.all([getChannels(id), getMembers(id), getMessages(id)]);
      setChannels(ch.channels);
      setActiveChan(ch.channels[0]?.id ?? null);
      setMembers(mem.members);
      setMessages(msg.messages.map(toMessage));
    } catch (err) {
      console.error('[chat] room switch failed', err);
      setBanner('Could not open that workspace.');
    }
  }

  async function handleSend(text: string) {
    const idempotencyKey = crypto.randomUUID();
    const localId = `local-${idempotencyKey}`;

    // Optimistic render, reconciled when the server copy arrives (either from this
    // response or from the broadcast; mergeMessages dedupes by id).
    setMessages((cur) => [
      ...cur,
      {
        id: localId,
        authorId: viewerId,
        authorKind: 'user',
        body: text,
        seq: null,
        ts: new Date().toTimeString().slice(0, 5),
        pending: true,
      },
    ]);

    try {
      const saved = await postMessage(roomId, {
        body: text,
        ...(activeChan ? { channelId: activeChan } : {}),
        idempotencyKey,
      });
      setMessages((cur) =>
        mergeMessages(
          cur.filter((m) => m.id !== localId),
          [toMessage(saved)],
        ),
      );
    } catch (err) {
      // Keep the text on screen and mark it failed. Dropping it would lose what
      // the person wrote.
      setMessages((cur) =>
        cur.map((m) => (m.id === localId ? { ...m, pending: false, failed: true } : m)),
      );
      setBanner(err instanceof Error ? err.message : 'Message failed to send.');
    }
  }

  const activeChannel = uiChannels.find((c) => c.id === activeChan);
  const business = businesses.find((b) => b.id === roomId) ?? businesses[0]!;

  return (
    <div className="shell">
      <GuildRail businesses={businesses} activeId={roomId} onSelect={selectRoom} />
      <ChannelSidebar
        business={business}
        channels={uiChannels}
        activeId={activeChan}
        onSelect={setActiveChan}
        viewer={membersById[viewerId] ?? null}
        viewerEmail={viewerEmail}
      />
      <div className="main">
        <TopBar channel={activeChannel?.name ?? business.name} memberCount={uiMembers.length} />
        {banner && (
          <div className="banner" role="status">
            {banner}
          </div>
        )}
        <MessageStream
          channelName={activeChannel?.name ?? null}
          messages={messages}
          membersById={membersById}
        />
        <Composer channelName={activeChannel?.name ?? null} onSend={handleSend} />
      </div>
      <ContextPanel members={uiMembers} />
      <CommandPalette
        open={cmdkOpen}
        channels={uiChannels}
        onClose={() => setCmdkOpen(false)}
        onJump={(id) => {
          setActiveChan(id);
          setCmdkOpen(false);
        }}
        onNotify={flash}
      />
      {toast && (
        <div className="toast">
          <span className="pulse" aria-hidden />
          {toast}
        </div>
      )}
    </div>
  );
}
