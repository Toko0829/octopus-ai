import type { SupabaseClient } from '@supabase/supabase-js';
import { escrowRefundPair, refundKey } from '@octopus/payments';
import { postSystemMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * Give back what a finished step is still holding.
 *
 * **This sweep is the reason `held -> refunded` is in the escrow lifecycle map
 * at all.** Without a producer the arc would be the `task_deps` defect: a rule
 * enforced over an empty set. With it, the arc closes a real hole rather than a
 * theoretical one.
 *
 * The hole: a task can leave the market after its escrow is funded. An owner
 * cancels the step, a replan drops it, or a kill switch stops the project, and
 * `cancelled` is reachable from every non-terminal state by design. The hold is
 * unaffected by any of that, so it stays `held`, keeps counting against
 * `projects.budget_ceiling` (ADR-0020), and **pins part of the owner's budget
 * forever against work that will never happen.** Nobody would see why: the
 * campaign list would show less committed than the check refuses.
 *
 * Four things unwind together, and the order is the crash story:
 *
 *   1. the hold moves `held -> refunded`, **conditionally**, which is the whole
 *      idempotency contract. A second pass matches zero rows and does nothing;
 *      everything below is inside the branch that actually moved it;
 *   2. the reversing ledger pair is written, sharing the hold's `ref_id`, so the
 *      four entries about this hold sum to zero on every account and "settled"
 *      is a fact a reader derives rather than a column they trust;
 *   3. the engagement ends with `outcome = 'cancelled'`, through the write-once
 *      guard, which writes `engagement.ended` itself;
 *   4. the node's thread membership is revoked by stamping `expires_at = now()`.
 *
 * **Revocation is explicit, and step 4 is where that decision lives.**
 * `accept_offer` admits with `expires_at` null on purpose, because there is no
 * deadline source: `engagements.deadline_at` has no writer and a number invented
 * at acceptance would cut a node off mid-task. So the time-box is not a clock,
 * it is this: access ends when the work does. The module doc says "time-boxed"
 * and this is the honest reading of it in a slice with no deadlines.
 *
 * **Nothing is refunded at a provider, because nothing was ever charged.** This
 * unwinds a modelled obligation. Routing it through a `provider.refund()` that
 * the only implementation would answer trivially would dress an internal
 * correction up as money movement, in the one domain where that distinction is
 * the entire regulatory posture (see the counsel gate in payments-billing.md).
 *
 * **A failure never leaves the hold refunded and the rest undone**, because the
 * conditional update is first: if it succeeds and a later step throws, the next
 * pass finds the hold already `refunded` and skips it. That is a real gap and it
 * is bounded and stated rather than hidden: the ledger reversal and the
 * membership revocation are each individually idempotent-by-condition, and the
 * pass logs loudly (rule 16). Making all four atomic means a fifth database
 * function, and the honest trade is that the money figure, which is the one an
 * owner reads, is corrected first.
 */

/**
 * The terminal states that mean **the work did not happen**.
 *
 * `private.task_state_is_terminal` has three members and this list has two, and
 * the omission is the most consequential line in the file. **`done` is excluded
 * deliberately: a step that reached `done` was approved, and refunding its
 * escrow would take back money a person earned.** That hold belongs to the
 * payout slice, which releases it (`held -> released`, declared in the check
 * constraint and refused by the map precisely because its producer is not here).
 * A sweep that refunded approved work would be the single worst bug this domain
 * could ship, and it would look exactly like tidying up.
 *
 * Nothing can currently reach `done` while holding escrow, because
 * `escrow_funded -> in_progress` has no producer until slice 6. That makes the
 * exclusion free today and load-bearing the moment it is not.
 *
 * `failed` is included for symmetry with `cancelled`: both mean the step will
 * not be delivered. It is likewise unreachable from `escrow_funded` today, and
 * including it is not the "rule with no producer" anti-pattern, because the rule
 * here is "give the money back when the work stops" and it already has a
 * producer in `cancelled`.
 */
const UNDELIVERED_TASK_STATES = ['cancelled', 'failed'] as const;

/** How many holds one read may consider. Bounds the read, not the work. */
const HOLD_READ_LIMIT = 200;

interface HeldRow {
  id: string;
  task_id: string;
  project_id: string;
  amount: number | string;
  currency: string;
}

export interface EscrowReconcileDeps {
  admin: SupabaseClient;
  /** Bounds refunds PERFORMED, not holds examined. */
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

export interface EscrowReconcileResult {
  /** Holds returned to the owner's available budget. */
  refunded: number;
  /** Engagements ended as `cancelled` alongside a refund. */
  ended: number;
  /** Thread memberships revoked. */
  revoked: number;
  /** Could not act this pass. Retried next pass, nothing moved. */
  waiting: number;
}

export async function escrowReconcileSweep(
  deps: EscrowReconcileDeps,
): Promise<EscrowReconcileResult> {
  const result: EscrowReconcileResult = { refunded: 0, ended: 0, revoked: 0, waiting: 0 };

  const { data: holdRows, error } = await deps.admin
    .from('escrow_holds')
    .select('id, task_id, project_id, amount, currency')
    .eq('state', 'held')
    .limit(HOLD_READ_LIMIT);
  if (error) throw error;

  const holds = (holdRows ?? []) as HeldRow[];
  if (holds.length === 0) return result;

  // Which of those steps stopped. One read for the batch rather than one per
  // hold: a healthy workspace has holds on live steps and this costs a single
  // indexed lookup to learn that none of them qualify.
  const { data: taskRows, error: taskError } = await deps.admin
    .from('tasks')
    .select('id, title, state')
    .in(
      'id',
      holds.map((h) => h.task_id),
    )
    .in('state', UNDELIVERED_TASK_STATES as unknown as string[]);
  if (taskError) throw taskError;

  const undelivered = new Map(
    (taskRows ?? []).map((t) => [
      t.id as string,
      { title: (t.title as string) ?? '', state: t.state as string },
    ]),
  );

  for (const hold of holds) {
    if (result.refunded >= deps.maxPerPass) break;

    const task = undelivered.get(hold.task_id);
    if (!task) continue;

    try {
      await refundOne(deps, hold, task, result);
    } catch (err) {
      result.waiting += 1;
      deps.log.error(
        { err, holdId: hold.id, taskId: hold.task_id },
        'could not reconcile an escrow hold this pass',
      );
    }
  }

  if (result.refunded || result.waiting) deps.log.info(result, 'escrow reconcile complete');
  return result;
}

async function refundOne(
  deps: EscrowReconcileDeps,
  hold: HeldRow,
  task: { title: string; state: string },
  result: EscrowReconcileResult,
): Promise<void> {
  // **The conditional update, and it comes first.** A loser matches zero rows
  // and performs nothing, so two passes overlapping cannot write two reversals.
  // The guard trigger validates the arc and writes `escrow.transitioned`.
  const { data: moved, error } = await deps.admin
    .from('escrow_holds')
    .update({ state: 'refunded' })
    .eq('id', hold.id)
    .eq('state', 'held')
    .select('id');
  if (error) throw error;
  if ((moved ?? []).length === 0) return;

  result.refunded += 1;

  // numeric(12,2) arrives as a string over PostgREST. Converted before it
  // reaches the pair builder, which refuses anything that is not a finite
  // number rather than arithmetic-ing it.
  const amount = Number(hold.amount);
  const entries = escrowRefundPair({ holdId: hold.id, amount, currency: hold.currency });

  const { error: ledgerError } = await deps.admin.from('ledger_entries').insert(
    entries.map((e) => ({
      account: e.account,
      debit: e.debit,
      credit: e.credit,
      currency: e.currency,
      ref_type: e.refType,
      ref_id: e.refId,
    })),
  );
  if (ledgerError) {
    // Never swallowed. The hold has moved and the ledger has not, which is the
    // one inconsistency a person reconciling would need to know about, and rule
    // 16 forbids it being silent.
    deps.log.error(
      { err: ledgerError, holdId: hold.id },
      'an escrow hold was refunded but its ledger pair was not written',
    );
  }

  // The deal ends as `cancelled`: the work stopped through no act of the node's.
  // `completed` is the approval path's outcome and `reassigned` is the no-show
  // path's, and slice 8 rates on the difference, so guessing between them here
  // would put a wrong fact in front of a rating.
  //
  // Conditional on `ended_at is null` so a replay writes nothing and the
  // write-once guard is never asked to refuse an update we should not have made.
  const { data: endedRows, error: endError } = await deps.admin
    .from('engagements')
    .update({ ended_at: new Date().toISOString(), outcome: 'cancelled' })
    .eq('task_id', hold.task_id)
    .is('ended_at', null)
    .select('id, node_id');
  if (endError) throw endError;

  const ended = (endedRows ?? []) as { id: string; node_id: string }[];
  result.ended += ended.length;

  // **The explicit revocation.** `accept_offer` admitted with `expires_at` null
  // because there is no deadline to box the access with; access ends when the
  // work does, and this is that moment. Stamped rather than deleted, so the
  // roster still records that this person was here, which is what a dispute
  // reads.
  //
  // **Scoped to this task's thread**, and the narrowness matters: a node can
  // hold thread memberships in other rooms for other steps, so a revocation
  // keyed on the person alone would cut them out of work that is still running.
  // The thread is resolved from the task rather than from the membership,
  // because `threads.task_id` is unique and is the only durable link between a
  // hold and the room somebody was let into.
  if (ended.length > 0) {
    const { data: threadRow, error: threadError } = await deps.admin
      .from('threads')
      .select('id')
      .eq('task_id', hold.task_id)
      .maybeSingle();
    if (threadError) throw threadError;

    const threadId = (threadRow as { id: string } | null)?.id ?? null;
    if (threadId) {
      for (const engagement of ended) {
        const { data: revoked, error: revokeError } = await deps.admin
          .from('room_members')
          .update({ expires_at: new Date().toISOString() })
          .eq('user_id', engagement.node_id)
          .eq('thread_id', threadId)
          .is('expires_at', null)
          .select('room_id');
        if (revokeError) throw revokeError;
        result.revoked += (revoked ?? []).length;
      }
    } else {
      deps.log.warn(
        { holdId: hold.id, taskId: hold.task_id },
        'an engagement ended but its task has no thread, so no membership was revoked',
      );
    }
  }

  const roomId = await roomForProject(deps.admin, hold.project_id);
  if (!roomId) {
    deps.log.warn(
      { holdId: hold.id, projectId: hold.project_id },
      'an escrow hold was released but its project has no room to say so in',
    );
    return;
  }

  // Keyed on the hold, so a crash between the refund and the message leaves the
  // next pass unable to post a second line even though it can no longer perform
  // the refund. A collision is the mechanism working.
  await postSystemMessage(
    deps.admin,
    deps.log,
    roomId,
    refundKey(hold.id),
    `"${task.title}" stopped before it was delivered, so the ${amount} ${hold.currency} ` +
      `held in escrow for it is back in your project budget.`,
  );
}
