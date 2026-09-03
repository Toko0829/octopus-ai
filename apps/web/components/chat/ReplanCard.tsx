/**
 * The plan-change card: a diff against a project that is already running.
 *
 * Renders an `action_embeds` row of component `replan`, produced by the
 * `replan-diff-v1` core. Approving it calls `apply_plan_diff`; nothing here
 * applies anything, exactly as the plan card proposes rather than creates.
 *
 * Three rules this component exists to hold.
 *
 * **Every op is shown, and what it does is a word rather than a colour.** A
 * person is being asked to authorise the removal of planned work, so the card
 * cannot summarise: "3 changes" is not something anybody can agree to. Add,
 * cancel and update each carry their own label and their own explanation.
 *
 * **A cancelled step is named.** The op references a task by UUID, and the
 * payload carries the title alongside it precisely so this card never asks
 * somebody to approve `3f2a-...`. When the title is absent, because the card
 * predates it, the id is shown rather than hidden: a reference the reader cannot
 * resolve is still better than a change they cannot see.
 *
 * **An added step is marked when it rests on nothing.** Rule 10 applies to a step
 * added by a diff exactly as it applies to one in the original plan, and this is
 * the same treatment `PlanCard` gives an uncited step.
 */
'use client';

import { useState } from 'react';
import type { ReplanActionEmbed, ReplanOp, StepOwner, TaskRiskTier } from '@octopus/contracts';

const ownerMeta: Record<StepOwner, { cls: string; label: string }> = {
  AI: { cls: 'owner-ai', label: 'AI' },
  HUMAN: { cls: 'owner-human', label: 'Human' },
  YOU: { cls: 'owner-you', label: 'You' },
};

/** Same two tiers `PlanCard` shows, for the same reason: a chip on every step is
 *  a wall of badges that teaches people to stop reading them. */
const riskMeta: Partial<Record<TaskRiskTier, { cls: string; label: string; icon: string }>> = {
  high_risk: { cls: 'risk-high', label: 'Needs your approval', icon: '!' },
  external: { cls: 'risk-external', label: 'Uses an outside service', icon: '↗' },
};

const opMeta = {
  add_step: { label: 'Add', cls: 'diff-add' },
  cancel_task: { label: 'Cancel', cls: 'diff-cancel' },
  modify_task: { label: 'Update', cls: 'diff-modify' },
} as const;

interface Props {
  embed: ReplanActionEmbed;
  /** True when the viewer owns the workspace. The server re-checks; hiding the
   *  buttons is presentation, not the control. */
  canAct: boolean;
  onAct: (embedId: string, action: 'approve' | 'request_changes', note?: string) => Promise<void>;
}

