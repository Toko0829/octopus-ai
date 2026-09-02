import type { SupabaseClient } from '@supabase/supabase-js';
import {
  carriesRealMoney,
  FAKE_PROVIDER,
  payoutKey,
  providerFor,
  type PaymentProvider,
} from '@octopus/payments';
import { postSystemMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * The expert gets paid.
 *
 * `approved` on a human step has been a dead end since slice 6 shipped it: the
 * owner said the work was finished, the step stopped, and the hold stayed `held`
 * — still committing part of `projects.budget_ceiling`, still refused release by
 * the escrow map, with `held -> released` declared and producerless and
 * `engagements.outcome` never reaching `'completed'`. This sweep is the producer
 * of all three.
 *
 * ---------- Approving the work IS the authorisation ----------
 *
 * There is no second button and no confirmation.
 * payments-billing.md's money flow already specifies it ("**Transfer** —
 * approval triggers a Transfer"), and
 * [ADR-0013](../../../../docs/40-adr/0013-approving-a-campaign-publishes-it.md)'s
 * argument transfers unchanged: the owner has already authorised this exact
 * figure (the escrow was funded against their ceiling at acceptance), already
 * seen it on the step, and already read the proof and clicked approve. A
 * confirmation carrying no new information is one people learn to click through,
 * which weakens every other confirmation in the product.
 *
 * ---------- What the sweep selects, and why it never asks what kind of step ----------
 *
 * Tasks at `approved` **or** `payout_pending` that have a live engagement and a
 * `held` hold. An AI-approved step has neither, and a step the owner did
 * themselves has neither, so the join excludes both without a single test on
 * ownership or on how the step got where it is. That is deliberate: the money is
 * the thing that decides, and reading `owner_type` here would be a second
 * definition of "somebody is owed for this" alongside the one the ledger already
 * holds.
 *
 * ---------- The crash story ----------
 *
 * A transfer **creates** something at a provider under an id the provider mints,
 * so this takes ADR-0013's ordering (record the intent, then call) rather than
 * [ADR-0014](../../../../docs/40-adr/0014-cpa-ceiling-authorises-auto-pause.md)'s
 * inversion, where the platform is called first because a pause creates nothing.
 * Four points, each resuming:
 *
 *   1. **the task moves `approved -> payout_pending`**, conditionally. A crash
 *      here leaves it at `approved`, which this same selection picks up;
 *   2. **the `payouts` row is inserted at `pending`** under
 *      `payoutKey(engagementId)`. A crash after the insert collides on the unique
 *      key next pass and the row is read back rather than a second payout
 *      started;
 *   3. **the transfer is made**, and skipped entirely when `transfer_id` is
 *      already recorded. A crash between the call and step 4 recomputes the same
 *      key, and an idempotent provider answers with the transfer it already made;
 *   4. **`settle_payout` runs**, one transaction, and returns early if the payout
 *      is already `paid`.
 *
 * `payout_pending` is therefore transit-only in the same sense `in_review` is in
 * the approve route: a step passes through it, and a step found sitting in it is
 * a step whose sweep died.
 *
 * ---------- Nothing is paid, and that is enforced ----------
 *
 * `carriesRealMoney` is checked **before** the transfer, the way
 * `engagements.ts` checks it before the accept rpc. The only registered provider
 * is the in-repo fake, which makes no network call and holds no key, and its
 * references are visibly `tr_fake_…`. payments-billing.md's counsel gate is
 * unmoved: clearing it is what makes flipping that flag a reviewed act.
 */

/**
 * The states a step can be in while somebody is owed for it.
 *
 * Both, rather than only `approved`, because `payout_pending` is where crash
 * point 1 leaves a step and the same pass has to be able to finish it. A step
 * that reached `paid` or `done` is finished and its hold is already `released`,
 * so it fails the hold join anyway; listing them here as well would be a third
 * copy of one rule.
 */
const PAYABLE_TASK_STATES = ['approved', 'payout_pending'] as const;

/** How many engagements one read may consider. Bounds the read, not the work. */
const ENGAGEMENT_READ_LIMIT = 200;

/**
 * What the platform retains, and it is zero.
 *
 * vision.md names a 15-25% marketplace take rate and `payouts.platform_fee`
 * exists to carry it. It is **not** deducted here, argued in
 * [ADR-0024](../../../../docs/40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md):
 * escrow holds exactly the `agreed_price` the offer showed the node before they
 * accepted, and taking a cut at release changes what a person agreed to after
 * they agreed to it. A take rate is a pricing slice — the offer and the node
 * console have to name the figure before somebody accepts — not a number
 * invented in a sweep.
 *
 * A constant rather than an env var on purpose: a fee that could be set by
 * deployment is a fee that could differ between two nodes doing the same work,
 * and there is no surface on which either of them could have seen it.
 */
const PLATFORM_FEE = 0;

interface PayableEngagement {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  agreed_price: number | string;
  currency: string;
}

interface HoldRow {
  id: string;
  task_id: string;
  amount: number | string;
  currency: string;
}

interface PayoutRow {
  id: string;
  state: string;
  transfer_id: string | null;
}

export interface PayoutSweepDeps {
  admin: SupabaseClient;
  /** Bounds payouts PERFORMED, not engagements examined. */
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  /**
   * Which registered provider pays. The fake is the only one, and passing it
   * explicitly is what lets a test assert the refusal below rather than mock it.
   */
  provider?: string;
}

export interface PayoutSweepResult {
  /** Experts paid, their escrow released and their step finished. */
  paid: number;
  /** Could not act this pass. Retried next pass, nothing moved. */
  waiting: number;
}

export async function payoutSweep(deps: PayoutSweepDeps): Promise<PayoutSweepResult> {
  const result: PayoutSweepResult = { paid: 0, waiting: 0 };
  const providerName = deps.provider ?? FAKE_PROVIDER;

  // **The counsel gate's enforced half**, checked once per pass rather than once
  // per payout, before a single row is read.
  //
  // **It throws rather than returning a count**, and the difference matters. A
  // refusal counter would be a number with no reachable producer in this build,
  // since the only registered provider is the fake — the shape this repository
  // keeps recording. Throwing collapses both refusals into one behaviour that a
  // test can actually reach: `carriesRealMoney` **raises** on an unregistered
  // name rather than answering `false` (the inversion it was written for, since
  // "a provider we have never heard of certainly moves no money" is what would
  // let an unreviewed integration through), and this raises on a registered one
  // that moves money. Either way the pass is **inert rather than half-done**:
  // nothing is read, no task leaves `approved`, and the ticker's own try/catch
  // logs it beside the sentence below.
  if (carriesRealMoney(providerName)) {
    deps.log.error(
      { provider: providerName },
      'refusing to pay anybody: this provider moves real money, and the counsel gate in ' +
        'docs/30-modules/payments-billing.md has not been cleared',
    );
    throw new Error(
      `payment provider "${providerName}" moves real money. Clearing the counsel gate in ` +
        'docs/30-modules/payments-billing.md is what makes flipping carriesRealMoney a reviewed act.',
    );
  }
  const provider = providerFor(providerName);

  // Live engagements. `ended_at is null` is the whole definition of live
  // (`20260904120000`); `settle_payout` ends the one it pays, so a second pass
  // never sees it again.
  const { data: rows, error } = await deps.admin
    .from('engagements')
    .select('id, task_id, project_id, node_id, agreed_price, currency')
    .is('ended_at', null)
    .order('accepted_at', { ascending: true })
    .limit(ENGAGEMENT_READ_LIMIT);
  if (error) throw error;

  const engagements = (rows ?? []) as PayableEngagement[];
  if (engagements.length === 0) return result;

  const taskIds = engagements.map((e) => e.task_id);

  // Two batched reads rather than a join, for `no-show.ts`' reason: PostgREST
  // relationship guessing fails silently, and these are the reads that decide
  // whether somebody is paid.
  const { data: taskRows, error: taskError } = await deps.admin
    .from('tasks')
    .select('id, state, title')
    .in('id', taskIds)
    .in('state', PAYABLE_TASK_STATES as unknown as string[]);
  if (taskError) throw taskError;

  const payable = new Map(
    (taskRows ?? []).map((t) => [
      t.id as string,
      { state: t.state as string, title: (t.title as string) ?? 'a step' },
    ]),
  );
  if (payable.size === 0) return result;

  const { data: holdRows, error: holdError } = await deps.admin
    .from('escrow_holds')
    .select('id, task_id, amount, currency')
    .in('task_id', [...payable.keys()])
    .eq('state', 'held');
  if (holdError) throw holdError;

  const holdByTask = new Map((holdRows ?? []).map((h) => [(h as HoldRow).task_id, h as HoldRow]));

  for (const engagement of engagements) {
    if (result.paid >= deps.maxPerPass) break;

    const task = payable.get(engagement.task_id);
    if (!task) continue;

    // **No held hold, no payout.** The reconcile or no-show sweep may have
    // refunded it, in which case the money is back with the owner and paying now
    // would spend their ceiling twice. `settle_payout` refuses the same case
    // under a lock; this is the layer that can say nothing at all rather than
    // raising.
    const hold = holdByTask.get(engagement.task_id);
    if (!hold) continue;

    try {
      await payOne(deps, provider, engagement, hold, task.title);
      result.paid += 1;
    } catch (err) {
      // Per item, so one payout that cannot be made does not stop the pass
      // reaching the others. Never swallowed (rule 16): this is somebody's fee
      // for work that has already been approved.
      result.waiting += 1;
      deps.log.error(
        { err, engagementId: engagement.id, taskId: engagement.task_id },
        'could not pay an approved step this pass',
      );
    }
  }

  if (result.paid || result.waiting) deps.log.info(result, 'payout sweep complete');
  return result;
}

async function payOne(
  deps: PayoutSweepDeps,
  provider: PaymentProvider,
  engagement: PayableEngagement,
  hold: HoldRow,
  title: string,
): Promise<void> {
  // **(1) The intent, conditionally.** A loser matches zero rows, which here
  // means the step was already moved by an overlapping pass — so read on rather
  // than return, because that pass may have died before the transfer and this
  // one can finish it. The `payouts` unique key is what actually stops a double
  // payout, and it is checked one line down.
  const { error: moveError } = await deps.admin
    .from('tasks')
    .update({ state: 'payout_pending' })
    .eq('id', engagement.task_id)
    .eq('state', 'approved')
    .select('id');
  if (moveError) throw moveError;

  const key = payoutKey(engagement.id);

  // numeric(12,2) arrives as a string over PostgREST. Converted before it reaches
  // anything that does arithmetic, and refused rather than arithmetic'd if it is
  // not a number: `entriesBalance` guards its amounts the same way, and a silent
  // arithmetic failure on money is the worst available outcome.
  const amount = Number(hold.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `escrow hold ${hold.id} carries an amount that is not a positive number, so nothing can be paid against it`,
    );
  }

  // **(2) The payout row, before the transfer.** ADR-0013's ordering: a record of
  // an uncertain request is recoverable and an unrecorded certain one is not. A
  // crash after this collides on the unique key next pass and reads its own row
  // back rather than starting a second payout.
  const payout = await insertPayout(deps, engagement, hold, key, amount);
  if (payout.state === 'paid') return;

  // **(3) The transfer, skipped when one is already recorded.** The provider is
  // handed the same derived key, so an idempotent provider answers a retry with
  // the transfer it already made rather than a second one.
  let transferId = payout.transfer_id;
  if (!transferId) {
    const transfer = await provider.transfer({
      amount,
      currency: hold.currency,
      // The node's own user id. Not a bank account and not a connected account:
      // see `CreateTransferInput.destination`, which states why no column is
      // waiting for one.
      destination: engagement.node_id,
      idempotencyKey: key,
    });
    transferId = transfer.transferId;
  }

  // **(4) Everything else, in one transaction.** The hold releases with its
  // ledger pair, the deal ends as `completed`, `completed_engagements` moves, and
  // the step walks `payout_pending -> paid -> done`. Its header argues why no
  // partial state here is acceptable.
  const { error: settleError } = await deps.admin.rpc('settle_payout', {
    p_payout_id: payout.id,
    p_transfer_id: transferId,
  });
  if (settleError) throw settleError;

  const roomId = await roomForProject(deps.admin, engagement.project_id);
  if (!roomId) {
    deps.log.warn(
      { engagementId: engagement.id, projectId: engagement.project_id },
      'paid an engagement whose project has no room, so nobody was told',
    );
    return;
  }

  // **The owner is told here, and the node is told elsewhere.** Slice 6 revoked
  // the node's thread access when the owner approved the work, so there has never
  // been a surface in the chat to tell them on. As of notifications slice 1 they
  // do not need one: `settle_payout` writes `payout.settled` to `public.events`,
  // and the trigger on that table derives an inbox row carrying the amount, on a
  // topic that belongs to the person rather than to the room (ADR-0028). This
  // system message stays the owner's, which is what it always was.
  //
  // Keyed on the engagement, so a crash between the settlement and the post
  // leaves the next pass unable to say it twice — and it cannot repeat the
  // settlement either, because the payout is `paid`. A collision is the mechanism
  // working.
  await postSystemMessage(
    deps.admin,
    deps.log,
    roomId,
    key,
    `You approved "${title}", so the ${amount.toFixed(2)} ${hold.currency} held in escrow for ` +
      'it has been released to the expert who did it. That step is finished and the money is no ' +
      'longer committed against your project budget.',
  );
}

