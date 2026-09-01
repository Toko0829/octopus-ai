/**
 * The registry, and the two functions that raise rather than answer falsy.
 *
 * Both refusals are the same inversion the verification registry records:
 * "a provider we have never heard of certainly moves no money" is the assumption
 * that would let an unreviewed integration past the one check standing in front
 * of the counsel gate in payments-billing.md.
 */

import { describe, expect, it } from 'vitest';
import { FAKE_PROVIDER } from './fake-provider';
import {
  PAYMENT_PROVIDER_REGISTRY,
  carriesRealMoney,
  isRegisteredPaymentProvider,
  providerFor,
  registeredPaymentProviders,
} from './provider-registry';

describe('the registry', () => {
  it('has exactly one entry, and it is the fake', () => {
    // Asserted rather than assumed. The day a second entry lands, this test
    // fails and somebody reads the counsel gate before changing the number.
    expect(registeredPaymentProviders()).toEqual([FAKE_PROVIDER]);
  });

  it('reports the fake as moving no real money', () => {
    expect(carriesRealMoney(FAKE_PROVIDER)).toBe(false);
  });

  it('is frozen, so a caller cannot register a provider at runtime', () => {
    expect(Object.isFrozen(PAYMENT_PROVIDER_REGISTRY)).toBe(true);
  });
});

describe('unknown providers raise', () => {
  it('providerFor raises rather than falling back to the fake', () => {
    // Falling back would be the worst available failure: the accept path would
    // report success while no charge existed anywhere.
    expect(() => providerFor('stripe')).toThrow(/Unknown payment provider/);
  });

  it('carriesRealMoney raises rather than answering false', () => {
    expect(() => carriesRealMoney('stripe')).toThrow(/Unknown payment provider/);
  });

  it('does not resolve inherited properties as providers', () => {
    // `hasOwnProperty` rather than truthiness, so `constructor` and `toString`
    // do not walk the prototype chain into something that is not a provider.
    expect(isRegisteredPaymentProvider('constructor')).toBe(false);
    expect(() => providerFor('toString')).toThrow(/Unknown payment provider/);
  });
});
