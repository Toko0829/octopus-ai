'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type {
  Channel,
  EmbedActionBody,
  EmbedActionResponse,
  ListNotificationsResponse,
  Message,
  ProjectSummary,
  Room,
  RoomMember,
} from '@octopus/contracts';
import type { Presence, UiMember, UiMessage } from '../../lib/types';
import { activityByPersona } from '../../lib/persona-activity';
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
import { InboxBell } from '../inbox/InboxBell';
import { useInbox } from '../inbox/useInbox';

interface Props {
  viewerId: string;
  viewerEmail: string | null;
  /**
   * Whether the viewer also has a marketplace record.
   *
   * Presentation only, and it decides one link. A node who owns a workspace
   * would otherwise have no way to reach `/node` from inside the app, which is
   * the "structurally correct home that nobody opens" failure this repository
   * recorded when connected accounts lived behind a modal.
   */
  isNode?: boolean;
  rooms: Room[];
  initialRoomId: string;
  initialChannels: Channel[];
  initialMembers: RoomMember[];
  initialMessages: Message[];
  /**
   * The inbox as the server saw it, so the count is right on the first frame
   * rather than zero until the socket connects.
   */
  initialInbox?: ListNotificationsResponse | null;
}

/**
 * How long the Strategist keeps pulsing with no word back.
 *
 * Three minutes, which is longer than a plan usually takes and shorter than a
 * person will sit staring at it. The backstop exists because a run can end in
 * ways this client never sees, and a pulse with no way to stop would outlive
 * the thing it described.
 */
const STRATEGIST_BUSY_TIMEOUT_MS = 180_000;

