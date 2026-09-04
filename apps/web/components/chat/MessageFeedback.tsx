'use client';

import { useState } from 'react';
import { labelMessage } from '../../lib/api-client';

/**
 * Helpful or not, on an answer a model wrote.
 *
 * **Only on the one output whose quality rests on the model.** Every other thing
 * the agent produces arrives on a card, and a card already has a verdict:
 * approve or request changes, which is a decision about the work rather than an
 * opinion about the writer. What is left is the ungrounded fallback tier
 * (ADR-0021), which answers in prose, carries no card by construction, and is
 * the one reply where the corpus contributed nothing and the model is the whole
 * of the answer. The stream renders this control exactly there, and the route
 * refuses it everywhere else whatever the page decides to show.
 *
 * **The label is evidence, not a lever.** It lands in `feedback_events` beside
 * the card verdicts and is joined to `messages.model` to give a per-provider
 * rate. Nothing trains on it, nothing ingests the answer it labels, and no
 * routing changes because of it: Auto chosen from label rates is named and not
 * built, and it needs enough labels per provider to rank them before it could
 * mean anything (ADR-0032 decision 3).
 *
 * **Local state only, and the reload behaviour is stated rather than hidden.**
 * A label is not fetched back onto the message, so reloading the page shows the
 * buttons again and a second label is recorded rather than replacing the first.
 * That is the append-only table doing what it says: the row carries the moment
 * somebody judged the answer, and two judgements are two facts. Reading the
 * latest one back onto the stream is named-not-built.
 */
export function MessageFeedback({ roomId, messageId }: { roomId: string; messageId: string }) {
  const [verdict, setVerdict] = useState<'helpful' | 'not_helpful' | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function label(next: 'helpful' | 'not_helpful') {
    setBusy(true);
    setError(null);
    setVerdict(next);
    try {
      await labelMessage(roomId, messageId, { verdict: next });
      setDone(true);
    } catch (err) {
      // The buttons stay. A failed label that silently looked recorded would be
      // the worst outcome here: the whole point of the control is that somebody
      // believes their answer went somewhere.
      setVerdict(null);
      setError(err instanceof Error ? err.message : 'Could not record that.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="msg-feedback-done">Recorded. Thank you.</p>;
  }

  return (
    <div className="msg-feedback">
      <div className="chip-group" role="group" aria-label="Was this answer helpful">
        <button
          type="button"
          className="chip"
          aria-pressed={verdict === 'helpful'}
          disabled={busy}
          onClick={() => void label('helpful')}
        >
          Helpful
        </button>
        <button
          type="button"
          className="chip"
          aria-pressed={verdict === 'not_helpful'}
          disabled={busy}
          onClick={() => void label('not_helpful')}
        >
          Not helpful
        </button>
      </div>
      {error && (
        <p className="msg-feedback-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
