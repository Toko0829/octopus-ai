/**
 * `@octopus/payments` — money as arithmetic somebody can check, and no money at
 * all.
 *
 * The `@octopus/marketing` split applied to payments: what belongs here is the
 * reasoning a reader can verify without running anything, and what does not
 * belong here is IO. **There is no Supabase client, no `fetch`, no filesystem
 * access and no clock anywhere in this package.** The reads and writes that feed
 * it are queries in `apps/api` and statements inside `public.accept_offer`.
 *
 * **Nothing in this package moves money, and nothing in this build can.** The
 * only registered provider is the in-repo fake, `carriesRealMoney` is the
 * enforced half of payments-billing.md's counsel gate, and the API writer
 * refuses on it before any rpc. See `20260904121000_escrow_holds.sql` for the
 * full statement of the posture.
 *
 * ---
 *
 * **Why `packages/payments` and not `packages/core`.** payments-billing.md's
 * owner-paths line said the ledger lives in `packages/core`, and it now says
 * `packages/payments/**` instead. The reason is mechanical rather than
 * aesthetic: `.docmeta.yml` maps `packages/core/**` to
 * business-projects-workflow.md, so a ledger there would be **doc-mapped to the
 * wrong module by construction** — every change to the chart of accounts would
 * be obliged to edit the workflow doc and free to leave the payments doc
 * untouched. The doc is amended in place rather than worked around, which is the
 * `credentials -> node_credentials` precedent: when the specification and the
 * schema disagree, reconcile rather than diverge (rule 1).
 *
 * ---
 *
 * Four things live here.
 *
 * **The chart of accounts and the balanced pairs** (`ledger.ts`), because a
 * double-entry invariant is a property of two rows and Postgres cannot assert it
 * cheaply. There is no exported way to build a single entry.
 *
 * **The idempotency keys** (`keys.ts`), derived from the row each effect is
 * about rather than generated, because a generated key satisfies rule 9's letter
 * and none of its purpose.
 *
 * **The provider seam** (`provider.ts`), written before there is a payment so
 * the calling code faces a shape somebody chose rather than Stripe's. One
 * method, because only the hold has a caller.
 *
 * **The registry** (`provider-registry.ts`), checked in rather than stored,
 * carrying `carriesRealMoney` for the reason `carriesRealCredentials` and
 * `carriesRealPii` exist on their siblings.
 *
 * See docs/30-modules/payments-billing.md.
 */

export {
  OWNER_FUNDS,
  ESCROW,
  REF_TYPE_ESCROW_HOLD,
  entriesBalance,
  escrowHoldPair,
  escrowRefundPair,
  type EscrowHoldRef,
  type LedgerEntry,
} from './ledger';

export { escrowKey, refundKey } from './keys';

export {
  PaymentError,
  type ChargeResult,
  type CreateChargeInput,
  type PaymentProvider,
} from './provider';

export { createFakeProvider, fakeChargeId, FAKE_PROVIDER } from './fake-provider';

export {
  PAYMENT_PROVIDER_REGISTRY,
  carriesRealMoney,
  isRegisteredPaymentProvider,
  providerFor,
  registeredPaymentProviders,
  type PaymentProviderEntry,
} from './provider-registry';
