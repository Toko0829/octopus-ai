import { IconHash } from './icons';
import { ThemeToggle } from './ui';

interface Props {
  channel: string;
  topic: string;
  budgetUsed: string;
  budgetCeiling: string;
}

export function TopBar({ channel, topic, budgetUsed, budgetCeiling }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-chan">
        <span className="chan-glyph">
          <IconHash width={15} height={15} />
        </span>
        {channel}
      </div>
      <div className="topbar-divider" />
      <div className="topbar-topic">{topic}</div>
      <div className="topbar-spacer" />
      <div className="budget mono">
        planned <b>{budgetUsed}</b> / {budgetCeiling}
      </div>
      <ThemeToggle />
    </header>
  );
}
