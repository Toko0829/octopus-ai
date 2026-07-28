import type { UiBusiness, UiChannel, UiMember } from '../../lib/types';
import { IconHash, IconTopic } from './icons';
import { SignOutButton } from './SignOutButton';

interface Props {
  business: UiBusiness;
  channels: UiChannel[];
  activeId: string | null;
  onSelect: (id: string) => void;
  viewer: UiMember | null;
  viewerEmail: string | null;
}

export function ChannelSidebar({
  business,
  channels,
  activeId,
  onSelect,
  viewer,
  viewerEmail,
}: Props) {
  const bySection = new Map<string, UiChannel[]>();
  const order: string[] = [];
  for (const c of channels) {
    if (!bySection.has(c.section)) {
      bySection.set(c.section, []);
      order.push(c.section);
    }
    bySection.get(c.section)!.push(c);
  }

  const label = viewer?.name ?? viewerEmail ?? 'Signed in';
  const initials = viewer?.initials ?? (viewerEmail?.[0] ?? '?').toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">{business.name}</div>
        <div className="sidebar-sub">Workspace</div>
      </div>

      <div className="chan-list">
        {channels.length === 0 && <div className="chan-empty">No channels in this room yet.</div>}
        {order.map((section) => (
          <div key={section}>
            <div className="chan-section">{section}</div>
            {bySection.get(section)!.map((c) => (
              <button
                key={c.id}
                className={`chan${c.id === activeId ? ' active' : ''}`}
                onClick={() => onSelect(c.id)}
                aria-current={c.id === activeId}
              >
                <span className="chan-glyph">
                  {c.kind === 'topic' ? (
                    <IconTopic width={15} height={15} />
                  ) : (
                    <IconHash width={15} height={15} />
                  )}
                </span>
                <span className="chan-name">{c.name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <div
          className="member-av"
          style={{
            width: 26,
            height: 26,
            background: 'linear-gradient(160deg,var(--ink-500),var(--ink-700))',
          }}
        >
          {initials}
        </div>
        <div className="sidebar-foot-name">{label}</div>
        <SignOutButton className="sidebar-signout" />
      </div>
    </aside>
  );
}
