/**
 * The registry has one job that matters and it is the refusal.
 *
 * An unknown provider that fell back to the fake would be the worst available
 * failure on this path: the publish executor would report success, an
 * `ad_entities` row would carry a `fake:` external id, the audit trail would say
 * the campaign went live, and nothing would have reached any platform. It fails
 * as success, which is the failure shape this repository keeps paying for.
 */

import { describe, expect, it } from 'vitest';
import {
  ADAPTER_REGISTRY,
  adapterFor,
  isRegisteredProvider,
  registeredProviders,
} from './adapter-registry';
import { FAKE_PROVIDER } from './fake-adapter';

describe('an unknown provider raises', () => {
  it('throws rather than returning undefined for a caller to ignore', () => {
    expect(() => adapterFor('meta')).toThrow(/Unknown ad provider "meta"/);
  });

  it('never falls back to the fake', () => {
    // Stated as its own assertion because "throws" and "does not silently
    // substitute" are different properties, and only the second one is what
    // makes a false audit trail impossible.
    let built: unknown = null;
    try {
      built = adapterFor('not-a-provider');
    } catch {
      // expected
    }
    expect(built).toBeNull();
  });

  it('says what is registered, so the error is actionable', () => {
    expect(() => adapterFor('google')).toThrow(new RegExp(FAKE_PROVIDER));
  });

  it('does not resolve a provider through the prototype chain', () => {
    // `ADAPTER_REGISTRY['constructor']` is truthy on an ordinary object literal,
    // and a truthiness check would happily call it. The provider string can
    // originate from a database column, so this is reachable input rather than
    // a hypothetical.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(isRegisteredProvider(name)).toBe(false);
      expect(() => adapterFor(name)).toThrow();
    }
  });

  it('refuses the empty string', () => {
    expect(() => adapterFor('')).toThrow();
  });
});

describe('what is registered today', () => {
  it('is the fake, and only the fake', () => {
    // A real provider arriving here is a reviewed change with its own ADR and
    // the envelope encryption its credentials require. If this assertion starts
    // failing, that review is what the failure is asking about.
    expect(registeredProviders()).toEqual([FAKE_PROVIDER]);
  });

  it('builds a fresh adapter per call, so no state is shared between projects', async () => {
    const one = adapterFor(FAKE_PROVIDER);
    const two = adapterFor(FAKE_PROVIDER);

    expect(one).not.toBe(two);

    await one.createCampaign(
      { name: 'A', channel: 'meta', budgetCap: 1, currency: 'USD' },
      'shared-key',
    );
    const fromTwo = await two.createCampaign(
      { name: 'A', channel: 'meta', budgetCap: 1, currency: 'USD' },
      'shared-key',
    );

    expect(fromTwo.ok && fromTwo.alreadyExisted).toBe(false);
  });

  it('exposes the adapter under the same key the connection column stores', () => {
    expect(adapterFor(FAKE_PROVIDER).provider).toBe(FAKE_PROVIDER);
    expect(Object.keys(ADAPTER_REGISTRY)).toContain(FAKE_PROVIDER);
  });
});
