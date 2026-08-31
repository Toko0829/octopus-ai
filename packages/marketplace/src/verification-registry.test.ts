/**
 * The registry's whole value is what it refuses, so the refusals are the tests.
 *
 * `carriesRealPii` gets the most attention here for the reason its own docstring
 * gives: answering `false` for an unregistered provider is the inversion that
 * would let a writer record identity verdicts from an implementation nobody
 * read.
 */

import { describe, expect, it } from 'vitest';
import {
  VERIFIER_REGISTRY,
  carriesRealPii,
  isRegisteredVerifier,
  registeredVerifiers,
  verifierFor,
} from './verification-registry';
import { FAKE_VERIFIER } from './fake-verifier';

describe('the registry', () => {
  it('holds the fake and nothing else', () => {
    // Not a style assertion. A second entry means somebody wired a real KYC
    // vendor, and that change has to arrive with a DPA, a retention schedule and
    // a deletion path, so it should fail a test until this line is updated
    // deliberately.
    expect(registeredVerifiers()).toEqual([FAKE_VERIFIER]);
  });

  it('says the fake collects no real identity data', () => {
    expect(carriesRealPii(FAKE_VERIFIER)).toBe(false);
  });

  it('is frozen, so nothing registers a provider at runtime', () => {
    expect(Object.isFrozen(VERIFIER_REGISTRY)).toBe(true);
  });
});

describe('an unregistered provider', () => {
  it('raises from verifierFor rather than falling back to the fake', () => {
    expect(() => verifierFor('persona')).toThrow(/Unknown identity verifier "persona"/);
  });

  it('raises from carriesRealPii rather than answering false', () => {
    // Fail closed. `false` here would mean "we have never heard of it, so it
    // certainly holds nothing", which is exactly backwards.
    expect(() => carriesRealPii('persona')).toThrow(/Unknown identity verifier/);
  });

  it('names what is registered, so the error is actionable', () => {
    expect(() => verifierFor('stripe-identity')).toThrow(/Registered: fake/);
  });

  it('points at the file rather than at a table', () => {
    expect(() => verifierFor('nope')).toThrow(/verification-registry\.ts, not a row/);
  });
});

describe('prototype keys are not providers', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('refuses %s', (key) => {
    expect(isRegisteredVerifier(key)).toBe(false);
    expect(() => verifierFor(key)).toThrow(/Unknown identity verifier/);
  });
});
