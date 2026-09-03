/**
 * The question card: what would make the plan sharper, answered on the card.
 *
 * Renders an `action_embeds` row of component `question`. Two kinds of card
 * share the shape. Intake writes one before a whole-funnel goal is planned,
 * asking for the slots the playbook needs (`awaiting: 'answers'`); the plan
 * writes one when a step needs a decision only the owner can make
 * (`awaiting: 'task_answers'`).
 *
 * Three rules this component exists to hold.
 *
 * **Each answer is its own act.** The questions used to be plain text, answered
 * by typing everything into one chat message that a model then parsed back into
 * slots. A budget band is a choice, not a sentence, so it is a row of chips; an
 * audience is a phrase, so it is a short field with its own Save. Nothing here
 * asks the person to compose a paragraph, and nothing is submitted for them
 * until they press the control for it.
 *
 * **A guess is marked as a guess.** A slot the model inferred is shown with the
 * value and the word "guess", and the control stays open so it can be corrected.
 * A wrong inference about somebody's business shapes a plan they act on, and
 * rendering it the same as something they said would attribute it to them.
 *
 * **State is a word, never a colour.** Saved, guess, recorded, closed: each is
 * text beside the value, so somebody who cannot tell the tints apart reads the
 * same thing.
 *
 * The controls appear only for the owner and only while the card is pending.
 * The server re-checks both on the action route; hiding them is presentation,
 * not the control.
 */
'use client';

import { useState } from 'react';
import {
  BUDGET_BAND_LABELS,
  BudgetBand,
  TIMELINE_LABELS,
  Timeline,
  type EmbedActionBody,
  type EmbedActionResponse,
  type IntakeSlot,
  type IntakeSlotKey,
  type QuestionActionEmbed,
} from '@octopus/contracts';

interface Props {
  embed: QuestionActionEmbed;
  /** True when the viewer owns the workspace. The server re-checks. */
  canAct: boolean;
  onAct: (embedId: string, input: EmbedActionBody) => Promise<EmbedActionResponse>;
}

/** What each slot is called when the card refers to it without a question. */
const slotLabels: Record<IntakeSlotKey, string> = {
  icp: 'Who it is for',
  offer: 'What you sell',
  target_metric: 'What you are measuring',
  budget_band: 'Budget',
  timeline: 'Timeline',
};

/** The chip slots, and the vocabulary for each. Defined once, in the contract. */
const chipOptions: Partial<Record<IntakeSlotKey, { value: string; label: string }[]>> = {
  budget_band: BudgetBand.options.map((value) => ({ value, label: BUDGET_BAND_LABELS[value] })),
  timeline: Timeline.options.map((value) => ({ value, label: TIMELINE_LABELS[value] })),
};

/** A stored chip value rendered as its label; anything else as itself. */
function display(slot: IntakeSlotKey, value: string): string {
  const options = chipOptions[slot];
  return options?.find((o) => o.value === value)?.label ?? value;
}