/**
 * Insert the payout, or read back the one a previous pass already made.
 *
 * **The collision is the mechanism, not an error.** `payouts.idempotency_key` is
 * unique and derived from the engagement, so a pass that inserted and then died
 * finds its own row here. Reading it back rather than raising is what makes crash
 * point 2 resumable, and it is `publish.ts`' idiom for the same reason.
 *
 * `23505` and nothing else is treated this way: any other write failure is a real
 * failure and is thrown, because a payout that silently did not record its intent
 * would go on to make a transfer nothing knows about.
 */
async function insertPayout(
  deps: PayoutSweepDeps,
  engagement: PayableEngagement,
  hold: HoldRow,
  key: string,
  amount: number,
): Promise<PayoutRow> {
  const { data, error } = await deps.admin
    .from('payouts')
    .insert({
      engagement_id: engagement.id,
      node_id: engagement.node_id,
      project_id: engagement.project_id,
      task_id: engagement.task_id,
      amount,
      platform_fee: PLATFORM_FEE,
      currency: hold.currency,
      idempotency_key: key,
    })
    .select('id, state, transfer_id')
    .single();

  if (!error) return data as PayoutRow;
  if (error.code !== '23505') throw error;

  const { data: existing, error: readError } = await deps.admin
    .from('payouts')
    .select('id, state, transfer_id')
    .eq('idempotency_key', key)
    .single();
  if (readError) throw readError;
  return existing as PayoutRow;
}
