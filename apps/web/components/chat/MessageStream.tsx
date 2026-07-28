import type { Member, Message } from '../../lib/types';
import { RoleBadge } from './ui';
import { PlanCard } from './PlanCard';
import { OctopusMark } from './icons';

interface Props {
  messages: Message[];
  membersById: Record<string, Member>;
  onApprove: (id: string) => void;
  onRequestChanges: (id: string) => void;
}

export function MessageStream({ messages, membersById, onApprove, onRequestChanges }: Props) {
  return (
    <div className="stream">
      <div className="stream-intro">
        <h2 className="display"># brief</h2>
        <p>
          This is where Octopus plans your growth. State a goal and it drafts a cited, full-funnel
          plan. Nothing goes live (no spend, no publishing) until you approve.
        </p>
      </div>

      {messages.map((m, i) => {
        if (m.kind === 'system') {
          return (
            <div className="msg-system" key={m.id} style={{ animationDelay: `${i * 60}ms` }}>
              <span>
                <OctopusMark width={13} height={13} /> {m.body}
              </span>
            </div>
          );
        }

        const author = membersById[m.authorId];
        if (!author) return null;

        return (
          <div
            className={`msg ${author.role}`}
            key={m.id}
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="msg-avatar" aria-hidden>
              {author.initials}
            </div>
            <div>
              <div className="msg-head">
                <span className="msg-author">{author.name}</span>
                <RoleBadge role={author.role} />
                {m.streaming && <span className="pulse" aria-label="working" />}
                <span className="msg-time mono">{m.ts}</span>
              </div>
              {m.body && <div className="msg-text">{m.body}</div>}
              {m.kind === 'plan' && m.plan && (
                <PlanCard
                  plan={m.plan}
                  state={m.planState}
                  onApprove={() => onApprove(m.id)}
                  onRequestChanges={() => onRequestChanges(m.id)}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
