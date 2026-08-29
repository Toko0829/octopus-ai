'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { UiMember, UiMessage } from '../../lib/types';
import { RoleBadge } from './ui';
import { OctopusMark } from './icons';
import { PlanCard } from './PlanCard';
import { ArtifactCard } from './ArtifactCard';
import { ReplanCard } from './ReplanCard';
import { CampaignCard } from './CampaignCard';

interface Props {
  channelName: string | null;
  messages: UiMessage[];
  membersById: Record<string, UiMember>;
  /** Whether the viewer owns this workspace, which is what an embed's requiredRole means today. */
  canAct: boolean;
  onEmbedAction: (
    embedId: string,
    action: 'approve' | 'request_changes',
    note?: string,
    /** Only a campaign card sends one. The route refuses it on any other component. */
    budgetCap?: number,
  ) => Promise<void>;
}

/** Author identity for a message whose sender is not in the member list. */
const AGENT: UiMember = {
  id: 'agent',
  name: 'Octopus',
  role: 'agent',
  presence: 'online',
  initials: 'OC',
  expiresAt: null,
};

function authorOf(m: UiMessage, membersById: Record<string, UiMember>): UiMember {
  if (m.authorKind === 'agent') return AGENT;
  if (m.authorId && membersById[m.authorId]) return membersById[m.authorId] as UiMember;
  // A former member still owns their messages; render them rather than hiding
  // history when someone's access is offboarded.
  return {
    id: m.authorId ?? 'unknown',
    name: 'Former member',
    role: 'member',
    presence: 'offline',
    initials: '··',
    expiresAt: null,
  };
}

/** Treat the reader as "following" if they are within this many px of the end. */
const PINNED_THRESHOLD_PX = 80;

export function MessageStream({
  channelName,
  messages,
  membersById,
  canAct,
  onEmbedAction,
}: Props) {
  const streamRef = useRef<HTMLDivElement>(null);
  // Start pinned: a freshly opened room should show the newest message.
  const pinnedRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceFromBottom < PINNED_THRESHOLD_PX;
  }, []);

  const newest = messages[messages.length - 1]?.id;

  useEffect(() => {
    const el = streamRef.current;
    // Only follow if the reader is already at the bottom. Yanking someone who
    // scrolled up to read history is worse than missing the newest line.
    if (!el || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [newest, messages.length]);

  return (
    <div className="stream" ref={streamRef} onScroll={onScroll}>
      <div className="stream-intro">
        <h2 className="display">{channelName ? `#${channelName}` : 'Workspace'}</h2>
        <p>
          This is where Octopus plans your growth. Nothing goes live (no spend, no publishing)
          without your approval.
        </p>
      </div>

      {messages.length === 0 && (
        <div className="stream-empty">No messages in this room yet. Say something to start.</div>
      )}

      {messages.map((m, i) => {
        if (m.authorKind === 'system') {
          return (
            <div className="msg-system" key={m.id} style={{ animationDelay: `${i * 40}ms` }}>
              <span>
                <OctopusMark width={13} height={13} /> {m.body}
              </span>
            </div>
          );
        }

        const author = authorOf(m, membersById);

        return (
          <div
            className={`msg ${author.role}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}`}
            key={m.id}
            style={{ animationDelay: `${i * 40}ms` }}
          >
            <div className="msg-avatar" aria-hidden>
              {author.initials}
            </div>
            <div>
              <div className="msg-head">
                <span className="msg-author">{author.name}</span>
                <RoleBadge role={author.role} />
                <span className="msg-time mono">{m.ts}</span>
                {/* Status is never colour alone. */}
                {m.pending && <span className="msg-state mono">sending</span>}
                {m.failed && <span className="msg-state mono failed">not sent</span>}
              </div>
              {m.body && <div className="msg-text">{m.body}</div>}
              {/* The card is an enhancement of a readable message, never a
                  replacement for one: the body above still carries the plan in
                  plain text wherever this does not render. */}
              {m.embed?.component === 'plan' && (
                <PlanCard embed={m.embed} canAct={canAct} onAct={onEmbedAction} />
              )}
              {m.embed?.component === 'artifact' && <ArtifactCard embed={m.embed} />}
              {m.embed?.component === 'replan' && (
                <ReplanCard embed={m.embed} canAct={canAct} onAct={onEmbedAction} />
              )}
              {m.embed?.component === 'campaign' && (
                <CampaignCard embed={m.embed} canAct={canAct} onAct={onEmbedAction} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
