'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { NodeCredential, NodeEngagement, NodeOffer, NodeProfile } from '@octopus/contracts';
import type { UiMessage } from '../../lib/types';
import { fromBroadcastRecord, mergeMessages, toMessage } from '../../lib/adapt';
import { createClient } from '../../lib/supabase/client';
import {
  NO_OPEN_OFFERS,
  SKILL_TAXONOMY,
  ineligibilityReason,
  isEligibleForWork,
  offerabilityGap,
  skillRejectionReason,
} from '@octopus/marketplace';
import {
  acceptOffer,
  addNodeCredential,
  addNodeSkill,
  declineOffer,
  disputeRejection,
  getMessages,
  getNodeEngagements,
  getNodeOffers,
  startEngagementWork,
  submitProof,
  patchNode,
  postMessage,
  rateClient,
  removeNodeSkill,
  revokeNodeCredential,
} from '../../lib/api-client';

/**
 * A node's own record, and the only surface in the product that belongs to them.
 *
 * Three rules from the design system are load-bearing here rather than
 * decorative, and each one is a place this screen could have lied.
 *
 *   1. **Status is words plus a dot, never colour alone** (rule 15). Somebody
 *      reading "verified" in green and somebody reading it in grey have to reach
 *      the same conclusion.
 *   2. **A disabled control says why.** `availability` cannot be set to available
 *      until `kyc_status` is verified, because a table constraint says so. A
 *      toggle that silently did nothing is how a person concludes the product is
 *      broken, so the reason is printed beside it.
 *   3. **Nothing here claims to be verified when it is not.** Every skill and
 *      every licence is a claim, `verified` is false on all of them today, and
 *      the surface says "claimed" rather than leaving the word out and letting
 *      the reader assume.
 *
 * **The verification log is absent and cannot be added.** `node_verifications`
 * has no policy and no client grant at all, and refuses `permission denied` to
 * the subject of the record, because a face-search result names a third party
 * they may be a duplicate of. What this screen shows is the status; what
 * happened to produce it is not the node's to read, and saying so is better than
 * an empty list that looks like a bug.
 */

const STATUS_COPY: Record<NodeProfile['kycStatus'], string> = {
  unverified: 'Not verified',
  pending: 'Being checked',
  verified: 'Verified',
  rejected: 'Not accepted',
  suspended: 'Suspended',
};

const AVAILABILITY_COPY: Record<NodeProfile['availability'], string> = {
  available: 'Taking work',
  paused: 'Paused',
  offboarded: 'Left the marketplace',
};

const CREDENTIAL_KINDS = ['lawyer', 'accountant', 'notary'] as const;

/**
 * The shape `private.is_jurisdiction_code` enforces, restated so a typo is a
 * sentence rather than a 409. The database remains the copy that cannot be
 * bypassed; this one only ever refuses more.
 */
const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,2}$/;

interface Props {
  initial: NodeProfile;
  initialOffers: NodeOffer[];
  initialEngagements: NodeEngagement[];
  email: string | null;
}

