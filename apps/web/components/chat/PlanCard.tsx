/**
 * The full-funnel plan card: the marquee surface in docs/20-design/design-system.md.
 *
 * Renders an `action_embeds` row of component `plan`, produced by the
 * `grounded-plan-v1` core. Three rules this component exists to hold:
 *
 * **All six stages render, always.** A stage with no steps is meaningful output,
 * not absent output: it says the corpus had nothing in scope. Hiding it would
 * read as "this plan has four parts" rather than "two stages are unsupported",
 * and the second is what the reader needs in order to judge the plan.
 *
 * **A step with no citation is marked, not styled identically.** Uncited claims
 * cannot gate action (AGENTS.md rule 10), so the card must not let one pass as
 * grounded.
 *
 * **Nothing is shown that the planner did not produce.** The earlier draft of
 * this card displayed an estimated cost and timeline; those came from mock data,
 * and rendering invented figures on a surface whose whole purpose is to be
 * checkable would undo the grounding it advertises.
 *
 * Approve / request-changes appear only for the owner, and only while the card
 * is pending. The server re-checks both; hiding them is presentation, not the
 * control, and a viewer who cannot act should not be shown a button that will
 * refuse them.
 */
'use client';

import { useState } from 'react';
import type { ActionEmbed, FunnelStage, PlanStep, StepOwner } from '@octopus/contracts';

const ownerMeta: Record<StepOwner, { cls: string; label: string }> = {
  AI: { cls: 'owner-ai', label: 'AI' },
  HUMAN: { cls: 'owner-human', label: 'Human' },
  YOU: { cls: 'owner-you', label: 'You' },
};

const stageLabels: Record<FunnelStage, string> = {
  strategy: 'Strategy',
  content: 'Content',
  creative: 'Creative',
  channels: 'Channels',
  conversion: 'Conversion',
  measurement: 'Measurement',
};

interface Props {
  embed: ActionEmbed;
  /** True when the viewer owns the workspace, which is what `requiredRole` means today. */
  canAct: boolean;
  onAct: (embedId: string, action: 'approve' | 'request_changes', note?: string) => Promise<void>;
}

function Step({ step, sources }: { step: PlanStep; sources: string[] }) {
  const owner = ownerMeta[step.owner];
  // Indices are 1-based and were range-checked server-side, but the lookup still
  // guards: a card is the wrong place to discover a bad index.
  const cited = step.citations.map((n) => sources[n - 1]).filter(Boolean);

  return (
    <li className="plan-step">
      <div className="stage-title">
        {step.title}
        <span className={`owner ${owner.cls}`}>{owner.label}</span>
      </div>
      <div className="stage-detail">{step.detail}</div>
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

export function PlanCard({ embed, canAct, onAct }: Props) {
  const plan = embed.payload;
  const sources = plan.citations.map((c) => c.label);
  const covered = plan.stages.filter((s) => s.steps.length > 0).length;

  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pending = embed.state === 'pending';
  const approved = embed.state === 'approved';

  async function act(action: 'approve' | 'request_changes') {
    setBusy(true);
    setError(null);
    try {
      await onAct(embed.id, action, action === 'request_changes' ? note.trim() : undefined);
    } catch (err) {
      // Keep the note on screen: it is the person's writing, and discarding it
      // on a failed submit is the fastest way to lose their trust in the button.
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
          Full-funnel plan · draft
        </div>
        <h3 className="plan-title display">{plan.title}</h3>
        <p className="plan-goal">{plan.summary}</p>
      </div>

      <div className="plan-stages">
        {plan.stages.map((stage, i) => (
          <div className="stage" key={stage.stage} style={{ animationDelay: `${120 + i * 70}ms` }}>
            <div className="stage-num mono">{String(i + 1).padStart(2, '0')}</div>
            <div className="stage-body">
              <div className="stage-name">{stageLabels[stage.stage]}</div>
              {stage.steps.length > 0 ? (
                <ul className="plan-steps">
                  {stage.steps.map((step) => (
                    <Step key={step.title} step={step} sources={sources} />
                  ))}
                </ul>
              ) : (
                <div className="stage-empty">
                  No sources cover this stage yet, so there is nothing to plan here.
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="plan-sources">
        <div className="plan-sources-label">Grounded in</div>
        <div className="cites">
          {plan.citations.map((c, i) => (
            <span
              className="cite"
              key={c.sourceId}
              title={c.effectiveDate ? `effective ${c.effectiveDate}` : undefined}
            >
              <span className="dot" aria-hidden />
              <span className="mono">[{i + 1}]</span> {c.label}
            </span>
          ))}
        </div>
      </div>

      {/* State is text, never colour alone (design-system.md). */}
      {!pending && (
        <div className="plan-approved-banner">
          {approved ? 'Plan approved.' : 'Changes requested.'}
        </div>
      )}

      {pending && canAct && (
        <div className="plan-foot">
          {noteOpen ? (
            <div className="plan-note">
              <label className="auth-label" htmlFor={`note-${embed.id}`}>
                What should change?
              </label>
              <textarea
                id={`note-${embed.id}`}
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
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => act('request_changes')}
                  disabled={busy}
                >
                  {busy ? 'Sending...' : 'Send'}
                </button>
              </div>
            </div>
          ) : (
            <div className="plan-actions">
              <button className="btn btn-ghost" onClick={() => setNoteOpen(true)} disabled={busy}>
                Request changes
              </button>
              <button className="btn btn-primary" onClick={() => act('approve')} disabled={busy}>
                {busy ? 'Saving...' : 'Approve plan'}
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

      <div className="plan-verified">
        {covered} of 6 stages covered · informational, not financial advice
      </div>
    </div>
  );
}
