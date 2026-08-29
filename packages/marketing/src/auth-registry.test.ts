import { describe, expect, it } from 'vitest';
import {
  AUTH_PROVIDER_REGISTRY,
  authProviderFor,
  carriesRealCredentials,
  defaultScopesFor,
  isRegisteredAuthProvider,
  registeredAuthProviders,
} from './auth-registry';
import { FAKE_AUTH_PROVIDER } from './fake-auth-provider';

describe('the channel auth registry', () => {
  it('holds only the fake today', () => {
    expect(registeredAuthProviders()).toEqual([FAKE_AUTH_PROVIDER]);
  });

  it('builds a fresh provider per call', () => {
    // Factories rather than instances, so no per-connection state is shared
    // between two rooms by accident.
    expect(authProviderFor(FAKE_AUTH_PROVIDER)).not.toBe(authProviderFor(FAKE_AUTH_PROVIDER));
  });

  it('raises on an unknown provider instead of falling back to the fake', () => {
    // A silent fallback would mean storing a credential under a provider name
    // nobody registered, and later handing it to whatever answered to it.
    expect(() => authProviderFor('meta')).toThrow(/Unknown channel auth provider "meta"/);
    expect(() => authProviderFor('meta')).toThrow(/reviewed change/);
  });

  it('does not resolve prototype members as providers', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(isRegisteredAuthProvider(name)).toBe(false);
      expect(() => authProviderFor(name)).toThrow();
    }
  });

  it('is frozen, so nothing registers a provider at runtime', () => {
    expect(Object.isFrozen(AUTH_PROVIDER_REGISTRY)).toBe(true);
  });

  describe('carriesRealCredentials', () => {
    it('is false for the fake, which is what makes the accepted risk acceptable', () => {
      // security-compliance.md accepts plaintext tokens ONLY while this is the
      // only provider. If this assertion ever needs changing, envelope
      // encryption lands in the same commit.
      expect(carriesRealCredentials(FAKE_AUTH_PROVIDER)).toBe(false);
    });

    it('raises on an unknown provider rather than answering false', () => {
      // The dangerous reading is "a provider we have never heard of certainly
      // does not carry real credentials", which would let the writer store its
      // token. Fail closed.
      expect(() => carriesRealCredentials('meta')).toThrow(/Unknown channel auth provider/);
    });
  });

  describe('defaultScopesFor', () => {
    it('returns a copy, so a caller cannot edit the registry', () => {
      const scopes = defaultScopesFor(FAKE_AUTH_PROVIDER);
      scopes.push('ads:delete');
      expect(defaultScopesFor(FAKE_AUTH_PROVIDER)).not.toContain('ads:delete');
    });

    it('raises on an unknown provider', () => {
      expect(() => defaultScopesFor('meta')).toThrow(/Unknown channel auth provider/);
    });
  });
});