export function ChatApp({
  viewerId,
  viewerEmail,
  isNode = false,
  rooms,
  initialRoomId,
  initialChannels,
  initialMembers,
  initialMessages,
  initialInbox,
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
  /**
   * The project list, kept rather than reduced to one number.
   *
   * It already arrives on every message for the waiting badge, and it carries
   * `working`, which is what the members panel needs to say which voice is busy.
   * Keeping it costs one more piece of state and saves a second poll.
   */
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  /**
   * This browser's own agent run is in flight.
   *
   * **Client-local, and it has to be.** Planning happens before a project
   * exists, so there is no task row for the panel to find and no server-side
   * agent presence to read; this is the one wait that looks longest and the one
   * nothing else can report. It is therefore a claim about what this tab just
   * did, not about the system, and the clear rules below keep it from lying for
   * longer than the timeout.
   */
  const [strategistBusy, setStrategistBusy] = useState(false);
  const strategistTimer = useRef<number | null>(null);
  // Rooms arrive as a server prop and become state here, because creating one has
  // to show up without a full page reload and has to move the selection with it.
  const [roomList, setRoomList] = useState(rooms);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  /**
   * The inbox. Subscribed per person rather than per room, which is what makes
   * the count correct for somebody running two businesses: the chat topics are
   * scoped to the room on screen, and being told only about the room you are
   * already looking at is most of the way back to not being told at all.
   */
  const inbox = useInbox(viewerId, initialInbox);

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
  const personas = useMemo(
    () => activityByPersona(projects, strategistBusy),
    [projects, strategistBusy],
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
   * Mark the Strategist busy, with a backstop.
   *
   * The timeout is the honest part. A run can end in ways this client never
   * sees: intake declining the subject posts one line and stops, and a tab that
   * was backgrounded through the whole run may miss the broadcast. A pulse with
   * no way to stop would be a lie that outlives the thing it described, so it
   * expires whether or not anything arrived.
   */
  const markStrategistBusy = useCallback(() => {
    setStrategistBusy(true);
    if (strategistTimer.current !== null) window.clearTimeout(strategistTimer.current);
    strategistTimer.current = window.setTimeout(
      () => setStrategistBusy(false),
      STRATEGIST_BUSY_TIMEOUT_MS,
    );
  }, []);

  const clearStrategistBusy = useCallback(() => {
    if (strategistTimer.current !== null) window.clearTimeout(strategistTimer.current);
    strategistTimer.current = null;
    setStrategistBusy(false);
  }, []);

  useEffect(
    () => () => {
      if (strategistTimer.current !== null) window.clearTimeout(strategistTimer.current);
    },
    [],
  );

  /**
   * Patch one card in place from what the route answered. Re-fetching the whole
   * stream would scroll the reader away from what they just acted on.
   *
   * The payload is taken too, when the route sent one. Realtime carries
   * `messages` inserts only, so a card on screen otherwise keeps the payload it
   * was first fetched with: a campaign approved at 2000 read "approved at 0",
   * and a question card would never show the answer that was just saved.
   */
  const patchEmbed = useCallback((embedId: string, res: EmbedActionResponse) => {
    setMessages((cur) =>
      cur.map((m) =>
        m.embed?.id === embedId
          ? {
              ...m,
              embed: {
                ...m.embed,
                state: res.state,
                ...(res.payload !== undefined ? { payload: res.payload } : {}),
              } as UiMessage['embed'],
            }
          : m,
      ),
    );
  }, []);

  /** Record a verdict, then patch the card. */
  const handleEmbedAction = useCallback(
    async (
      embedId: string,
      action: 'approve' | 'request_changes',
      note?: string,
      budgetCap?: number,
    ) => {
      const res = await actOnEmbed(roomId, embedId, { action, note, budgetCap });
      patchEmbed(embedId, res);
    },
    [roomId, patchEmbed],
  );

  /** Save one answer on a question card, then patch the card. */
  const handleQuestionAction = useCallback(
    async (embedId: string, input: EmbedActionBody) => {
      const res = await actOnEmbed(roomId, embedId, input);
      patchEmbed(embedId, res);
      // A finished card continues the run: the Strategist is planning again, or
      // writing a diff for a project that is already running.
      if (res.state === 'answered') markStrategistBusy();
      return res;
    },
    [roomId, patchEmbed, markStrategistBusy],
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
        if (!live) return;
        setProjects(res.projects);
        setWaitingOnYou(res.projects.reduce((n, p) => n + p.waitingOnYou, 0));
      })
      .catch(() => {
        if (!live) return;
        setProjects([]);
        setWaitingOnYou(0);
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
        // A person's message never carries one, and the table refuses it: the
        // field is here because the type requires every message to say, rather
        // than because this one could have a value.
        persona: null,
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
        // Only once the run was accepted. Pulsing on the optimistic send would
        // show the Strategist working on a run the server refused.
        markStrategistBusy();
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

  /**
   * Stop the Strategist pulsing when the run has visibly answered.
   *
   * Three signals, because a run ends in three shapes. A card is the ordinary
   * one: the plan or the diff has landed and there is something to read. A
   * `system` line is the failure notice, which is the platform saying the run
   * did not finish. A plain Strategist line is intake declining the subject or
   * asking its questions, both of which are the turn handing back to the person.
   *
   * The remaining case is a run that ends without reaching this browser at all,
   * and that is what the timeout in `markStrategistBusy` is for.
   */
  const newestMessage = messages[messages.length - 1];
  useEffect(() => {
    if (!strategistBusy || !newestMessage || newestMessage.seq === null) return;
    const isAgentAnswer =
      newestMessage.authorKind === 'agent' && newestMessage.persona === 'strategist';
    const isPlatformNotice = newestMessage.authorKind === 'system';
    if (isAgentAnswer || isPlatformNotice) clearStrategistBusy();
  }, [newestMessage, strategistBusy, clearStrategistBusy]);

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
          isNode={isNode}
          inbox={
            <InboxBell
              inbox={inbox}
              onOpen={(href) => {
                // An owner's notification names the room its project is
                // announced in. Switching in place rather than navigating keeps
                // the socket and the scroll position, and a full reload to reach
                // a room this shell is already holding would be a page flash for
                // nothing.
                const room = new URL(href, window.location.origin).searchParams.get('room');
                if (room && roomList.some((r) => r.id === room)) {
                  if (room !== roomId) void selectRoom(room);
                  setWorkOpen(true);
                  return;
                }
                if (!href.startsWith('/app')) window.location.assign(href);
                else setWorkOpen(true);
              }}
            />
          }
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
          onQuestionAction={handleQuestionAction}
        />
        <Composer
          channelName={activeChannel?.name ?? null}
          onSend={handleSend}
          onAddSource={canAct ? () => setSourceOpen(true) : undefined}
        />
      </div>
      <ContextPanel members={uiMembers} personas={personas} roomId={roomId} canAct={canAct} />
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
