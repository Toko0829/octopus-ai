'use client';

import { useEffect, useMemo, useState } from 'react';
import { businesses, channels, members, seedMessages } from '../../lib/mock';
import type { Member, Message } from '../../lib/types';
import { GuildRail } from './GuildRail';
import { ChannelSidebar } from './ChannelSidebar';
import { TopBar } from './TopBar';
import { MessageStream } from './MessageStream';
import { Composer } from './Composer';
import { ContextPanel } from './ContextPanel';
import { CommandPalette } from './CommandPalette';

let idCounter = 100;
const nextId = () => `m${++idCounter}`;

function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ChatApp() {
  const [activeBiz, setActiveBiz] = useState('rune');
  const [activeChan, setActiveChan] = useState('brief');
  const [messages, setMessages] = useState<Message[]>(seedMessages);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const membersById = useMemo<Record<string, Member>>(
    () => Object.fromEntries(members.map((m) => [m.id, m] as const)),
    [],
  );
  const business = businesses.find((b) => b.id === activeBiz) ?? businesses[0]!;

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

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }

  function handleSend(text: string) {
    setMessages((m) => [
      ...m,
      { id: nextId(), authorId: 'you', kind: 'text', body: text, ts: nowTime() },
    ]);
    const thinkingId = nextId();
    window.setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          id: thinkingId,
          authorId: 'agent',
          kind: 'text',
          body: '',
          ts: nowTime(),
          streaming: true,
        },
      ]);
    }, 500);
    window.setTimeout(() => {
      setMessages((m) =>
        m.map((x) =>
          x.id === thinkingId
            ? {
                ...x,
                streaming: false,
                body: 'Got it — I’ll ground this in what’s worked for similar creators and refine the plan. (Live planning wires up next in Phase 1, once the RAG + model are connected.)',
              }
            : x,
        ),
      );
    }, 1900);
  }

  function approve(id: string) {
    setMessages((m) => [
      ...m.map((x) => (x.id === id ? { ...x, planState: 'approved' as const } : x)),
      {
        id: nextId(),
        authorId: 'system',
        kind: 'system',
        body: 'Maya approved the plan. AI-owned steps queued; human steps will be offered to matched experts.',
        ts: nowTime(),
      },
    ]);
    flash('Plan approved — captured as flywheel signal ✓');
  }

  function requestChanges(_id: string) {
    flash('Feedback captured — the agent will revise (flywheel signal)');
  }

  function handleAction(label: string) {
    setCmdkOpen(false);
    flash(label);
  }

  const activeChannelName = channels.find((c) => c.id === activeChan)?.name ?? 'brief';
  const currentPlan = messages.find((x) => x.kind === 'plan')?.plan;

  return (
    <div className="shell">
      <GuildRail businesses={businesses} activeId={activeBiz} onSelect={setActiveBiz} />
      <ChannelSidebar
        business={business}
        channels={channels}
        activeId={activeChan}
        onSelect={setActiveChan}
      />
      <div className="main">
        <TopBar
          channel={activeChannelName}
          topic="launch — week 1 · first 1,000 users"
          budgetUsed="$1,180"
          budgetCeiling="$1,500"
        />
        <MessageStream
          messages={messages}
          membersById={membersById}
          onApprove={approve}
          onRequestChanges={requestChanges}
        />
        <Composer onSend={handleSend} />
      </div>
      <ContextPanel members={members} plan={currentPlan} />
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} onAction={handleAction} />
      {toast && (
        <div className="toast">
          <span className="pulse" aria-hidden />
          {toast}
        </div>
      )}
    </div>
  );
}
