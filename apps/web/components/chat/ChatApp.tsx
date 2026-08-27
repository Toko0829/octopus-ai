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
import {
  getChannels,
  getMembers,
  getMessages,
  getProjects,
  postMessage,
  startAgentRun,
  actOnEmbed,
} from '../../lib/api-client';
import { createClient } from '../../lib/supabase/client';
import { GuildRail } from './GuildRail';
import { ChannelSidebar } from './ChannelSidebar';
import { TopBar } from './TopBar';
import { MessageStream } from './MessageStream';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { CommandPalette } from './CommandPalette';
import { AddSourcePanel } from './AddSourcePanel';
import { CreateBusinessPanel } from './CreateBusinessPanel';
import { ProjectPanel } from './ProjectPanel';

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
  const [sourceOpen, setSourceOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [waitingOnYou, setWaitingOnYou] = useState(0);
  // Rooms arrive as a server prop and become state here, because creating one has
  // to show up without a full page reload and has to move the selection with it.
  const [roomList, setRoomList] = useState(rooms);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Read inside the Realtime callback without making it a dependency, which would
  // tear down and rebuild the subscription on every message.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  /**
   * Agent messages whose embed has already been fetched after a broadcast.
   * A ref rather than state: it must not trigger a render, and it must survive
   * the re-render that merging the fetched message causes, or the fetch would
   * repeat forever.
   */
  const embedFetchedRef = useRef<Set<string>>(new Set());

  const businesses = useMemo(() => roomList.map(toBusiness), [roomList]);
  const uiChannels = useMemo(() => channels.map(toChannel), [channels]);
  const uiMembers = useMemo<UiMember[]>(
    () => members.map((m) => toMember(m, viewerId, presence[m.userId] ?? 'offline')),
    [members, viewerId, presence],
  );
  const membersById = useMemo(
    () => Object.fromEntries(uiMembers.map((m) => [m.id, m] as const)),
    [uiMembers],
  );

  /**
   * Ownership decides whether the plan card offers its actions. Presentation
   * only: the server re-checks on every action, so a viewer who forged this
   * would simply be refused.
   */
  const canAct = useMemo(
    () => rooms.find((r) => r.id === roomId)?.ownerId === viewerId,
    [rooms, roomId, viewerId],
  );

  /**
   * Record a verdict, then patch the card in place. Re-fetching the whole
   * stream would scroll the reader away from what they just acted on.
   */
  const handleEmbedAction = useCallback(
    async (embedId: string, action: 'approve' | 'request_changes', note?: string) => {
      const res = await actOnEmbed(roomId, embedId, { action, note });
      setMessages((cur) =>
        cur.map((m) =>
          m.embed?.id === embedId ? { ...m, embed: { ...m.embed, state: res.state } } : m,
        ),
      );
    },
    [roomId],
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
        error: sessionError,
      } = await supabase.auth.getSession();
      if (cancelled) return;

      // Returning quietly here was a bug: the page renders fine (the server has
      // the session) while live updates never start and nothing says so.
      if (sessionError || !session) {
        console.error('[chat] no client session; live updates disabled', sessionError);
        setBanner('Live updates are off because this session could not be read. Try reloading.');
        return;
      }

      await supabase.realtime.setAuth(session.access_token);
      channel = supabase.channel(`chat:room:${roomId}`, {
        config: { private: true, presence: { key: viewerId } },
      });

      channel.on('broadcast', { event: 'INSERT' }, (payload) => {
        const record = (payload as { payload?: { record?: unknown } }).payload?.record;
        const msg = fromBroadcastRecord(record);
        if (!msg) return;
        setMessages((cur) => mergeMessages(cur, [msg]));

        // The broadcast is a `messages` row; the trigger cannot see another
        // table, so an agent message that has a plan card arrives without it.
        // The ordinary catch-up will not repair this either, since it fetches
        // `seq > highest` and this message is already the highest. Re-fetch from
        // just below its own seq to pick up the embed.
        //
        // Only for agent messages, and only once each: a user message never has
        // a card, and re-fetching on every broadcast would turn live delivery
        // back into polling.
        if (
          msg.authorKind === 'agent' &&
          msg.seq !== null &&
          !embedFetchedRef.current.has(msg.id)
        ) {
          embedFetchedRef.current.add(msg.id);
          void (async () => {
            try {
              const res = await getMessages(roomId, msg.seq! - 1);
              if (res.messages.length > 0) {
                setMessages((cur) => mergeMessages(cur, res.messages.map(toMessage)));
              }
            } catch (err) {
              // Not fatal: the message itself already rendered, and the card
              // appears on the next load. Worth a log, not a banner.
              console.error('[chat] could not fetch plan card', err);
            }
          })();
        }
      });

      channel.on('presence', { event: 'sync' }, () => {
        const state = channel?.presenceState() ?? {};
        const next: Record<string, Presence> = {};
        for (const key of Object.keys(state)) next[key] = 'online';
        setPresence(next);
      });

      channel.subscribe(async (status, err) => {
        if (cancelled) return;
        console.info('[chat] realtime status', status, err?.message ?? '');
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

  /**
   * How many steps are waiting on this person, for the badge in the top bar.
   *
   * Re-read when the room changes and whenever a message lands, because the
   * things that change this number (a plan approved, a tick routing steps to
   * `needs_user`) all announce themselves in the room. That is cheaper and more
   * honest than polling: the badge moves when something actually happened.
   *
   * A failure here is deliberately silent. It is a count on a button, not the
   * work itself, and a banner saying the badge could not load would be louder
   * than the thing it describes. The panel itself reports its own errors.
   */
  const lastMessageId = messages[messages.length - 1]?.id ?? null;
  useEffect(() => {
    let live = true;
    getProjects(roomId)
      .then((res) => {
        if (live) setWaitingOnYou(res.projects.reduce((n, p) => n + p.waitingOnYou, 0));
      })
      .catch(() => {
        if (live) setWaitingOnYou(0);
      });
    return () => {
      live = false;
    };
  }, [roomId, lastMessageId]);

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

      // The message is safely persisted at this point, so a failure to start the
      // agent must not roll it back or mark it unsent. Surface it separately.
      try {
        await startAgentRun(roomId, text);
      } catch (runErr) {
        console.error('[chat] agent run could not be started', runErr);
        setBanner('Your message was sent, but the agent could not be started.');
      }
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
      <GuildRail
        businesses={businesses}
        activeId={roomId}
        onSelect={selectRoom}
        onCreate={() => setCreateOpen(true)}
      />
      <ChannelSidebar
        business={business}
        channels={uiChannels}
        activeId={activeChan}
        onSelect={setActiveChan}
        viewer={membersById[viewerId] ?? null}
        viewerEmail={viewerEmail}
      />
      <div className="main">
        <TopBar
          channel={activeChannel?.name ?? business.name}
          memberCount={uiMembers.length}
          onOpenWork={() => setWorkOpen(true)}
          waitingOnYou={waitingOnYou}
        />
        {banner && (
          <div className="banner" role="status">
            {banner}
          </div>
        )}
        <MessageStream
          channelName={activeChannel?.name ?? null}
          messages={messages}
          membersById={membersById}
          canAct={canAct}
          onEmbedAction={handleEmbedAction}
        />
        <Composer
          channelName={activeChannel?.name ?? null}
          onSend={handleSend}
          onAddSource={canAct ? () => setSourceOpen(true) : undefined}
        />
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
      {sourceOpen && (
        <AddSourcePanel
          roomId={roomId}
          onClose={() => setSourceOpen(false)}
          onAccepted={() => flash('Reading that now. I will say what I learned.')}
        />
      )}
      {workOpen && (
        <ProjectPanel roomId={roomId} canAct={canAct} onClose={() => setWorkOpen(false)} />
      )}
      {createOpen && (
        <CreateBusinessPanel
          onClose={() => setCreateOpen(false)}
          onCreated={(room) => {
            setRoomList((cur) => [...cur, room as (typeof cur)[number]]);
            selectRoom(room.id);
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <span className="pulse" aria-hidden />
          {toast}
        </div>
      )}
    </div>
  );
}
