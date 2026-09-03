'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { UiMember, UiMessage } from '../../lib/types';
import { RoleBadge } from './ui';
import { OctopusMark } from './icons';
import { PlanCard } from './PlanCard';
import { ArtifactCard } from './ArtifactCard';
import { ReplanCard } from './ReplanCard';
import { CampaignCard } from './CampaignCard';
import { QuestionCard } from './QuestionCard';
import type { EmbedActionBody, EmbedActionResponse } from '@octopus/contracts';

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
  /**
   * An answer on a question card. Same route as a verdict, different body, and
   * the response carries the card's new payload so it can be patched in place.
   */
  onQuestionAction: (embedId: string, input: EmbedActionBody) => Promise<EmbedActionResponse>;
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

/**
 * An expert working a task thread, when the roster does not name them.
 *
 * **The roster cannot name them, and that is by design rather than a gap to
 * close here.** `room_members_select_member` gives a room-scoped member the
 * room-scoped roster plus their own row, so an admitted node's membership is
 * invisible to the owner: a thread-scoped row is not part of the room's roster.
 * What the owner CAN read is the node's `profiles` row, through the counterparty
 * policy, and where that name belongs is the project panel's engagement line,
 * beside the price and the date it was agreed.
 *
 * So the stream labels the role rather than inventing a name. That is honest and
 * it is also the rule-15 requirement: the badge is a word, so somebody who
 * cannot distinguish the tints reads exactly the same thing.
 */
const HUMAN_NODE: UiMember = {
  id: 'node',
  name: 'Human node',
  role: 'node',
  presence: 'online',
  initials: 'HN',
  expiresAt: null,
};

function authorOf(m: UiMessage, membersById: Record<string, UiMember>): UiMember {
  if (m.authorKind === 'agent') return AGENT;
  if (m.authorId && membersById[m.authorId]) return membersById[m.authorId] as UiMember;
  // An expert admitted to one thread of this room. Checked before the
  // former-member fallback, or every message a node writes would be labelled as
  // written by somebody who has left.
  if (m.authorKind === 'node') return HUMAN_NODE;
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
  onQuestionAction,
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
          This is where Octopus plans your growth. Nothing goes live (no spend, no publishing) until
          you approve it.
        </p>
      </div>

      {messages.length === 0 && (
        <div className="stream-empty">No messages in this room yet. Say something to start.</div>
      )}

      {/*
        **The owner's stream interleaves two conversations from slice 5 on**, and
        the rows are marked rather than filtered.

        A node admitted to a task thread posts into this same room, so messages
        arrive carrying a `threadId` that the room's own conversation does not
        have. Hiding them would be the fetched-never-rendered defect this
        repository has recorded twice, and it would hide work the owner is
        paying for and is entitled to read. Marking them says which conversation
        a line belongs to without pretending the two are one.

        The node reads the mirror image and sees only their own thread, which is
        RLS rather than anything here: `private.member_scope_covers` gives a
        thread-scoped member messages carrying their `thread_id` and never the
        null-thread room stream.
      */}
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
                {/* Which conversation this line belongs to. A word, not a tint. */}
                {m.threadId && <span className="msg-thread mono">in a task thread</span>}
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
              {m.embed?.component === 'question' && (
                <QuestionCard embed={m.embed} canAct={canAct} onAct={onQuestionAction} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
