/**
 * The chart of accounts, and the balanced pairs that move between them.
 *
 * `ledger_entries.account` is plain text with no enum and no check constraint,
 * on the `channel_connections.provider` precedent: the chart grows with every
 * money feature (a platform fee, a node payable, tax withheld), and a migration
 * per account is a migration per bookkeeping decision. The authority is this
 * file, which gets read in a diff.
 *
 * **Every function here returns BOTH sides of a movement, and that is the whole
 * design.** A ledger's one invariant is that debits equal credits, and Postgres
 * cannot cheaply assert a property of two rows without a deferred constraint
 * trigger firing on every insert into a table whose entire purpose is to be
 * written in pairs. So the invariant is structural instead: there is no exported
 * way to build one entry. A caller that wants to record a hold gets an array of
 * two, summing to zero by construction, because both sides read the same
 * `amount`.
 *
 * **No IO, no clock, no `fetch`, no Supabase client**, exactly as
 * `packages/marketing` has none. `created_at` is the database's default;
 * `ref_id` is passed in.
 */

/**
 * Where the owner's authorised budget sits before it is committed to anything.
 *
 * Debited when money becomes an obligation, credited when an obligation is
 * released back.
 */
export const OWNER_FUNDS = 'owner_funds';

/**
 * Money spoken for but not yet anybody's.
 *
 * Credited on a hold, debited on a refund, and debited again on a payout against
 * `NODE_PAYABLE` below.
 */
export const ESCROW = 'escrow';

/**
 * What the platform owes a node for work an owner approved.
 *
 * **This account was declined once, by name, and the reason it is here now is
 * that the reason it was declined has gone.** The line above used to read that
 * it "does not exist yet because nothing pays out: adding it now would be an
 * account with no entry, which is the same shape as a state with no writer."
 * `escrowReleasePair` is that entry.
 *
 * Credited on release. **Nothing debits it in this build**, and that is
 * deliberate rather than unfinished: a `node_payable -> node_paid` movement
 * would record money leaving the platform, and while the only registered
 * provider settles synchronously and takes nothing, such a pair would be written
 * in the same breath as the one above it and would say nothing the payout row
 * does not already say. It arrives with the first provider whose settlement is
 * asynchronous, which is the first provider that can be pending. Until then
 * "was this actually transferred" is `payouts.state` and `payouts.transfer_id`,
 * which is a fact about somebody else's system and belongs on a row rather than
 * in a chart of accounts.
 */
export const NODE_PAYABLE = 'node_payable';

/** One side of a movement, as `ledger_entries` stores it. */
export interface LedgerEntry {
  account: string;
  debit: number;
  credit: number;
  currency: string;
  refType: string;
  refId: string;
}

/** What both pair builders need to know about the hold they are recording. */
export interface EscrowHoldRef {
  /** `escrow_holds.id`. Both entries carry it, which is what makes them a pair. */
  holdId: string;
  amount: number;
  currency: string;
}

/** `ledger_entries.ref_type` for both pairs below. */
export const REF_TYPE_ESCROW_HOLD = 'escrow_hold';

/**
 * Money the owner authorised becomes an obligation held against a task.
 *
 * **This pair is also written in SQL**, inside `public.accept_offer`, and the
 * duplication is deliberate and argued in that migration's header: acceptance
 * has to be one transaction, and a pair written from Node after that commit
 * could fail to write, leaving an unbalanced ledger. Both sides are pinned by
 * suites asserting the same property, ADR-0011's discipline: `ledger.test.ts`
 * asserts this function balances and `marketplace_engagements.sql` asserts
 * `sum(debit) = sum(credit)` per `ref_id` after a real accept.
 */
export function escrowHoldPair(hold: EscrowHoldRef): LedgerEntry[] {
  return [
    {
      account: OWNER_FUNDS,
      debit: hold.amount,
      credit: 0,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
    {
      account: ESCROW,
      debit: 0,
      credit: hold.amount,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
  ];
}

/**
 * The obligation is unwound and the money goes back to the owner's budget.
 *
 * The exact reverse of `escrowHoldPair`, sharing its `ref_id`, so the two
 * together sum to zero on the hold as well as within themselves. That is what
 * makes "this hold is settled" a readable fact rather than a state column
 * somebody has to trust.
 *
 * Its only producer is `apps/api/src/lib/escrow-reconcile.ts`, which is also
 * what lets the escrow lifecycle map permit `held -> refunded` at all.
 */
export function escrowRefundPair(hold: EscrowHoldRef): LedgerEntry[] {
  return [
    {
      account: ESCROW,
      debit: hold.amount,
      credit: 0,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
    {
      account: OWNER_FUNDS,
      debit: 0,
      credit: hold.amount,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
  ];
}

/**
 * The obligation is discharged: what was held against a task becomes what is
 * owed to the person who did it.
 *
 * **It carries the hold's `ref_id` rather than the payout's**, and that is the
 * one decision in this function. `escrowRefundPair` does the same, and the
 * property both preserve is that every entry about a hold sums to zero on every
 * account once the hold is settled, whichever way it settled. "This hold is
 * finished" is then a fact a reader derives from the ledger rather than a state
 * column they have to trust — which is the whole reason a system that already
 * has `escrow_holds.state` also keeps a ledger.
 *
 * Its only producer is `public.settle_payout`, which is also what lets the
 * escrow lifecycle map permit `held -> released` at all. Unlike the hold pair
 * this is **not** written twice: the release happens inside a database function
 * and nothing in Node writes it, so this function exists to be the authority a
 * reviewer reads and the shape a test pins, and `marketplace_payout.sql` asserts
 * the result in SQL.
 */
export function escrowReleasePair(hold: EscrowHoldRef): LedgerEntry[] {
  return [
    {
      account: ESCROW,
      debit: hold.amount,
      credit: 0,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
    {
      account: NODE_PAYABLE,
      debit: 0,
      credit: hold.amount,
      currency: hold.currency,
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
    },
  ];
}

/**
 * Whether a set of entries balances.
 *
 * **NaN-guarded first, the way `checkSpendCap` guards its amounts**, and for the
 * identical reason: `NaN === NaN` is false, so a set containing one would report
 * as unbalanced for the right reason by accident, while `NaN - NaN` in a subtly
 * different implementation would compare false and report balanced. An amount
 * nobody can reason about is refused rather than arithmetic'd, because a silent
 * arithmetic failure on money is the worst available outcome.
 *
 * The comparison is exact rather than epsilon'd. `ledger_entries` is
 * `numeric(12,2)` and every amount reaching here comes from a `numeric` column
 * or from a single price, so a tolerance would only ever hide a bug.
 */
export function entriesBalance(entries: readonly LedgerEntry[]): boolean {
  if (entries.length === 0) return false;
  for (const e of entries) {
    if (!Number.isFinite(e.debit) || !Number.isFinite(e.credit)) return false;
    if (e.debit < 0 || e.credit < 0) return false;
    // Exactly one side, mirroring `ledger_entries_one_side`. An entry that is
    // both or neither is not a half-movement, it is a row nobody can read.
    if ((e.debit === 0) === (e.credit === 0)) return false;
  }
  const debits = entries.reduce((sum, e) => sum + e.debit, 0);
  const credits = entries.reduce((sum, e) => sum + e.credit, 0);
  return debits === credits;
}
