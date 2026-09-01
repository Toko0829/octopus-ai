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
 * **Two methods, and the narrowness is still the point.** payments-billing.md
 * specifies six steps: pre-auth, hold, approve, transfer, payout, dispute. The
 * hold got its caller in slice 5 and this file said the rest would "arrive with
 * their slices"; `transfer()` is that arriving, with `apps/api/src/lib/payout.ts`
 * calling it in the same push. **`refund()` still does not exist**, and the
 * paragraph below says why that is a decision rather than an omission.
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

/** What a transfer needs. See `destination`, which is the interesting field. */
export interface CreateTransferInput {
  amount: number;
  currency: string;
  /**
   * Who is being paid.
   *
   * **This is the node's own user id in this build, and it is not a bank
   * account.** The first real provider will need a Stripe Connect Express
   * connected-account id, which a person establishes for themselves through
   * Stripe's own hosted onboarding — Stripe collects their KYC, their tax
   * details and their bank details, and hands back an `acct_…` that this field
   * would then carry.
   *
   * **There is deliberately no `node_profiles.payout_account_id` column waiting
   * for that.** A column with no writer is the defect this repository has
   * recorded six times, most expensively as `room_members.scope`, which sat
   * unenforced for forty-four migrations while reading as a control. Connect
   * onboarding is a slice: a route, a redirect, a webhook and a place for a
   * person to see whether they can be paid yet. It gets its column when it gets
   * its writer.
   *
   * Typed as an opaque string for that reason, so the day the meaning changes
   * the type does not have to.
   */
  destination: string;
  /**
   * Derived from the engagement being paid (`packages/payments/src/keys.ts`),
   * never generated, and handed to the provider as well as stored: the unique
   * constraint on `payouts.idempotency_key` stops us starting a second payout,
   * and this stops an idempotent provider making a second transfer if we ask
   * anyway.
   */
  idempotencyKey: string;
}

/** The provider's own reference for the transfer. Not a secret. */
export interface TransferResult {
  transferId: string;
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
  /**
   * Pay a node for work an owner approved.
   *
   * **The one call in this interface that moves money outward**, which is why
   * `carriesRealMoney` is checked before it rather than only before the charge.
   * `apps/api/src/lib/payout.ts` refuses on that flag before reaching here.
   *
   * A provider that could not pay throws `PaymentError`. **There is no refusal
   * kind and no `AdapterResult`-style union here, deliberately**, and the
   * difference from `packages/marketing`'s seam is the difference in what the
   * two calls ask. An ad platform genuinely decides whether to accept a
   * creative, so "policy_rejected" is an answer and retrying it unchanged asks
   * the same reviewer the same question. A transfer for work an owner has
   * already approved is not a question anybody gets to answer no to on our
   * behalf: if a real provider ever refuses one, a person has to look at it, and
   * the place for that is the ops console. So **every failure here is
   * transient** as far as this codebase is concerned, retried at tick cadence
   * and logged loudly, and the alternative — a terminal row against work
   * somebody did, in a build with no console that can un-terminal it — is the
   * worse outcome. `payouts.state` carries `failed` as vocabulary and the map
   * refuses the arc, exactly as `escrow_holds` carried `released`.
   */
  transfer(input: CreateTransferInput): Promise<TransferResult>;
}

/** Thrown when a provider could not answer. Never used to mean "declined". */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentError';
  }
}
