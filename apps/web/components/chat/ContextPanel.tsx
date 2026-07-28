import type { CSSProperties } from 'react';
import type { Role, UiMember } from '../../lib/types';
import { RoleBadge } from './ui';

function avatarBg(role: Role): CSSProperties {
  const map: Record<Role, string> = {
    you: 'linear-gradient(160deg,var(--ink-500),var(--ink-700))',
    member: 'linear-gradient(160deg,var(--ink-400),var(--ink-600))',
    agent: 'linear-gradient(160deg,var(--teal-400),var(--teal-600))',
    node: 'linear-gradient(160deg,var(--coral-400),var(--coral-600))',
    pro: 'linear-gradient(160deg,var(--coral-400),var(--coral-600))',
    admin: 'linear-gradient(160deg,var(--ink-400),var(--ink-600))',
  };
  return { background: map[role] };
}

/**
 * Members panel. Presence comes from Realtime Presence, so it reflects who is
 * actually subscribed right now.
 *
 * The "Plan sources" section is intentionally absent: citations come from the
 * planner, which lands in Phase 2 (docs/10-architecture/roadmap.md).
 */
export function ContextPanel({ members }: { members: UiMember[] }) {
  return (
    <aside className="context">
      <div className="ctx-label">In this room</div>
      {members.length === 0 && <div className="ctx-empty">No members loaded.</div>}
      {members.map((m) => (
        <div className="member" key={m.id}>
          <div className="member-av" style={avatarBg(m.role)}>
            {m.initials}
            <span className={`presence ${m.presence}`} aria-hidden />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="member-name">
              {m.name}
              <RoleBadge role={m.role} />
            </div>
            <div className="member-activity">
              {m.presence === 'online' ? 'Online' : 'Offline'}
              {m.expiresAt ? ` · access until ${new Date(m.expiresAt).toLocaleDateString()}` : ''}
            </div>
          </div>
        </div>
      ))}
    </aside>
  );
}
