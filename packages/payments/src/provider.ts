/**
 * The payment seam, written before there is a payment.
 *
 * `packages/marketing/src/adapter.ts` exists for the same reason and states it:
 * an interface written ahead of the first executor means the code that calls it
 * is written against a shape somebody chose, rather than against whichever
 * provider happened to arrive first. The provider that arrives first here will
 * be Stripe, and Stripe's separate-charges-and-transfers model is a strong
 * opinion about how money should be shaped; inheriting that opinion by accident
 * is what this file exists to prevent.
 *
 * **One method, and the narrowness is the point.** payments-billing.md specifies
 * six steps: pre-auth, hold, approve, transfer, payout, dispute. Only the hold
 * has a caller in this slice. Declaring `transfer()` and `refund()` now would be
 * an interface with no implementation and no caller on either side, which is the
 * same defect as a state with no writer, one abstraction layer up. They arrive
 * with their slices.
 *
 * **The refund in this slice does not go through here, deliberately.** The
 * reconcile sweep unwinds a *modelled* obligation: it moves a row from `held` to
 * `refunded` and writes the reversing ledger pair. Nothing was ever captured, so
 * there is nothing to refund at a provider. Routing it through a
 * `provider.refund()` that the only implementation would answer trivially would
 * dress up an internal correction as money movement, in the one domain where
 * that distinction is the whole regulatory posture (see the counsel gate in
 * payments-billing.md).
 */

/** What a hold needs. No customer, no card, no account: see `PaymentProvider`. */
export interface CreateChargeInput {
  amount: number;
  currency: string;
  /**
   * Derived from the row the charge is about (`packages/payments/src/keys.ts`),
   * never generated. A provider that honours it returns the same charge for a
   * retry, which is the second layer behind the unique constraint on
   * `escrow_holds.idempotency_key`.
   */
  idempotencyKey: string;
}

/** The provider's own reference. Not a secret; it authorises nothing. */
export interface ChargeResult {
  chargeId: string;
}

/**
 * **No customer, no payment method and no connected account appear anywhere in
 * this interface**, and that is a deliberate boundary rather than a gap to fill
 * in later. Rule 11 forbids the AI from entering banking or card data at all,
 * and the first real provider will take those from a Stripe customer id held
 * against the workspace, established by a person through Stripe's own hosted
 * flow. Nothing in this codebase should ever be shaped so that a card number
 * could be passed through it.
 */
export interface PaymentProvider {
  createCharge(input: CreateChargeInput): Promise<ChargeResult>;
}

/** Thrown when a provider could not answer. Never used to mean "declined". */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}
