import { IconHash } from './icons';
import { ThemeToggle } from './ui';

interface Props {
  channel: string;
  memberCount: number;
}

/**
 * The spec puts live budget here (docs/20-design/discord-chat-spec.md). It is
 * omitted until projects carry a budget ceiling, because a number on a trust
 * surface has to be real.
 */
export function TopBar({ channel, memberCount }: Props) {
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
      <ThemeToggle />
    </header>
  );
}
