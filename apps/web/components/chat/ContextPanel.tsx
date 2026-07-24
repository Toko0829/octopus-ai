import type { CSSProperties } from 'react';
import type { Member, PlanCardData, Role } from '../../lib/types';
import { RoleBadge } from './ui';
import { IconLink } from './icons';

function avatarBg(role: Role): CSSProperties {
  const map: Record<Role, string> = {
    you: 'linear-gradient(160deg,var(--ink-500),var(--ink-700))',
    agent: 'linear-gradient(160deg,var(--teal-400),var(--teal-600))',
    node: 'linear-gradient(160deg,var(--coral-400),var(--coral-600))',
    pro: 'linear-gradient(160deg,var(--coral-400),var(--coral-600))',
    admin: 'linear-gradient(160deg,var(--ink-400),var(--ink-600))',
  };
  return { background: map[role] };
}

interface Props {
  members: Member[];
  plan?: PlanCardData;
}

export function ContextPanel({ members, plan }: Props) {
  return (
    <aside className="context">
      <div className="ctx-label">In this channel</div>
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
            {m.activity && <div className="member-activity">{m.activity}</div>}
          </div>
        </div>
      ))}

      {plan && (
        <>
          <div className="ctx-label">Plan sources</div>
          {plan.citations.map((c) => (
            <div className="ctx-source" key={c.id}>
              <div className="ctx-source-title">
                <IconLink width={13} height={13} />
                {c.label}
              </div>
              <div className="ctx-source-meta">
                {c.source} · verified {c.verified}
              </div>
            </div>
          ))}
        </>
      )}
    </aside>
  );
}
