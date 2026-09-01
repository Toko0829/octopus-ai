import type { PaymentProvider } from './provider';
import { createFakeProvider, FAKE_PROVIDER } from './fake-provider';

/**
 * The payment providers Octopus will talk to, declared rather than discovered.
 *
 * The third registry of this shape (`ADAPTER_REGISTRY`, `AUTH_PROVIDER_REGISTRY`,
 * `VERIFICATION_REGISTRY`) and the argument is verbatim theirs: every entry is a
 * claim that somebody reviewed what this implementation does with a person's
 * money. **A file gets reviewed in a diff; a row does not.** A provider registry
 * in Postgres would let a row nobody read put the escrow path in front of an
 * implementation nobody read either.
 *
 * `escrow_holds` therefore has no `provider` column and no check constraint on
 * one. The authority is here, and a second copy in the database would be a
 * second thing to keep in step.
 */
export interface PaymentProviderEntry {
  create: () => PaymentProvider;
  /**
   * **The enforced half of the accepted risk**, and the reason this registry has
   * a flag its marketing sibling does not need in the same shape.
   *
   * `carriesRealCredentials` guards plaintext channel tokens and
   * `carriesRealPii` guards identity documents. This guards the one thing with a
   * regulator attached: payments-billing.md's counsel gate says that **before
   * real (non-test) money moves**, money-transmission and escrow-licensing must
   * be cleared per jurisdiction, platform-of-record determined, and tax
   * reporting settled.
   *
   * That gate is a paragraph, and a paragraph is not a control. This is the
   * control: `apps/api/src/lib/engagements.ts` refuses before any rpc when this
   * is true, so **the first person to register Stripe hits a failing write
   * rather than a paragraph they did not read.** Clearing the gate is what makes
   * flipping this flag a reviewed act rather than a config change.
   */
  carriesRealMoney: boolean;
}

export const PAYMENT_PROVIDER_REGISTRY: Readonly<Record<string, PaymentProviderEntry>> =
  Object.freeze({
    [FAKE_PROVIDER]: Object.freeze({
      create: createFakeProvider,
      // Nothing is charged, nothing is captured, nothing is transferred, and no
      // network call is made. See 20260904121000's header.
      carriesRealMoney: false,
    }),
  });

export function registeredPaymentProviders(): string[] {
  return Object.keys(PAYMENT_PROVIDER_REGISTRY);
}

export function isRegisteredPaymentProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAYMENT_PROVIDER_REGISTRY, provider);
}

/**
 * Build the provider for a name, or raise.
 *
 * `hasOwnProperty` rather than a truthiness check, so `constructor` and
 * `toString` do not resolve through the prototype chain into something that is
 * not a provider. The map is frozen; the explicit check is what a reader can see.
 *
 * **It never falls back to the fake.** Defaulting to it would be the worst
 * available failure here, because the accept path would report success while no
 * charge existed anywhere. Same stance as `adapterFor`, `verifierFor` and the
 * crawl registry: a value we cannot read is not a value we may guess at.
 */
export function providerFor(provider: string): PaymentProvider {
  const entry = PAYMENT_PROVIDER_REGISTRY[provider];
  if (!isRegisteredPaymentProvider(provider) || !entry) {
    throw new Error(
      `Unknown payment provider "${provider}". Registered: ${registeredPaymentProviders().join(', ')}. ` +
        'Adding one is a reviewed change to packages/payments/src/provider-registry.ts, not a row.',
    );
  }
  return entry.create();
}

/**
 * Whether this provider moves real money, or raise.
 *
 * **Raises on an unregistered name rather than answering `false`**, and this is
 * the exact inversion `carriesRealPii` was written for: "a provider we have
 * never heard of certainly moves no money" is the assumption that would let an
 * unreviewed integration through the one check standing in front of the counsel
 * gate. Unknown means refused, not safe.
 */
export function carriesRealMoney(provider: string): boolean {
  const entry = PAYMENT_PROVIDER_REGISTRY[provider];
  if (!isRegisteredPaymentProvider(provider) || !entry) {
    throw new Error(
      `Unknown payment provider "${provider}", so whether it moves real money is not known. ` +
        `Registered: ${registeredPaymentProviders().join(', ')}.`,
    );
  }
  return entry.carriesRealMoney;
}
