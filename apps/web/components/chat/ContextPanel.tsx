import type { CSSProperties } from 'react';
import type { ModelSettingsResponse } from '@octopus/contracts';
import type { Role, UiMember, UiPersona } from '../../lib/types';
import { RoleBadge } from './ui';
import { ConnectedAccounts } from './ConnectedAccounts';
import { ModelSettings } from './ModelSettings';

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
 * The room rail: who is here, and what this workspace is connected to.
 *
 * Presence comes from Realtime Presence, so it reflects who is actually
 * subscribed right now.
 *
 * **Connected accounts lives here, and it started out in the wrong place.** It
 * was first built into the project panel, which was structurally defensible
 * (connections are room-scoped and that panel is the only other room-scoped
 * surface) and wrong in practice for a reason the structure hid: that panel is
 * called "The work", it opens as a modal from the top bar, and nobody looking
 * for account settings opens it. The first person to use the feature could not
 * find it. Putting it behind a project view also implies a connection belongs to
 * a project, which is the exact impression the room-scoping exists to avoid.
 *
 * This rail is the room's own column, always visible, already holding the other
 * room-level fact (who is in it). An account the workspace is connected to is
 * the same kind of fact.
 *
 * The "Plan sources" section is intentionally absent: citations come from the
 * planner, which lands in Phase 2 (docs/10-architecture/roadmap.md).
 */
export function ContextPanel({
  members,
  personas,
  roomId,
  canAct,
  models,
  modelsError,
  onModelsChanged,
}: {
  members: UiMember[];
  /**
   * The four agent voices. Passed in rather than built here, because what each
   * one is doing is derived from the project list `ChatApp` already holds.
   */
  personas: UiPersona[];
  roomId: string;
  canAct: boolean;
  /**
   * The room's model settings, held by `ChatApp` rather than fetched here.
   *
   * One read serves two renderers: the Models block edits it, and the line under
   * each voice reports it. Fetching it twice would let one half of this panel
   * disagree with the other for as long as the second request took to land.
   */
  models: ModelSettingsResponse | null;
  modelsError: string | null;
  onModelsChanged: () => void;
}) {
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

      {/*
        The agent's own group, below the people.

        **These are not members and the panel does not pretend they are.** They
        hold no `room_members` row, have no user id and never go offline;
        `room_members.user_id` is a foreign key to `auth.users`, so putting the
        AI in the roster would mean giving it credentials, which is a larger
        decision than a name in a list (ADR-0031). Rendering them as their own
        group says what is true: four voices that always answer, beside the
        people who may not be here.

        The pulse is the one reserved use of glow (AGENTS.md rule 14) and it
        means exactly what it has always meant: the agent is doing something
        right now. The activity line carries the same fact in words, so the
        state never rests on colour or motion alone (rule 15).
      */}
      <div className="ctx-label ctx-label-agents">Octopus</div>
      {personas.map((p) => (
        <div className="member" key={p.id}>
          <div className="member-av" style={avatarBg('agent')}>
            {p.initials}
            <span className={`presence ${p.working ? 'working' : 'online'}`} aria-hidden />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="member-name">
              {p.name}
              <RoleBadge role="agent" />
            </div>
            <div className="member-activity">{p.activity ?? p.summary}</div>
            {/* Which model composes this voice's proposals.

                A second line rather than more text on the activity line, which
                is a single-line ellipsis and would swallow whichever of the two
                facts came second. It is a statement about the route as it stands
                now, not about the run beside it: a proposal already in flight
                keeps the model it started on. */}
            <div className="member-model mono">Runs on {p.runsOn}</div>
          </div>
        </div>
      ))}

      <ModelSettings
        roomId={roomId}
        canAct={canAct}
        settings={models}
        error={modelsError}
        onChanged={onModelsChanged}
      />

      <ConnectedAccounts roomId={roomId} canAct={canAct} />
    </aside>
  );
}
