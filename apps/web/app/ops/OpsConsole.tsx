'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DisputeResolution, OpsDisputeDetail, OpsDisputeSummary } from '@octopus/contracts';
import { fetchOpsDispute, listOpsDisputes, resolveOpsDispute } from '../../lib/api-client';

/**
 * The dispute console.
 *
 * **Dark Command Deck**, which is the skin design-system.md names for exactly
 * this surface: "task board, agent run-log, budget ledger, **admin ops**. Dense,
 * hairline-bordered, keyboard-first." It is applied as a subtree rather than by
 * flipping the root, so the two obligations that carries are met in `ops.css`:
 * the wrapper paints its own background and colour, because `body` sits outside
 * it and resolves from `:root`, and it sets `color-scheme` so scrollbars and
 * form controls follow.
 *
 * ---------- What an operator has to be able to see before deciding ----------
 *
 * The layout is a queue beside a detail, and the detail is long on purpose. A
 * dispute is decided on facts held in six places, and a console that made
 * somebody open a second tab to check any of them would be a console that
 * encourages deciding without checking:
 *
 *   * the grievance, and which side raised it;
 *   * where the step was when it was raised, because a resolution is unreadable
 *     without it and `rejection_upheld` is only legal from one of them;
 *   * both parties by name;
 *   * every escrow hold on the step and its state, including one a previous
 *     partial settlement minted;
 *   * the ledger entries behind them, which is the arithmetic;
 *   * the thread roster **including ended memberships**, because access is
 *     stamped rather than deleted so that a dispute can read who was there.
 */

interface Props {
  role: 'ops' | 'admin';
  email: string | null;
  /** Null means the queue could not be read, which is different from an empty queue. */
  initialDisputes: OpsDisputeSummary[] | null;
}

/**
 * What each resolution does, in the operator's own terms.
 *
 * Written here rather than derived from the enum, because an operator is
 * choosing between consequences and not between vocabulary. Every line names
 * where the money goes and where the step ends up, since those are the two
 * things they are actually deciding.
 */
const RESOLUTIONS: {
  value: DisputeResolution;
  label: string;
  effect: string;
  /** Only legal when the dispute was raised from `rejected`, which SQL also enforces. */
  needsRejected?: boolean;
}[] = [
  {
    value: 'released',
    label: 'Pay the expert in full',
    effect: 'The step goes back to being paid and the next sweep sends the whole amount.',
  },
  {
    value: 'partial',
    label: 'Split it',
    effect:
      'The expert keeps the amount you enter, the client gets the rest back, the step closes.',
  },
  {
    value: 'refunded',
    label: 'Refund the client in full',
    effect: 'The whole escrow goes back and the step closes. Nobody is paid.',
  },
  {
    value: 'reassigned',
    label: 'Send it back to the market',
    effect: 'The escrow goes back and a different expert can take the step.',
  },
  {
    value: 'rejection_upheld',
    label: 'Uphold the rejection',
    effect: 'The step returns to the expert to redo, under the same agreement. No money moves.',
    needsRejected: true,
  },
];