export function NodeConsole({ initial, initialOffers, initialEngagements, email }: Props) {
  const [node, setNode] = useState(initial);
  const [offers, setOffers] = useState(initialOffers);
  const [engagements, setEngagements] = useState(initialEngagements);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eligible = isEligibleForWork(node);
  const reason = ineligibilityReason(node);

  async function run(key: string, work: () => Promise<NodeProfile | void>) {
    setBusy(key);
    setError(null);
    try {
      const updated = await work();
      if (updated) setNode(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="node">
      <p className="node-eyebrow">Octopus marketplace</p>
      <h1 className="node-title">Your expert profile</h1>
      {email && <p className="node-body mono">{email}</p>}

      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}

      <Status node={node} eligible={eligible} reason={reason} offers={offers} />

      <Engagements
        engagements={engagements}
        onChanged={async () => {
          const { engagements: fresh } = await getNodeEngagements();
          setEngagements(fresh);
        }}
      />

      <Offers
        offers={offers}
        eligible={eligible}
        node={node}
        onChanged={async () => {
          // Both lists move together: accepting settles an offer and creates an
          // engagement, so refetching one and not the other would leave the page
          // showing work in two places at once.
          const [{ offers: fresh }, { engagements: taken }] = await Promise.all([
            getNodeOffers(),
            getNodeEngagements(),
          ]);
          setOffers(fresh);
          setEngagements(taken);
        }}
      />

      <section className="node-card">
        <h2 className="node-h2">Taking work</h2>
        <p className="node-note">
          {node.kycStatus === 'verified'
            ? 'Turn this off whenever you need to. Nothing already agreed is affected.'
            : 'You can turn this on once your identity is verified.'}
        </p>
        <div className="node-row">
          <button
            type="button"
            className="btn"
            disabled={node.kycStatus !== 'verified' || busy !== null}
            onClick={() =>
              void run('availability', async () => {
                const next = node.availability === 'available' ? 'paused' : 'available';
                const { node: updated } = await patchNode({ availability: next });
                return updated;
              })
            }
          >
            {busy === 'availability'
              ? 'Saving'
              : node.availability === 'available'
                ? 'Pause my availability'
                : 'Start taking work'}
          </button>
        </div>
      </section>

      <Places node={node} busy={busy} onRun={run} />
      <Rate node={node} busy={busy} onRun={run} />
      <Skills node={node} busy={busy} onRun={run} />
      <Credentials node={node} busy={busy} onRun={run} />

      <section className="node-card">
        <h2 className="node-h2">Identity</h2>
        <p className="node-note">
          Octopus records the verdicts of an identity check and never the documents behind them. The
          record of what was checked is not yours to read, which is deliberate: those records can
          name other people.
        </p>
        {node.kycStatus === 'verified' ? (
          <p className="node-body">Your identity is verified. Nothing further is needed.</p>
        ) : node.kycStatus === 'suspended' ? (
          <p className="node-body">Your account is suspended. Support has the details.</p>
        ) : (
          <a className="btn btn-primary node-cta" href="/node/verify">
            {node.kycStatus === 'rejected' ? 'Try the check again' : 'Verify my identity'}
          </a>
        )}
      </section>
    </main>
  );
}

function Status({
  node,
  eligible,
  reason,
  offers,
}: {
  node: NodeProfile;
  eligible: boolean;
  reason: string | null;
  offers: NodeOffer[];
}) {
  // The gaps eligibility does not cover. A verified, available node with **no
  // rate** passes every check on this page and is still excluded by the
  // matcher's pool query, because an offer is measured against a rate. Since
  // slice 5 an **hourly** rate is the same quiet dead end: work is funded as one
  // whole amount held in escrow and there is no hours field to multiply by, so
  // the pool filters `rate_period = 'task'`. Without these lines such a person
  // waits indefinitely with nothing on screen explaining it.
  const gap = offerabilityGap(node);
  const openOffers = offers.filter((o) => o.status === 'open').length;
  return (
    <section className="node-card">
      <h2 className="node-h2">Where you stand</h2>
      <ul className="node-status">
        <li>
          <span className={`node-dot node-dot-${node.kycStatus}`} aria-hidden="true" />
          <span className="node-status-label">Identity</span>
          <span className="node-status-value">{STATUS_COPY[node.kycStatus]}</span>
        </li>
        <li>
          <span className={`node-dot node-dot-${node.availability}`} aria-hidden="true" />
          <span className="node-status-label">Availability</span>
          <span className="node-status-value">{AVAILABILITY_COPY[node.availability]}</span>
        </li>
      </ul>
      {reason && <p className="node-note">{reason}</p>}
      {eligible && gap && <p className="node-note">{gap}</p>}
      {eligible && !gap && openOffers === 0 && <p className="node-note">{NO_OPEN_OFFERS}</p>}
    </section>
  );
}

/** Stage names as a person would say them, not as the planner stores them. */
const STAGE_COPY: Record<string, string> = {
  strategy: 'Positioning and strategy',
  content: 'Content',
  creative: 'Creative',
  channels: 'Channels and ads',
  conversion: 'Conversion',
  measurement: 'Measurement',
};

/**
 * The offers waiting for this node, and the two things they can do about one.
 *
 * **Both controls are now two-step, and for the same reason.** Declining cannot
 * be undone: the cascade moves to the next expert and `offers_task_node_idx`
 * means this node is never asked about this step again. Accepting cannot be
 * undone either, and it commits somebody else's money: the price is frozen at
 * this instant and held in escrow against the owner's authorised budget. The
 * confirm step states the exact figure, because "what will I be paid" is the one
 * question a person must not have to infer from a rate card.
 *
 * The Accept button used to be rendered disabled with a sentence saying escrow
 * had not shipped. It has, so both the disabled state and the sentence are gone
 * rather than left behind as a control that lies about itself.
 */
function Offers({
  offers,
  eligible,
  node,
  onChanged,
}: {
  offers: NodeOffer[];
  eligible: boolean;
  node: NodeProfile;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = offers.filter((o) => o.status === 'open');
  const settled = offers.filter((o) => o.status !== 'open');

  // Nothing at all and never anything: no section rather than an empty one. An
  // ineligible node is already told why by the status card above.
  if (!eligible && offers.length === 0) return null;

  async function decline(offerId: string) {
    setBusy(offerId);
    setError(null);
    try {
      await declineOffer(offerId, reason.trim() || undefined);
      setConfirming(null);
      setReason('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not decline that offer.');
    } finally {
      setBusy(null);
    }
  }

  async function accept(offerId: string) {
    setBusy(offerId);
    setError(null);
    try {
      await acceptOffer(offerId);
      setAccepting(null);
      await onChanged();
    } catch (err) {
      // The API surfaces the database's own sentence on a 409, so a refusal
      // names what stopped it (an expired offer, a full budget, a step that
      // moved) rather than saying only that something went wrong.
      setError(err instanceof Error ? err.message : 'Could not accept that offer.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="node-card">
      <h2 className="node-h2">Work offered to you</h2>

      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}

      {open.length === 0 && offers.length > 0 && (
        <p className="node-note">Nothing is open right now. What you already answered is below.</p>
      )}

      {open.map((offer) => (
        <article key={offer.id} className="node-offer">
          <h3 className="node-offer-title">{offer.task.title}</h3>
          {offer.task.stage && (
            <p className="node-offer-stage">{STAGE_COPY[offer.task.stage] ?? offer.task.stage}</p>
          )}
          {offer.task.detail && <p className="node-body">{offer.task.detail}</p>}
          <p className="node-note">
            Open until <ExpiryDate value={offer.expiresAt} />. If you do nothing, it goes to the
            next expert.
          </p>

          <div className="node-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null}
              onClick={() => {
                setAccepting(accepting === offer.id ? null : offer.id);
                setConfirming(null);
              }}
            >
              {accepting === offer.id ? 'Not yet' : 'Accept'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => {
                setConfirming(confirming === offer.id ? null : offer.id);
                setAccepting(null);
                setReason('');
              }}
            >
              {confirming === offer.id ? 'Keep it' : 'Decline'}
            </button>
          </div>

          {accepting === offer.id && (
            <div className="node-confirm">
              <p className="node-body">
                {node.rate === null
                  ? 'Set your rate before accepting: the price of a step is your rate.'
                  : `Your rate, ${money(node.rate)} ${node.currency} for the task, is locked in escrow when you accept. It cannot be changed afterwards, and raising your rate later does not change this step.`}
              </p>
              <p className="node-note">
                Accepting opens a private thread on this step. You will be able to see and talk to
                the person whose business it is, and nothing else of theirs.
              </p>
              <div className="node-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null || node.rate === null}
                  onClick={() => void accept(offer.id)}
                >
                  {busy === offer.id ? 'Accepting' : 'Accept and lock the price'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => setAccepting(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {confirming === offer.id && (
            <div className="node-confirm">
              <label className="node-label" htmlFor={`reason-${offer.id}`}>
                Why, if you want to say (optional)
              </label>
              <textarea
                id={`reason-${offer.id}`}
                className="node-textarea"
                value={reason}
                maxLength={500}
                rows={3}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Outside what I do, the brief is unclear, no time this week"
              />
              <p className="node-note">
                Declining is final for this step. It goes to another expert and you will not be
                asked about it again.
              </p>
              <div className="node-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy !== null}
                  onClick={() => void decline(offer.id)}
                >
                  {busy === offer.id ? 'Declining' : 'Decline it'}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </article>
      ))}

      {settled.length > 0 && (
        <>
          <h3 className="node-h3">Earlier</h3>
          <ul className="node-history">
            {settled.map((offer) => (
              <li key={offer.id}>
                <span className="node-history-title">{offer.task.title}</span>
                <span className="node-history-status">{SETTLED_COPY[offer.status]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Money as a person reads it, with the cents that a numeric column carries.
 *
 * Tabular numerics are a design-system rule for money (rule 14), applied through
 * the `mono` class wherever this is rendered.
 */
function money(amount: number): string {
  return amount.toFixed(2);
}

/** How a step's state reads to the expert doing it, rather than to its owner. */
const WORK_STATE_COPY: Record<string, string> = {
  escrow_funded: 'Funded and ready to start',
  in_progress: 'In progress',
  proof_submitted: 'Waiting on review',
  in_review: 'Being reviewed',
  approved: 'Approved',
  payout_pending: 'Approved, payment pending',
  paid: 'Paid',
  done: 'Finished',
  rejected: 'Sent back for changes',
  disputed: 'In dispute',
  cancelled: 'Cancelled',
  blocked: 'On hold',
};

/**
 * The controls on a step a node holds: start it, hand it over, look at what they
 * already handed over.
 *
 * **Which control appears is driven by `task.state` and nothing else.** There is
 * no local idea of where the work has got to, because
 * [ADR-0016](../../../../docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md)
 * says `tasks.state` is the only state an engagement has, and a second one here
 * would drift the moment the owner acted in another tab.
 *
 * **Nothing here can approve anything.** The node hands over; the owner decides.
 * The only states this surface can produce are `in_progress` and
 * `proof_submitted`.
 */
function WorkPanel({
  engagement,
  onChanged,
}: {
  engagement: NodeEngagement;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [responses, setResponses] = useState<string[]>(() =>
    engagement.task.acceptanceCriteria.map(() => ''),
  );
  const [files, setFiles] = useState<File[]>([]);
  const [bounced, setBounced] = useState<{ reasons: string[]; unaddressed: number[] } | null>(null);
  const [open, setOpen] = useState(false);

  const state = engagement.task.state;
  const startable = state === 'escrow_funded' || state === 'rejected';
  const submittable = state === 'in_progress';

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await startEngagementWork(engagement.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start that.');
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await submitProof(engagement.id, { note, responses, files });
      if (result.bounced) {
        // **Kept on screen rather than cleared.** The step did not move and the
        // form is what they need to fix, which is the same trade `ResolveStep`
        // makes: discarding somebody's writing is the fastest way to lose their
        // trust in the button.
        setBounced(result.bounced);
        return;
      }
      setBounced(null);
      setNote('');
      setResponses(engagement.task.acceptanceCriteria.map(() => ''));
      setFiles([]);
      setOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hand that over.');
    } finally {
      setBusy(false);
    }
  }

  if (!startable && !submittable) {
    // Handed over, or finished, or stopped. The state line above the panel
    // already says which, so this adds nothing rather than repeating it.
    return null;
  }

  return (
    <div className="node-work">
      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}

      {startable && (
        <div className="node-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? 'Starting' : state === 'rejected' ? 'Pick this back up' : 'Start work'}
          </button>
          {/* **The only act in this system a node takes against the client**, and
              it sits beside redoing the work rather than replacing it, because
              redoing it is usually the right answer. `rejected` is the one state
              where a person has told this node no; before this arc existed their
              alternatives were to redo work they believe was fine, or to stop
              answering, which the no-show sweep reads as their failure and
              reassigns the step away from them. */}
          {state === 'rejected' && (
            <DisputeRejection engagementId={engagement.id} onChanged={onChanged} />
          )}
        </div>
      )}

      {submittable && !open && (
        <div className="node-row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => setOpen(true)}
          >
            Hand this over
          </button>
        </div>
      )}

      {submittable && open && (
        <div className="node-confirm">
          <p className="node-note">
            The owner reads this and either approves it or sends it back with a note. If they
            approve it, the {money(engagement.agreedPrice)} {engagement.currency} held in escrow is
            released to you on the next pass.
          </p>

          {bounced && (
            <div className="node-error" role="alert">
              {bounced.reasons.map((reason) => (
                <p key={reason}>{reason}</p>
              ))}
            </div>
          )}

          <label className="node-label" htmlFor={`note-${engagement.id}`}>
            What did you do?
          </label>
          <textarea
            id={`note-${engagement.id}`}
            className="node-textarea"
            value={note}
            maxLength={8000}
            rows={4}
            placeholder="What you did, where it is, and anything the owner should know"
            onChange={(e) => setNote(e.target.value)}
          />

          {engagement.task.acceptanceCriteria.length > 0 && (
            <>
              <p className="node-note">This step asked for the following. Answer each one.</p>
              {engagement.task.acceptanceCriteria.map((criterion, i) => (
                <div key={criterion}>
                  <label className="node-label" htmlFor={`crit-${engagement.id}-${i}`}>
                    {criterion}
                    {/* Word, never colour alone (rule 15). */}
                    {bounced?.unaddressed.includes(i) ? ' — still blank' : ''}
                  </label>
                  <textarea
                    id={`crit-${engagement.id}-${i}`}
                    className="node-textarea"
                    value={responses[i] ?? ''}
                    maxLength={2000}
                    rows={2}
                    onChange={(e) =>
                      setResponses((cur) => cur.map((r, j) => (j === i ? e.target.value : r)))
                    }
                  />
                </div>
              ))}
            </>
          )}

          <label className="node-label" htmlFor={`files-${engagement.id}`}>
            Files, if there are any
          </label>
          <input
            id={`files-${engagement.id}`}
            className="node-file"
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          <p className="node-note">
            Up to five files, 25MB each. Images, video, PDF and plain text.
          </p>

          <div className="node-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Not yet
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || note.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? 'Handing over' : 'Hand it over'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const OUTCOME_COPY: Record<string, string> = {
  // `settle_payout` is the only writer of this outcome and it writes it in the
  // same transaction that releases the escrow, so "completed" and "paid" are one
  // fact and the word a node cares about is the second one.
  completed: 'Finished and paid',
  reassigned: 'Passed to somebody else',
  cancelled: 'Stopped before it was delivered',
  disputed_resolved: 'Closed after a dispute',
};

/**
 * The work this node took, and the private thread for each one.
 *
 * **The thread is the whole of what an engagement gives a node access to.** They
 * are a thread-scoped member of one room: they see the room shell, their own
 * thread, its messages, and nothing else. Not the project, not the plan, not the
 * other steps, not the owner's conversation with the AI.
 *
 * **The panel subscribes now, and the poll is gone.** `20260906120000` gave a
 * thread its own realtime topic: `broadcast_message` emits `chat:thread:<id>`
 * beside the room topic, and both `realtime.messages` policies gained one
 * disjunct so a thread-scoped member may join exactly their own thread's topic
 * and nothing else. This node had been reading through a ten-second poll since
 * slice 5, which was correct and slow; the obligation to replace it was re-dated
 * twice and is discharged here.
 *
 * **The since-cursor GET stays, as catch-up rather than as the transport.** A
 * live subscription is not durable catch-up: it says nothing about what arrived
 * while the tab was closed. `ChatApp` resolves that the same way, by fetching on
 * `SUBSCRIBED` and merging.
 */
function Engagements({
  engagements,
  onChanged,
}: {
  engagements: NodeEngagement[];
  onChanged: () => Promise<void>;
}) {
  if (engagements.length === 0) return null;

  const live = engagements.filter((e) => e.endedAt === null);
  const past = engagements.filter((e) => e.endedAt !== null);

  return (
    <section className="node-card">
      <h2 className="node-h2">Accepted work</h2>

      {live.map((engagement) => (
        <article key={engagement.id} className="node-offer">
          <h3 className="node-offer-title">{engagement.task.title}</h3>
          <p className="node-offer-stage">
            {STAGE_COPY[engagement.task.stage ?? ''] ?? engagement.task.stage ?? 'Step'}
          </p>
          <p className="node-note">
            <span className="mono">
              {money(engagement.agreedPrice)} {engagement.currency}
            </span>{' '}
            agreed, held in escrow.{' '}
            {WORK_STATE_COPY[engagement.task.state] ?? engagement.task.state}.
          </p>
          {engagement.task.detail && <p className="node-body">{engagement.task.detail}</p>}
          <WorkPanel engagement={engagement} onChanged={onChanged} />
          {engagement.roomId && engagement.threadId ? (
            <ThreadPanel roomId={engagement.roomId} threadId={engagement.threadId} />
          ) : (
            <p className="node-note">This step has no thread, so there is nowhere to talk yet.</p>
          )}
        </article>
      ))}

      {past.length > 0 && (
        <>
          <h3 className="node-h3">Finished</h3>
          <ul className="node-history">
            {past.map((engagement) => (
              <li key={engagement.id}>
                <span className="node-history-title">{engagement.task.title}</span>
                <span className="node-history-status">
                  {OUTCOME_COPY[engagement.outcome ?? ''] ?? 'Closed'}
                </span>
                {/* **The amount only on the deals that paid it.** `completed` is
                    the outcome `settle_payout` writes, and it is the only one
                    that means money moved; putting a figure beside a reassigned
                    or cancelled step would read as a fee somebody was denied
                    rather than one that was never owed. */}
                {engagement.outcome === 'completed' && (
                  <span className="node-history-amount mono">
                    {money(engagement.agreedPrice)} {engagement.currency}
                  </span>
                )}
                {/* **Rating is offered on `completed` and nothing else**, which
                    is the gate `public.submit_rating` enforces rather than a
                    guess this component makes. A reassigned or cancelled deal
                    delivered nothing, and a `disputed_resolved` one has already
                    been decided by an operator whose finding is a better record
                    than a score collected from whoever lost. */}
                {engagement.outcome === 'completed' && <RateClient engagementId={engagement.id} />}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The node contests a rejection.
 *
 * Closed by default and two clicks deep, on the same reasoning the owner's
 * dispute control follows: this pulls an operator into the deal and freezes
 * everything, and the ordinary answer to being sent back is to pick the work up
 * again, which is the button beside it.
 */
function DisputeRejection({
  engagementId,
  onChanged,
}: {
  engagementId: string;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        I disagree with this
      </button>
    );
  }

  return (
    <div className="node-dispute">
      <label className="node-label" htmlFor={`node-dispute-${engagementId}`}>
        Why do you disagree? An operator reads this and decides, and the client can answer it.
      </label>
      <textarea
        id={`node-dispute-${engagementId}`}
        className="node-input"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={busy}
      />
      <p className="node-note">
        Nothing moves while this is open. You are not paid and the client is not refunded until it
        is decided.
      </p>
      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}
      <div className="node-row">
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || reason.trim().length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await disputeRejection(engagementId, reason.trim());
              await onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not raise that.');
              setBusy(false);
            }
          }}
        >
          {busy ? 'Raising' : 'Raise a dispute'}
        </button>
      </div>
    </div>
  );
}

/**
 * The node scores the client, on a deal that finished cleanly.
 *
 * The other half of the owner's control on the project panel. Both land in this
 * slice because a market where only the buyer rates puts all the reputational
 * risk on the individual being paid, and the individuals being paid here are the
 * whole supply side.
 *
 * Replaced rather than left editable once submitted: `ratings` is append-only
 * including for `service_role`, so there is no edit to offer.
 */
function RateClient({ engagementId }: { engagementId: string }) {
  const [score, setScore] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (done) return <span className="node-history-rated">Rated</span>;

  return (
    <span className="node-history-rate">
      <span className="node-stars" role="group" aria-label="Rate this client out of five">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            className="node-star"
            aria-pressed={score === n}
            aria-label={`${n} out of 5`}
            disabled={busy}
            onClick={() => setScore(n)}
          >
            {n}
          </button>
        ))}
      </span>
      <button
        type="button"
        className="btn btn-small"
        disabled={busy || score === null}
        onClick={async () => {
          if (score === null) return;
          setBusy(true);
          setError(null);
          try {
            await rateClient(engagementId, { score });
            setDone(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not record that.');
            setBusy(false);
          }
        }}
      >
        {busy ? 'Saving' : 'Rate'}
      </button>
      {error && (
        <span className="node-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function ThreadPanel({ roomId, threadId }: { roomId: string; threadId: string }) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  /**
   * Catch-up, not transport. Runs on subscribe and after a reconnect, because a
   * live subscription says nothing about what arrived while this tab was shut.
   *
   * **Filtered here as well as by RLS**, and the duplication is deliberate. The
   * policy is what makes the room stream unreadable to this person; this is what
   * keeps a system message addressed to the whole room out of a panel that is
   * about one step. The cursor is derived from what is already held rather than
   * kept in state, so this callback does not change identity on every message
   * and re-run the effect that owns the socket.
   */
  const catchUp = useCallback(async () => {
    try {
      const { messages: fresh } = await getMessages(roomId);
      const mine = fresh.filter((m) => m.threadId === threadId).map(toMessage);
      if (mine.length > 0) setMessages((prev) => mergeMessages(prev, mine));
    } catch {
      // The socket is the live path and it is up; a failed catch-up means older
      // messages may be missing, which the banner below would overstate.
    }
  }, [roomId, threadId]);

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    void (async () => {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();
      if (cancelled) return;

      // Never silent. `ChatApp` records this exact bug: the page renders fine
      // because the server holds the session, live updates never start, and
      // nothing anywhere says so.
      if (sessionError || !session) {
        console.error('[node] no client session; live updates disabled', sessionError);
        setBanner('Live updates are off because this session could not be read. Try reloading.');
        await catchUp();
        return;
      }

      await supabase.realtime.setAuth(session.access_token);
      // **The thread topic, never the room topic.** A thread-scoped member is
      // refused the room topic by the policy, and asking for it would fail the
      // join rather than degrade.
      channel = supabase.channel(`chat:thread:${threadId}`, { config: { private: true } });

      channel.on('broadcast', { event: 'INSERT' }, (payload) => {
        const record = (payload as { payload?: { record?: unknown } }).payload?.record;
        const msg = fromBroadcastRecord(record);
        // The topic already narrows this to one thread. The check is the same
        // defense in depth the fetch path applies, and it costs nothing.
        if (!msg || msg.threadId !== threadId) return;
        setMessages((cur) => mergeMessages(cur, [msg]));
      });

      channel.subscribe(async (status, err) => {
        if (cancelled) return;
        if (status === 'SUBSCRIBED') {
          setBanner(null);
          await catchUp();
        }
        // Silence would mean messages quietly stop arriving, which is the exact
        // failure the write path cannot detect on its own (rule 16).
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('[node] thread realtime status', status, err?.message ?? '');
          setBanner('Live updates are disconnected. Reload to catch up.');
        }
      });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [threadId, catchUp]);

  async function send() {
    const body = draft.trim();
    if (body.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // `authorKind` is not sent and cannot be: the server reads this person's
      // own membership row and decides, and RLS re-checks it independently.
      const sent = await postMessage(roomId, {
        body,
        threadId,
        idempotencyKey: `thread-${threadId}-${Date.now()}`,
      });
      setDraft('');
      // Merged rather than re-fetched. The broadcast delivers the same row and
      // `mergeMessages` dedupes on id, so whichever arrives first wins and the
      // other is a no-op.
      setMessages((cur) => mergeMessages(cur, [toMessage(sent)]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="node-thread">
      <h4 className="node-h3">Thread</h4>
      {messages.length === 0 ? (
        <p className="node-note">Nothing here yet. Say hello, or ask what you need to start.</p>
      ) : (
        <ul className="node-thread-list">
          {messages.map((m) => (
            <li key={m.id} className="node-thread-msg">
              <span className="node-thread-who">{m.authorKind === 'node' ? 'You' : 'Owner'}</span>
              <span className="node-thread-body">{m.body}</span>
            </li>
          ))}
        </ul>
      )}

      {banner && (
        <p className="node-error" role="status">
          {banner}
        </p>
      )}

      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}

      <textarea
        className="node-textarea"
        value={draft}
        maxLength={4000}
        rows={3}
        placeholder="Ask a question, or say where you have got to"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="node-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void send()}
        >
          {busy ? 'Sending' : 'Send'}
        </button>
      </div>
      <p className="node-note">This thread is private to this step.</p>
    </div>
  );
}

const SETTLED_COPY: Record<string, string> = {
  declined: 'You declined it',
  expired: 'It ran out of time',
  withdrawn: 'The owner took it back',
  accepted: 'You accepted it',
  open: 'Open',
};

/**
 * A date rendered on the client only.
 *
 * Formatting a timestamp during a server render produces the server's locale and
 * time zone, which then differs from what the browser renders and trips a
 * hydration mismatch. Rendering the ISO string first and replacing it after mount
 * keeps both passes agreeing.
 */
function ExpiryDate({ value }: { value: string }) {
  const [text, setText] = useState(value.slice(0, 10));
  useEffect(() => {
    setText(new Date(value).toLocaleString());
  }, [value]);
  return <span className="mono">{text}</span>;
}

type Runner = (key: string, work: () => Promise<NodeProfile | void>) => Promise<void>;

function Places({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [draft, setDraft] = useState('');
  const [languages, setLanguages] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  return (
    <section className="node-card">
      <h2 className="node-h2">Where you work</h2>
      <p className="node-note">
        Codes rather than place names, so a task in Austin can find somebody licensed in Texas. US
        covers the whole country, US-TX covers the state, US-TX-AUSTIN covers the city.
      </p>
      <ul className="node-tags">
        {node.serviceJurisdictions.map((code) => (
          <li key={code} className="node-tag mono">
            {code}
            <button
              type="button"
              className="node-tag-x"
              aria-label={`Remove ${code}`}
              disabled={busy !== null || node.serviceJurisdictions.length === 1}
              onClick={() =>
                void onRun('places', async () => {
                  const { node: updated } = await patchNode({
                    serviceJurisdictions: node.serviceJurisdictions.filter((c) => c !== code),
                  });
                  return updated;
                })
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {node.serviceJurisdictions.length === 1 && (
        <p className="node-note">
          You need at least one. Add another before removing this one, or nobody could match you.
        </p>
      )}
      {local && <p className="node-error">{local}</p>}
      <div className="node-row">
        <label className="sr-only" htmlFor="node-jur">
          Add a jurisdiction code
        </label>
        <input
          id="node-jur"
          className="auth-input mono"
          value={draft}
          placeholder="US-TX"
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null || draft.length === 0}
          onClick={() => {
            if (!JURISDICTION.test(draft)) {
              setLocal('A code looks like US, US-TX or US-TX-AUSTIN, in capitals.');
              return;
            }
            setLocal(null);
            void onRun('places', async () => {
              const { node: updated } = await patchNode({
                serviceJurisdictions: [...new Set([...node.serviceJurisdictions, draft])],
              });
              setDraft('');
              return updated;
            });
          }}
        >
          Add
        </button>
      </div>

      <h3 className="node-h3">Languages</h3>
      <ul className="node-tags">
        {node.languages.map((lang) => (
          <li key={lang} className="node-tag mono">
            {lang}
          </li>
        ))}
      </ul>
      <div className="node-row">
        <label className="sr-only" htmlFor="node-lang">
          Add a language
        </label>
        <input
          id="node-lang"
          className="auth-input mono"
          value={languages}
          placeholder="en"
          onChange={(e) => setLanguages(e.target.value.toLowerCase())}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null || languages.length === 0}
          onClick={() =>
            void onRun('languages', async () => {
              const { node: updated } = await patchNode({
                languages: [...new Set([...node.languages, languages])],
              });
              setLanguages('');
              return updated;
            })
          }
        >
          Add
        </button>
      </div>
    </section>
  );
}

function Rate({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [amount, setAmount] = useState(node.rate === null ? '' : String(node.rate));
  const [period, setPeriod] = useState<'hour' | 'task'>(node.ratePeriod ?? 'hour');

  return (
    <section className="node-card">
      <h2 className="node-h2">What you charge</h2>
      <p className="node-note">
        Nothing is quoted on your behalf. A profile with no rate is not free, it is one the matcher
        cannot price, so it will not be offered work.
      </p>
      <div className="node-row">
        <label className="sr-only" htmlFor="node-rate">
          Rate
        </label>
        <input
          id="node-rate"
          className="auth-input mono tnum"
          inputMode="decimal"
          value={amount}
          placeholder="120.00"
          onChange={(e) => setAmount(e.target.value)}
        />
        <label className="sr-only" htmlFor="node-period">
          Per
        </label>
        <select
          id="node-period"
          className="auth-input"
          value={period}
          onChange={(e) => setPeriod(e.target.value as 'hour' | 'task')}
        >
          <option value="hour">per hour</option>
          <option value="task">per task</option>
        </select>
        <span className="node-currency mono">{node.currency}</span>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            void onRun('rate', async () => {
              const parsed = amount.trim() === '' ? null : Number(amount);
              if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
                throw new Error('A rate is a number above zero, or blank for none.');
              }
              const { node: updated } = await patchNode({
                rate: parsed,
                ratePeriod: parsed === null ? null : period,
              });
              return updated;
            })
          }
        >
          {busy === 'rate' ? 'Saving' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function Skills({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [base, setBase] = useState(SKILL_TAXONOMY[0]!.tag);
  const [where, setWhere] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const entry = useMemo(() => SKILL_TAXONOMY.find((s) => s.tag === base)!, [base]);
  const claimed = new Set(node.skills.map((s) => s.tag));

  return (
    <section className="node-card">
      <h2 className="node-h2">What you do</h2>
      <p className="node-note">
        Chosen from a fixed list rather than typed, so that two people who do the same work are
        findable by the same search. Everything here is a claim: nothing is confirmed until you have
        finished work through Octopus.
      </p>

      {node.skills.length === 0 ? (
        <p className="node-body">Nothing claimed yet.</p>
      ) : (
        <ul className="node-list">
          {node.skills.map((skill) => (
            <li key={skill.tag} className="node-list-row">
              <span className="mono">{skill.tag}</span>
              <span className="node-muted">{skill.verified ? 'Confirmed' : 'Claimed'}</span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() =>
                  void onRun('skills', async () => {
                    await removeNodeSkill(skill.tag);
                    return {
                      ...node,
                      skills: node.skills.filter((s) => s.tag !== skill.tag),
                    };
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {local && <p className="node-error">{local}</p>}

      <div className="node-row">
        <label className="sr-only" htmlFor="node-skill">
          Skill
        </label>
        <select
          id="node-skill"
          className="auth-input"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        >
          {SKILL_TAXONOMY.map((s) => (
            <option key={s.tag} value={s.tag}>
              {s.label}
            </option>
          ))}
        </select>
        {entry.requiresJurisdiction && (
          <>
            <label className="sr-only" htmlFor="node-skill-where">
              Where
            </label>
            <input
              id="node-skill-where"
              className="auth-input mono"
              value={where}
              placeholder="US-TX"
              onChange={(e) => setWhere(e.target.value.toUpperCase())}
            />
          </>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            const tag = entry.requiresJurisdiction ? `${base}:${where}` : base;
            const why = skillRejectionReason(tag);
            if (why) {
              setLocal(why);
              return;
            }
            if (claimed.has(tag)) {
              setLocal('You have already claimed that.');
              return;
            }
            setLocal(null);
            void onRun('skills', async () => {
              const { skill } = await addNodeSkill(tag);
              setWhere('');
              return { ...node, skills: [...node.skills, skill] };
            });
          }}
        >
          Claim
        </button>
      </div>
      <p className="node-note">{entry.description}</p>
    </section>
  );
}

function Credentials({
  node,
  busy,
  onRun,
}: {
  node: NodeProfile;
  busy: string | null;
  onRun: Runner;
}) {
  const [kind, setKind] = useState<(typeof CREDENTIAL_KINDS)[number]>('notary');
  const [where, setWhere] = useState('');
  const [issuer, setIssuer] = useState('');
  const [number, setNumber] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const live = node.credentials.filter((c) => c.revokedAt === null);

  return (
    <section className="node-card">
      <h2 className="node-h2">Licences you hold</h2>
      <p className="node-note">
        Recorded as claims. Octopus does not check a licence register yet, so nothing here is
        confirmed and nothing here will be shown to a client as confirmed. There is nowhere to
        upload a document, on purpose: we do not want one until we can keep it properly.
      </p>

      {live.length === 0 ? (
        <p className="node-body">Nothing claimed yet.</p>
      ) : (
        <ul className="node-list">
          {live.map((credential: NodeCredential) => (
            <li key={credential.id} className="node-list-row">
              <span>
                <span className="mono">{credential.kind}</span> in{' '}
                <span className="mono">{credential.jurisdiction}</span>
                {credential.licenceNumber && (
                  <span className="node-muted mono"> · {credential.licenceNumber}</span>
                )}
              </span>
              <span className="node-muted">
                {credential.verified ? 'Confirmed' : 'Claimed, not verified'}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() =>
                  void onRun('credentials', async () => {
                    const { credential: revoked } = await revokeNodeCredential(credential.id);
                    return {
                      ...node,
                      credentials: node.credentials.map((c) => (c.id === revoked.id ? revoked : c)),
                    };
                  })
                }
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}

      {local && <p className="node-error">{local}</p>}

      <div className="node-row">
        <label className="sr-only" htmlFor="node-cred-kind">
          Kind
        </label>
        <select
          id="node-cred-kind"
          className="auth-input"
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof CREDENTIAL_KINDS)[number])}
        >
          {CREDENTIAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="node-cred-where">
          Jurisdiction
        </label>
        <input
          id="node-cred-where"
          className="auth-input mono"
          value={where}
          placeholder="US-TX"
          onChange={(e) => setWhere(e.target.value.toUpperCase())}
        />
        <label className="sr-only" htmlFor="node-cred-issuer">
          Issuer
        </label>
        <input
          id="node-cred-issuer"
          className="auth-input"
          value={issuer}
          placeholder="Issuer (optional)"
          onChange={(e) => setIssuer(e.target.value)}
        />
        <label className="sr-only" htmlFor="node-cred-number">
          Licence number
        </label>
        <input
          id="node-cred-number"
          className="auth-input mono"
          value={number}
          placeholder="Number (optional)"
          onChange={(e) => setNumber(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            if (!JURISDICTION.test(where)) {
              setLocal('A jurisdiction looks like US or US-TX, in capitals.');
              return;
            }
            setLocal(null);
            void onRun('credentials', async () => {
              const { credential } = await addNodeCredential({
                kind,
                jurisdiction: where,
                ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
                ...(number.trim() ? { licenceNumber: number.trim() } : {}),
              });
              setWhere('');
              setIssuer('');
              setNumber('');
              return node.credentials.some((c) => c.id === credential.id)
                ? node
                : { ...node, credentials: [...node.credentials, credential] };
            });
          }}
        >
          Claim
        </button>
      </div>
    </section>
  );
}
