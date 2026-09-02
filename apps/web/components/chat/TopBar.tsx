import type { ReactNode } from 'react';
import { IconHash } from './icons';
import { ThemeToggle } from './ui';

interface Props {
  channel: string;
  memberCount: number;
  onOpenWork: () => void;
  /**
   * The inbox bell, passed in rather than built here.
   *
   * A slot because the bell needs a live subscription and this component has no
   * state of its own: giving it one would make the whole header re-render on
   * every arriving notification, and the header is the part of this page that
   * must never flicker.
   */
  inbox?: ReactNode;
  /**
   * Steps waiting on the person, across every project in this room. Shown only
   * when it is non-zero: a badge reading 0 is noise, and the point of the number
   * is that it asks for something.
   */
  waitingOnYou: number;
  /**
   * Whether the viewer is also an invited expert. Shows one link and nothing
   * else: their profile is a separate surface because a node is admitted to a
   * task thread rather than to this room.
   */
  isNode: boolean;
}

/**
 * The spec puts live budget here (docs/20-design/discord-chat-spec.md). It is
 * omitted until projects carry a budget ceiling, because a number on a trust
 * surface has to be real.
 */
export function TopBar({ channel, memberCount, onOpenWork, waitingOnYou, isNode, inbox }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-chan">
        <span className="chan-glyph">
          <IconHash width={15} height={15} />
        </span>
        {channel}
      </div>
      <div className="topbar-divider" />
      <div className="topbar-topic mono">
        {memberCount} {memberCount === 1 ? 'member' : 'members'}
      </div>
      <div className="topbar-spacer" />
      <button type="button" className="topbar-work" onClick={onOpenWork}>
        The work
        {waitingOnYou > 0 && (
          <span className="topbar-badge mono">
            {waitingOnYou}
            <span className="sr-only"> steps waiting on you</span>
          </span>
        )}
      </button>
      {isNode && (
        <a className="topbar-work" href="/node">
          Your node profile
        </a>
      )}
      {inbox}
      <ThemeToggle />
    </header>
  );
}