/** Money, always tabular, always with its unit. design-system.md, non-negotiable. */
function money(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function whenever(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function OpsConsole({ role, email, initialDisputes }: Props) {
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [queue, setQueue] = useState<OpsDisputeSummary[] | null>(initialDisputes);
  const [selectedId, setSelectedId] = useState<string | null>(initialDisputes?.[0]?.id ?? null);
  const [detail, setDetail] = useState<OpsDisputeDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadQueue = useCallback(async (next: 'open' | 'resolved') => {
    try {
      const result = await listOpsDisputes(next);
      setQueue(result.disputes);
      // Selecting the first row keeps the detail pane populated after a
      // resolution removes the row that was open. Selecting nothing would
      // leave an operator looking at an empty half-screen after every decision.
      setSelectedId(result.disputes[0]?.id ?? null);
    } catch (err) {
      setQueue(null);
      setError(err instanceof Error ? err.message : 'Could not load the queue.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadingDetail(true);
    fetchOpsDispute(selectedId)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load it.');
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <main className="ops" data-skin="dark">
      <header className="ops-bar">
        <div>
          <p className="ops-eyebrow">Octopus operations</p>
          <h1 className="ops-title">Disputes</h1>
        </div>
        <div className="ops-who">
          {/* Badge and word, never colour alone (rule 15). */}
          <span className="ops-badge ops-badge-role">
            <span aria-hidden="true">◆</span> {role}
          </span>
          <span className="ops-who-email">{email ?? 'signed in'}</span>
        </div>
      </header>

      <nav className="ops-tabs" aria-label="Dispute queue">
        {(['open', 'resolved'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className="ops-tab"
            aria-pressed={status === tab}
            onClick={() => {
              setStatus(tab);
              void reloadQueue(tab);
            }}
          >
            {tab === 'open' ? 'Open' : 'Resolved'}
          </button>
        ))}
      </nav>

      {error ? (
        <p className="ops-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ops-split">
        <section className="ops-queue" aria-label="Disputes">
          {queue === null ? (
            <p className="ops-empty">The queue could not be read just now. Reload to try again.</p>
          ) : queue.length === 0 ? (
            <p className="ops-empty">
              {status === 'open'
                ? 'Nothing is disputed. Every deal is running or finished.'
                : 'Nothing has been resolved yet.'}
            </p>
          ) : (
            <ul className="ops-list">
              {queue.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="ops-row"
                    aria-current={d.id === selectedId}
                    onClick={() => setSelectedId(d.id)}
                  >
                    <span className="ops-row-title">{d.taskTitle}</span>
                    <span className="ops-row-meta">
                      <span className={`ops-badge ops-badge-${d.raisedRole}`}>
                        {d.raisedRole === 'owner' ? 'Client' : 'Expert'}
                      </span>
                      <span className="ops-row-when">{whenever(d.createdAt)}</span>
                    </span>
                    <span className="ops-row-reason">{d.reason}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="ops-detail" aria-label="Dispute detail" aria-busy={loadingDetail}>
          {!selectedId ? (
            <p className="ops-empty">Pick a dispute to see what happened.</p>
          ) : loadingDetail && !detail ? (
            <p className="ops-empty">Reading the record.</p>
          ) : detail ? (
            <DisputeDetail
              detail={detail}
              onResolved={() => {
                void reloadQueue(status);
              }}
              onError={setError}
            />
          ) : (
            <p className="ops-empty">That dispute could not be read.</p>
          )}
        </section>
      </div>
    </main>
  );
}

function DisputeDetail({
  detail,
  onResolved,
  onError,
}: {
  detail: OpsDisputeDetail;
  onResolved: () => void;
  onError: (message: string) => void;
}) {
  const { dispute, task, engagement, holds, payouts, ledger, roster } = detail;
  const resolved = dispute.resolvedAt !== null;

  const [resolution, setResolution] = useState<DisputeResolution | ''>('');
  const [reason, setReason] = useState('');
  const [releaseAmount, setReleaseAmount] = useState('');
  const [saving, setSaving] = useState(false);

  // The hold a settlement acts on: the one still `held`. A step that has been
  // through a partial before has more than one row here, and only one of them is
  // live money.
  const heldHold = useMemo(() => holds.find((h) => h.state === 'held') ?? null, [holds]);

  const release = Number(releaseAmount);
  const releaseValid =
    releaseAmount.trim() !== '' &&
    Number.isFinite(release) &&
    release > 0 &&
    heldHold !== null &&
    release < heldHold.amount;
  // Derived, never entered. Two fields that must sum to a third are two ways to
  // type a number that does not add up.
  const derivedRefund = heldHold && releaseValid ? heldHold.amount - release : null;

  const chosen = RESOLUTIONS.find((r) => r.value === resolution) ?? null;
  const blockedByState = chosen?.needsRejected === true && dispute.fromState !== 'rejected';
  const needsHold =
    resolution === 'refunded' || resolution === 'partial' || resolution === 'reassigned';

  const canSubmit =
    !saving &&
    resolution !== '' &&
    reason.trim().length > 0 &&
    !blockedByState &&
    (!needsHold || heldHold !== null) &&
    (resolution !== 'partial' || releaseValid);

  async function submit() {
    // `canSubmit` includes `resolution !== ''`, and TypeScript narrows through
    // the alias, so a second check here is not defensive but dead. The button is
    // disabled on the same condition; this guard is for the keyboard path.
    if (!canSubmit) return;
    setSaving(true);
    try {
      await resolveOpsDispute(dispute.id, {
        resolution,
        reason: reason.trim(),
        ...(resolution === 'partial' ? { releaseAmount: release } : {}),
      });
      onResolved();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not record that decision.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-card-stack">
      <article className="ops-card">
        <h2 className="ops-card-title">{task?.title ?? 'A step'}</h2>
        <dl className="ops-facts">
          <div>
            <dt>Raised by</dt>
            <dd>
              {dispute.raisedByName ?? 'Someone'}{' '}
              <span className={`ops-badge ops-badge-${dispute.raisedRole}`}>
                {dispute.raisedRole === 'owner' ? 'Client' : 'Expert'}
              </span>
            </dd>
          </div>
          <div>
            <dt>Raised from</dt>
            <dd className="ops-mono">{dispute.fromState}</dd>
          </div>
          <div>
            <dt>Step is now</dt>
            <dd className="ops-mono">{task?.state ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Raised</dt>
            <dd>{whenever(dispute.createdAt)}</dd>
          </div>
        </dl>
        <p className="ops-quote">{dispute.reason}</p>
        {dispute.evidence ? <p className="ops-quote ops-quote-quiet">{dispute.evidence}</p> : null}
      </article>

      {engagement ? (
        <article className="ops-card">
          <h3 className="ops-card-title">The deal</h3>
          <dl className="ops-facts">
            <div>
              <dt>Expert</dt>
              <dd>{engagement.nodeName ?? 'Unnamed'}</dd>
            </div>
            <div>
              <dt>Agreed price</dt>
              <dd className="ops-num">{money(engagement.agreedPrice, engagement.currency)}</dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>{whenever(engagement.acceptedAt)}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd className="ops-mono">{engagement.outcome ?? 'still running'}</dd>
            </div>
          </dl>
        </article>
      ) : null}

      <article className="ops-card">
        <h3 className="ops-card-title">The money</h3>
        <table className="ops-table">
          <caption className="ops-caption">Escrow holds on this step</caption>
          <thead>
            <tr>
              <th scope="col">Amount</th>
              <th scope="col">State</th>
              <th scope="col">Created</th>
            </tr>
          </thead>
          <tbody>
            {holds.length === 0 ? (
              <tr>
                <td colSpan={3}>No hold on this step.</td>
              </tr>
            ) : (
              holds.map((h) => (
                <tr key={h.id}>
                  <td className="ops-num">{money(h.amount, h.currency)}</td>
                  <td className="ops-mono">{h.state}</td>
                  <td>{whenever(h.createdAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {payouts.length > 0 ? (
          <table className="ops-table">
            <caption className="ops-caption">Payouts</caption>
            <thead>
              <tr>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                <th scope="col">Reference</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map((p) => (
                <tr key={p.id}>
                  <td className="ops-num">{money(p.amount, p.currency)}</td>
                  <td className="ops-mono">{p.state}</td>
                  <td className="ops-mono">{p.transferId ?? 'not sent'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        {ledger.length > 0 ? (
          <table className="ops-table">
            <caption className="ops-caption">Ledger, oldest first</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Debit</th>
                <th scope="col">Credit</th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((e, i) => (
                <tr key={`${e.refId}-${i}`}>
                  <td className="ops-mono">{e.account}</td>
                  <td className="ops-num">{e.debit === 0 ? '' : e.debit.toFixed(2)}</td>
                  <td className="ops-num">{e.credit === 0 ? '' : e.credit.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </article>

      {roster.length > 0 ? (
        <article className="ops-card">
          <h3 className="ops-card-title">Who was in the thread</h3>
          <ul className="ops-roster">
            {roster.map((m) => (
              <li key={m.userId}>
                <span>{m.name ?? m.userId}</span>
                <span className="ops-mono">{m.role}</span>
                {/* Ended access is shown rather than filtered: who was there is
                    the point, and the roster is stamped rather than deleted so
                    that a dispute can read it. */}
                <span className={m.expiresAt ? 'ops-muted' : ''}>
                  {m.expiresAt ? `left ${whenever(m.expiresAt)}` : 'still in'}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      {resolved ? (
        <article className="ops-card ops-card-settled">
          <h3 className="ops-card-title">Resolved</h3>
          <dl className="ops-facts">
            <div>
              <dt>Decision</dt>
              <dd className="ops-mono">{dispute.resolution}</dd>
            </div>
            {dispute.releaseAmount !== null ? (
              <div>
                <dt>To the expert</dt>
                <dd className="ops-num">
                  {money(dispute.releaseAmount, engagement?.currency ?? '')}
                </dd>
              </div>
            ) : null}
            {dispute.refundAmount !== null ? (
              <div>
                <dt>Back to the client</dt>
                <dd className="ops-num">
                  {money(dispute.refundAmount, engagement?.currency ?? '')}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>When</dt>
              <dd>{dispute.resolvedAt ? whenever(dispute.resolvedAt) : ''}</dd>
            </div>
          </dl>
          {dispute.resolutionNote ? <p className="ops-quote">{dispute.resolutionNote}</p> : null}
        </article>
      ) : (
        <article className="ops-card">
          <h3 className="ops-card-title">Decide</h3>

          <fieldset className="ops-choices">
            <legend className="ops-legend">What happens</legend>
            {RESOLUTIONS.map((r) => {
              const unavailable = r.needsRejected === true && dispute.fromState !== 'rejected';
              return (
                <label key={r.value} className="ops-choice" data-unavailable={unavailable}>
                  <input
                    type="radio"
                    name="resolution"
                    value={r.value}
                    checked={resolution === r.value}
                    disabled={unavailable}
                    onChange={() => setResolution(r.value)}
                  />
                  <span>
                    <span className="ops-choice-label">{r.label}</span>
                    <span className="ops-choice-effect">
                      {unavailable
                        ? 'Only for a dispute about work the client sent back.'
                        : r.effect}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {resolution === 'partial' ? (
            <div className="ops-field">
              <label className="ops-label" htmlFor="release">
                The expert keeps
              </label>
              <input
                id="release"
                className="ops-input ops-num"
                inputMode="decimal"
                value={releaseAmount}
                onChange={(e) => setReleaseAmount(e.target.value)}
                placeholder={heldHold ? `less than ${heldHold.amount.toFixed(2)}` : ''}
              />
              {/* The refund is shown, never typed. */}
              <p className="ops-hint">
                {heldHold === null
                  ? 'There is no held escrow on this step, so it cannot be split.'
                  : derivedRefund !== null
                    ? `${money(derivedRefund, heldHold.currency)} goes back to the client.`
                    : `Enter an amount between 0 and ${heldHold.amount.toFixed(2)}, exclusive. Paying all of it is "pay in full"; paying none of it is "refund".`}
              </p>
            </div>
          ) : null}

          {needsHold && heldHold === null ? (
            <p className="ops-hint ops-hint-warn">
              There is no held escrow on this step, so nothing can be settled. It may already have
              been refunded.
            </p>
          ) : null}

          <div className="ops-field">
            <label className="ops-label" htmlFor="reason">
              Why
            </label>
            <textarea
              id="reason"
              className="ops-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What you decided and on what basis."
            />
            <p className="ops-hint">
              Recorded against your account with the decision, and shown to both parties. Every
              resolution needs one.
            </p>
          </div>

          <button type="button" className="ops-submit" disabled={!canSubmit} onClick={submit}>
            {saving ? 'Recording' : 'Record this decision'}
          </button>
        </article>
      )}
    </div>
  );
}
