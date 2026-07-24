import type { PlanCardData, TaskOwner } from '../../lib/types';
import { IconCheck, IconEdit, IconRefresh } from './icons';

const ownerMeta: Record<TaskOwner, { cls: string; label: string }> = {
  AI: { cls: 'owner-ai', label: 'AI' },
  HUMAN: { cls: 'owner-human', label: 'Human' },
  YOU: { cls: 'owner-you', label: 'You' },
};

interface Props {
  plan: PlanCardData;
  state?: 'pending' | 'approved' | 'changes';
  onApprove: () => void;
  onRequestChanges: () => void;
}

export function PlanCard({ plan, state = 'pending', onApprove, onRequestChanges }: Props) {
  const approved = state === 'approved';
  return (
    <div className={`plan${approved ? ' approved' : ''}`}>
      <div className="plan-top">
        <div className="plan-eyebrow">
          <span className="pulse" aria-hidden />
          Full-funnel plan · draft
        </div>
        <h3 className="plan-title display">{plan.title}</h3>
        <p className="plan-goal">{plan.goal}</p>
      </div>

      {approved && (
        <div className="plan-approved-banner">
          <IconCheck width={15} height={15} />
          Plan approved — I’ll start the AI-owned steps and line up the human ones.
        </div>
      )}

      <div className="plan-stages">
        {plan.stages.map((s, i) => {
          const o = ownerMeta[s.owner];
          return (
            <div className="stage" key={s.id} style={{ animationDelay: `${120 + i * 70}ms` }}>
              <div className="stage-num mono">{String(i + 1).padStart(2, '0')}</div>
              <div>
                <div className="stage-title">
                  {s.title}
                  <span className={`owner ${o.cls}`}>{o.label}</span>
                </div>
                <div className="stage-detail">{s.detail}</div>
              </div>
              {s.metric && <div className="stage-metric">{s.metric}</div>}
            </div>
          );
        })}
      </div>

      <div className="plan-sources">
        <div className="plan-sources-label">Grounded in</div>
        <div className="cites">
          {plan.citations.map((c) => (
            <span className="cite" key={c.id} title={`verified ${c.verified}`}>
              <span className="dot" aria-hidden />
              {c.label}
              <span className="cite-src">· {c.source}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="plan-foot">
        <div className="plan-meta">
          <span>
            est. <b>{plan.estCost}</b>
          </span>
          <span>
            timeline <b>{plan.estTimeline}</b>
          </span>
        </div>
        {!approved && (
          <div className="plan-actions">
            <button className="btn btn-ghost" onClick={onRequestChanges}>
              <IconRefresh width={14} height={14} />
              Request changes
            </button>
            <button className="btn btn-ghost" onClick={onRequestChanges} aria-label="Edit plan">
              <IconEdit width={14} height={14} />
              Edit
            </button>
            <button className="btn btn-primary" onClick={onApprove}>
              <IconCheck width={14} height={14} />
              Approve plan
            </button>
          </div>
        )}
      </div>
      <div className="plan-verified">{plan.verified} · informational, not financial advice</div>
    </div>
  );
}