function Op({ op, sources }: { op: ReplanOp; sources: string[] }) {
  const meta = opMeta[op.op];

  if (op.op === 'add_step') {
    const owner = ownerMeta[op.owner];
    const risk = riskMeta[op.riskTier];
    const cited = [...new Set(op.citations.map((n) => sources[n - 1]).filter(Boolean))];

    return (
      <li className="plan-step">
        <div className="stage-title">
          <span className={`diff-op ${meta.cls}`}>{meta.label}</span>
          {op.title}
          <span className={`owner ${owner.cls}`}>{owner.label}</span>
          {risk ? (
            <span className={`risk ${risk.cls}`}>
              <span className="risk-icon" aria-hidden>
                {risk.icon}
              </span>
              {risk.label}
            </span>
          ) : null}
        </div>
        <div className="stage-detail">{op.detail}</div>
        {cited.length > 0 ? (
          <div className="step-cites">
            {cited.map((label) => (
              <span className="cite" key={label}>
                <span className="dot" aria-hidden />
                {label}
              </span>
            ))}
          </div>
        ) : (
          <div className="step-uncited">Not backed by a retrieved source</div>
        )}
      </li>
    );
  }

  // The title is the readable half and the id is the authoritative one, so the
  // id is the fallback rather than something hidden when the title is missing.
  const name = op.taskTitle ?? op.taskId;

  if (op.op === 'cancel_task') {
    return (
      <li className="plan-step">
        <div className="stage-title">
          <span className={`diff-op ${meta.cls}`}>{meta.label}</span>
          <span className="diff-struck">{name}</span>
        </div>
        <div className="stage-detail">{op.reason}</div>
        {/* Stated on the card because it is the consequence people do not expect,
            and finding it out after approving is worse than reading it here. */}
        <div className="step-uncited">
          Anything waiting on this step stays waiting: its result will not exist.
        </div>
      </li>
    );
  }

  return (
    <li className="plan-step">
      <div className="stage-title">
        <span className={`diff-op ${meta.cls}`}>{meta.label}</span>
        {name}
      </div>
      {op.detail ? <div className="stage-detail">{op.detail}</div> : null}
      {op.acceptanceCriteria && op.acceptanceCriteria.length > 0 ? (
        <div className="step-cites">
          {op.acceptanceCriteria.map((c) => (
            <span className="cite" key={c}>
              <span className="dot" aria-hidden />
              {c}
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function ReplanCard({ embed, canAct, onAct }: Props) {
  const diff = embed.payload;
  const sources = diff.citations.map((c) => c.label);

  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pending = embed.state === 'pending';
  const approved = embed.state === 'approved';

  const counts = diff.ops.reduce(
    (acc, op) => ({ ...acc, [op.op]: (acc[op.op] ?? 0) + 1 }),
    {} as Record<ReplanOp['op'], number>,
  );
  const headline = [
    counts.add_step ? `${counts.add_step} added` : null,
    counts.cancel_task ? `${counts.cancel_task} cancelled` : null,
    counts.modify_task ? `${counts.modify_task} updated` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  async function act(action: 'approve' | 'request_changes') {
    setBusy(true);
    setError(null);
    try {
      await onAct(embed.id, action, action === 'request_changes' ? note.trim() : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`plan${approved ? ' approved' : ''}`}>
      <div className="plan-top">
        <div className="plan-eyebrow">
          <span className="pulse" aria-hidden />
          Plan change · {headline}
        </div>
        <p className="plan-goal">{diff.summary}</p>
        {diff.reason ? <p className="plan-goal diff-reason">You asked: {diff.reason}</p> : null}
      </div>

      <div className="plan-stages">
        <div className="stage stage-single">
          <div className="stage-body">
            <ul className="plan-steps">
              {diff.ops.map((op) => (
                <Op
                  key={op.op === 'add_step' ? op.id : `${op.op}:${op.taskId}`}
                  op={op}
                  sources={sources}
                />
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Nothing else on this card changes until it is approved, and saying so is
          the difference between a proposal and a report of something already done. */}
      {pending ? (
        <div className="plan-sources">
          <div className="plan-sources-label">
            Nothing has changed yet. The plan updates when you approve this.
          </div>
        </div>
      ) : null}

      {!pending && (
        <div className={approved ? 'plan-approved-banner' : 'plan-rejected-banner'}>
          {approved ? 'Plan changes applied.' : 'Changes requested.'}
        </div>
      )}

      {pending && canAct && (
        <div className="plan-foot">
          {noteOpen ? (
            <div className="plan-note">
              <label className="auth-label" htmlFor={`replan-note-${embed.id}`}>
                What should change instead?
              </label>
              <textarea
                id={`replan-note-${embed.id}`}
                className="auth-input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="The part that is wrong, and why."
              />
              <div className="plan-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setNoteOpen(false)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => act('request_changes')}
                  disabled={busy || note.trim().length === 0}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="plan-actions">
              <button className="btn btn-ghost" onClick={() => setNoteOpen(true)} disabled={busy}>
                Request changes
              </button>
              <button className="btn btn-primary" onClick={() => act('approve')} disabled={busy}>
                {busy ? 'Applying...' : 'Apply these changes'}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="auth-msg" data-tone="error" role="status">
          Problem: {error}
        </div>
      )}
    </div>
  );
}
