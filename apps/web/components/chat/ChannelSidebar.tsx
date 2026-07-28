import type { Business, Channel } from '../../lib/types';
import { IconHash, IconTopic } from './icons';

interface Props {
  business: Business;
  channels: Channel[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function ChannelSidebar({ business, channels, activeId, onSelect }: Props) {
  const bySection = new Map<string, Channel[]>();
  const order: string[] = [];
  for (const c of channels) {
    if (!bySection.has(c.section)) {
      bySection.set(c.section, []);
      order.push(c.section);
    }
    bySection.get(c.section)!.push(c);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-title">{business.name}</div>
        <div className="sidebar-sub">Grow · full-funnel</div>
      </div>

      <div className="chan-list">
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
                {c.unread ? <span className="chan-unread mono">{c.unread}</span> : null}
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
          MA
        </div>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 500 }}>Maya</div>
      </div>
    </aside>
  );
}
