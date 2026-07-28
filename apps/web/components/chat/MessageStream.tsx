import type { UiMember, UiMessage } from '../../lib/types';
import { RoleBadge } from './ui';
import { OctopusMark } from './icons';

interface Props {
  channelName: string | null;
  messages: UiMessage[];
  membersById: Record<string, UiMember>;
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

export function MessageStream({ channelName, messages, membersById }: Props) {
  return (
    <div className="stream">
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