function SlotControl({
  embedId,
  slot,
  question,
  current,
  canAct,
  pending,
  onAct,
}: {
  embedId: string;
  slot: IntakeSlotKey;
  question: string;
  current: IntakeSlot | undefined;
  canAct: boolean;
  pending: boolean;
  onAct: Props['onAct'];
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = chipOptions[slot];
  const open = pending && canAct;

  async function save(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onAct(embedId, { action: 'answer', slot, value: trimmed });
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="q-item">
      <div className="q-label">{question}</div>

      {/* What is already known for this slot, and where it came from. */}
      {current && (
        <div className="q-current">
          <span className="q-value">{display(slot, current.value)}</span>
          <span className="q-state mono">{current.source === 'stated' ? 'saved' : 'my guess'}</span>
        </div>
      )}

      {open && options ? (
        <div className="chip-group" role="group" aria-label={slotLabels[slot]}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="chip"
              aria-pressed={current?.value === option.value}
              disabled={busy}
              onClick={() => save(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      {open && !options ? (
        <form
          className="q-row"
          onSubmit={(e) => {
            e.preventDefault();
            void save(text);
          }}
        >
          <label className="sr-only" htmlFor={`q-${embedId}-${slot}`}>
            {slotLabels[slot]}
          </label>
          <input
            id={`q-${embedId}-${slot}`}
            className="auth-input"
            type="text"
            maxLength={400}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={current ? 'Correct it here' : 'A few words is enough'}
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Saving' : 'Save'}
          </button>
        </form>
      ) : null}

      {error ? (
        <div className="auth-msg" data-tone="error" role="status">
          Problem: {error}
        </div>
      ) : null}
    </li>
  );
}

function TaskControl({
  embedId,
  taskId,
  title,
  recorded,
  canAct,
  pending,
  onAct,
}: {
  embedId: string;
  taskId: string;
  title: string;
  recorded: string | undefined;
  canAct: boolean;
  pending: boolean;
  onAct: Props['onAct'];
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = pending && canAct && recorded === undefined;

  async function save() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onAct(embedId, { action: 'answer', taskId, value: trimmed });
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="q-item">
      <div className="q-label">{title}</div>
      {recorded !== undefined && (
        <div className="q-current">
          <span className="q-value">{recorded}</span>
          <span className="q-state mono">recorded</span>
        </div>
      )}
      {open ? (
        <form
          className="q-row"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="sr-only" htmlFor={`q-${embedId}-${taskId}`}>
            {title}
          </label>
          <input
            id={`q-${embedId}-${taskId}`}
            className="auth-input"
            type="text"
            maxLength={400}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What you decided"
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>
            {busy ? 'Recording' : 'Record'}
          </button>
        </form>
      ) : null}
      {error ? (
        <div className="auth-msg" data-tone="error" role="status">
          Problem: {error}
        </div>
      ) : null}
    </li>
  );
}

/** Closed states, each as a sentence. */
const closedCopy: Record<string, string> = {
  answered: 'Answered. I am planning with what you said.',
  dismissed: 'Closed: you started on something else.',
  expired: 'Closed.',
};

export function QuestionCard({ embed, canAct, onAct }: Props) {
  const q = embed.payload;
  const pending = embed.state === 'pending';
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  // A card left over from before answers moved onto the card. The message body
  // above it already carries the words; there is nothing here to answer.
  if (q.awaiting === 'goal') {
    return (
      <div className="plan q-card">
        <div className="plan-foot">
          <div className="step-uncited">
            Just say what you want to grow, and I will take it from there.
          </div>
        </div>
      </div>
    );
  }

  const bySlot = new Map(q.slots.map((s) => [s.key, s] as const));

  if (q.awaiting === 'task_answers') {
    const tasks = q.tasks ?? q.taskIds.map((id) => ({ id, title: 'A step of the plan' }));
    const recorded = q.taskAnswers ?? {};
    // A card written before titles rode on it cannot label its fields, and a
    // field with no name is not something a person can answer honestly. The
    // panel names every step, so the card points there instead.
    const answerable = q.tasks !== undefined;
    return (
      <div className="plan q-card">
        <div className="plan-top">
          <div className="plan-eyebrow">
            <span className="pulse" aria-hidden />
            {tasks.length === 1 ? 'One step needs you' : `${tasks.length} steps need you`}
          </div>
        </div>
        <ul className="q-list">
          {tasks.map((task) => (
            <TaskControl
              key={task.id}
              embedId={embed.id}
              taskId={task.id}
              title={task.title}
              recorded={recorded[task.id]}
              canAct={canAct && answerable}
              pending={pending}
              onAct={onAct}
            />
          ))}
        </ul>
        {!pending && (
          <div className="plan-rejected-banner">{closedCopy[embed.state] ?? 'Closed.'}</div>
        )}
        {pending && !answerable && (
          <div className="plan-foot">
            <div className="step-uncited">Answer these from the project panel.</div>
          </div>
        )}
      </div>
    );
  }

  // Intake. The questions the card asked, then whatever else it already knows.
  const asked = new Set(q.questions.map((question) => question.slot));
  const known = q.slots.filter((s) => !asked.has(s.key));
  const answered = q.questions.filter((question) => bySlot.has(question.slot)).length;

  async function finish() {
    setFinishing(true);
    setFinishError(null);
    try {
      await onAct(embed.id, { action: 'finish' });
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : 'Could not close this. Try again.');
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="plan q-card">
      <div className="plan-top">
        <div className="plan-eyebrow">
          <span className="pulse" aria-hidden />
          Questions · sharpen the plan
        </div>
        <p className="plan-goal">
          Answer in any order. Each one is saved as you go, and I plan with whatever you give me.
        </p>
      </div>

      <ul className="q-list">
        {q.questions.map((question) => (
          <SlotControl
            key={question.slot}
            embedId={embed.id}
            slot={question.slot}
            question={question.question}
            current={bySlot.get(question.slot)}
            canAct={canAct}
            pending={pending}
            onAct={onAct}
          />
        ))}
      </ul>

      {known.length > 0 && (
        <div className="plan-sources">
          <div className="plan-sources-label">What I already have</div>
          <ul className="q-known">
            {known.map((s) => (
              <li key={s.key}>
                <span className="q-known-key">{slotLabels[s.key]}</span> {display(s.key, s.value)}{' '}
                <span className="q-state mono">{s.source === 'stated' ? 'saved' : 'my guess'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!pending && (
        <div className="plan-approved-banner">{closedCopy[embed.state] ?? 'Closed.'}</div>
      )}

      {pending && canAct && (
        <div className="plan-foot">
          <div className="plan-meta">
            <span>
              <b>{answered}</b> of {q.questions.length} answered
            </span>
          </div>
          <div className="plan-actions">
            <button className="btn btn-ghost" onClick={() => void finish()} disabled={finishing}>
              {finishing ? 'Closing' : 'Plan with what I have said'}
            </button>
          </div>
          {finishError ? (
            <div className="auth-msg" data-tone="error" role="status">
              Problem: {finishError}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
