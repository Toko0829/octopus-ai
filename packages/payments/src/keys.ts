/**
 * Idempotency keys, derived rather than generated.
 *
 * Rule 9 puts an idempotency key on every external side effect, backed by a
 * unique constraint. A generated key satisfies the letter of that and none of
 * its purpose: a retry mints a second random string and the constraint never
 * fires. A key derived from the row the effect is about collides on the retry,
 * which is the entire mechanism.
 *
 * Both keys below are derived from an id that is already unique in Postgres, so
 * the uniqueness is inherited rather than assumed. The prefixes exist because
 * `escrow_holds.idempotency_key` is one namespace shared by every writer, and a
 * bare uuid would let two different acts collide on the same string.
 */

/**
 * The key for the hold created when an offer is accepted.
 *
 * **Derived from the offer, not from the task**, and that difference is what
 * makes it naturally epoch-ed. A step that came back to the market after a
 * decline is offered again as a NEW offer row, so accepting on the second round
 * derives a different key rather than colliding with the first round's hold and
 * silently funding nothing. `publishIdempotencyKey` in `packages/marketing`
 * needed an explicit epoch counter for exactly the case this shape avoids.
 *
 * `public.accept_offer` builds the same string in SQL (`'escrow:' || p_offer_id`)
 * because the insert has to be inside the accept's transaction. The two are
 * pinned by `keys.test.ts` here and by the pgTAP assertion on
 * `escrow_holds.idempotency_key` in `marketplace_engagements.sql`.
 */
export function escrowKey(offerId: string): string {
  return `escrow:${offerId}`;
}

/**
 * The key naming the reversal the reconcile sweep performs.
 *
 * Derived from the hold rather than from the offer, because a refund is about a
 * hold: one hold refunds once, and a sweep that runs every thirty seconds has to
 * derive the same string every pass.
 *
 * **What it actually guards is the system message**, and being precise about
 * that matters, because the two things a refund writes are made idempotent by
 * two different mechanisms and only one of them is a key.
 *
 *   * The **refund itself** and its ledger pair are guarded by the conditional
 *     `held -> refunded` UPDATE. A second pass matches zero rows and performs
 *     nothing, so the pair is never written twice. `ledger_entries` deliberately
 *     has no unique key of its own: entries are appended in pairs and a unique
 *     constraint over an account plus a reference would forbid the perfectly
 *     legal case of a hold that is later disputed and re-entered.
 *   * The **message to the owner** is guarded by this key against
 *     `messages.idempotency_key`, exactly as every other sweep's announcement
 *     is, because a message is written after the act it describes and a crash
 *     between the two must not produce two lines.
 */
export function refundKey(holdId: string): string {
  return `escrow-refund:${holdId}`;
}

/**
 * The key for the transfer that pays a node for work an owner approved.
 *
 * **Derived from the engagement**, which is the same choice `escrowKey` makes
 * one level down and for the same reason. A step that was taken, abandoned past
 * its deadline and reassigned has **two** engagements, and the second one is a
 * different deal with a different node at a possibly different price. A key
 * derived from the task would have the second payout collide with the first,
 * read back a row belonging to somebody else, and report the wrong person paid;
 * a key derived from the offer would work today only because acceptance mints
 * exactly one engagement per offer, which is a coincidence of the current schema
 * rather than a property of a payout. One engagement is paid once, so the
 * engagement is what the key is about.
 *
 * It does **two** jobs, and unlike `refundKey` both of them are real:
 *
 *   * `payouts.idempotency_key` is unique, so a sweep pass that inserted a row
 *     and then died collides on the retry and reads its own row back rather than
 *     starting a second payout for the same work. It is also what the provider
 *     is handed, so an idempotent provider answers the retry with the transfer
 *     it already made instead of a second one;
 *   * `messages.idempotency_key` on the line that tells the owner somebody was
 *     paid, which is written after the act it describes and must not double.
 *
 * Unlike `escrowKey` there is **no second derivation in SQL**: the payout row is
 * inserted from Node, before the transfer, so `public.settle_payout` is handed a
 * payout id and never rebuilds a string. `keys.test.ts` is therefore the only
 * place this needs pinning.
 */
export function payoutKey(engagementId: string): string {
  return `payout:${engagementId}`;
}
