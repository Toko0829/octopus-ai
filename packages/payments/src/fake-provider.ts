import type {
  ChargeResult,
  CreateChargeInput,
  CreateTransferInput,
  PaymentProvider,
  TransferResult,
} from './provider';

/** The registry key. One entry today, and it is this one. */
export const FAKE_PROVIDER = 'fake';

/**
 * A payment provider that takes no money.
 *
 * The counterpart of `createFakeAdapter` and `createFakeVerifier`, and it exists
 * for the same reason both of those do: the alternative to an in-repo fake is
 * either a paid account nobody has, or a code path with no implementation at
 * all, and the second is how a slice ships a button that does nothing.
 *
 * **Deterministic, and that is the only interesting property.** `chargeId` is
 * derived from the idempotency key rather than randomised, so:
 *
 *   * a retried accept computes the same key (`escrowKey(offerId)`), asks for
 *     the same charge, and is handed back **the same reference**, which is what
 *     a real idempotent provider does and what the replayed `accept_offer` then
 *     stores against the hold it already made;
 *   * a test can assert the exact string rather than that "something came back",
 *     which is the difference between pinning behaviour and pinning a shape;
 *   * nothing anywhere depends on a random value, so a replay is reproducible.
 *
 * The `ch_fake_` prefix is not decoration. It appears in `escrow_holds.charge_id`
 * on every row this build writes, so anybody reading the table, a log line or a
 * support ticket can tell at a glance that no money was involved. A reference
 * that looked like a real Stripe id would be a fake wearing a costume in the one
 * table where that would be actively misleading.
 */
export function createFakeProvider(): PaymentProvider {
  return {
    async createCharge(input: CreateChargeInput): Promise<ChargeResult> {
      return { chargeId: fakeChargeId(input.idempotencyKey) };
    },

    /**
     * **Pays nobody.** No network call, no account, no rail; the `destination`
     * is read only so that a caller passing nothing is a type error rather than
     * a silent transfer into the void.
     *
     * Deterministic for `createCharge`'s reasons, and one of them is sharper
     * here: the payout sweep records `transfer_id` on the payout row *after*
     * this returns, so a crash in that window is resumed by calling this again
     * with the same key. A random reference would make the retry store a second
     * id for a transfer that, at a real idempotent provider, happened once.
     */
    async transfer(input: CreateTransferInput): Promise<TransferResult> {
      void input.destination;
      return { transferId: fakeTransferId(input.idempotencyKey) };
    },
  };
}

/**
 * The derivation, exported so a test and a fixture can name the same string
 * without importing the provider and calling it.
 *
 * Non-alphanumerics are collapsed to `_` so the result is safe in a log line, a
 * URL and a SQL string literal. That is lossy and does not matter: the reference
 * is an opaque token in this build and the key it came from is on the same row.
 */
export function fakeChargeId(idempotencyKey: string): string {
  return `ch_fake_${idempotencyKey.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}

/**
 * The same derivation for a transfer, under its own prefix.
 *
 * **`tr_fake_` rather than `ch_fake_`**, and the prefixes differ for the reason
 * they exist at all: `payouts.transfer_id` and `escrow_holds.charge_id` are
 * different references to different acts, and a shared prefix would let somebody
 * reconciling the two tables believe a charge and a transfer were the same
 * event. Both stay visibly fake, in the two tables where a reader most needs to
 * know that no money was involved.
 */
export function fakeTransferId(idempotencyKey: string): string {
  return `tr_fake_${idempotencyKey.replace(/[^a-zA-Z0-9]+/g, '_')}`;
}
