import { describe, expect, it } from 'vitest';
import {
  createFakeAuthProvider,
  DENY_MARKER,
  fakeAuthorizationCode,
  FAKE_AUTH_PROVIDER,
} from './fake-auth-provider';

const REDIRECT = 'http://localhost:3000/connections/callback';

describe('the fake auth provider', () => {
  it('is registered under a provider name, not a channel name', () => {
    // `fake` is a provider and lives on `channel_connections.provider`. It is
    // deliberately absent from `marketing_channel`.
    expect(createFakeAuthProvider().provider).toBe(FAKE_AUTH_PROVIDER);
    expect(FAKE_AUTH_PROVIDER).toBe('fake');
  });

  describe('authorizeUrl', () => {
    it('resolves its consent page as a sibling of the redirect URI', () => {
      const url = new URL(
        createFakeAuthProvider().authorizeUrl({
          state: 'signed-state',
          redirectUri: REDIRECT,
          scopes: ['ads:read', 'ads:write'],
        }),
      );

      // Same origin as the callback, so there is no second setting to keep in
      // step with the redirect URI.
      expect(url.origin).toBe('http://localhost:3000');
      expect(url.pathname).toBe('/connections/fake-consent');
      expect(url.searchParams.get('state')).toBe('signed-state');
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
      expect(url.searchParams.get('scope')).toBe('ads:read,ads:write');
    });

    it('never mints its own state', () => {
      // The party that checks the state must be the party that issued it, so a
      // provider that invented one would be deciding its own CSRF defence.
      const url = new URL(
        createFakeAuthProvider().authorizeUrl({
          state: 'exactly-this',
          redirectUri: REDIRECT,
          scopes: [],
        }),
      );
      expect(url.searchParams.get('state')).toBe('exactly-this');
    });
  });

  describe('exchangeCode', () => {
    it('is deterministic across instances', async () => {
      const code = fakeAuthorizationCode(['ads:read']);
      const first = await createFakeAuthProvider().exchangeCode({ code, redirectUri: REDIRECT });
      const second = await createFakeAuthProvider().exchangeCode({ code, redirectUri: REDIRECT });

      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
    });

    it('reports the scopes the consent page actually granted', async () => {
      // Not the scopes we asked for. A person can untick one, and the whole
      // point of `granted_scopes` is that we record what came back.
      const result = await createFakeAuthProvider().exchangeCode({
        code: fakeAuthorizationCode(['ads:read']),
        redirectUri: REDIRECT,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.grantedScopes).toEqual(['ads:read']);
    });

    it('round-trips an empty grant as an empty list, not as everything', async () => {
      const result = await createFakeAuthProvider().exchangeCode({
        code: fakeAuthorizationCode([]),
        redirectUri: REDIRECT,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.grantedScopes).toEqual([]);
    });

    it('returns a relative lifetime and never an absolute instant', async () => {
      // The clock lives in `apps/api`. A package with no clock is a package
      // whose tests still pass in six months.
      const result = await createFakeAuthProvider().exchangeCode({
        code: fakeAuthorizationCode(['ads:read']),
        redirectUri: REDIRECT,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.expiresInSeconds).toBe(3600);
      expect(result.value).not.toHaveProperty('expiresAt');
    });

    it('refuses a denial as a value rather than a throw', async () => {
      // The arm that never gets written. As an exception it would be caught by
      // whatever catches transport failures and retried, which means asking
      // somebody who just said no to say no again.
      const result = await createFakeAuthProvider().exchangeCode({
        code: `fake-code.${DENY_MARKER}`,
        redirectUri: REDIRECT,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('access_denied');
    });

    it('refuses a code it did not mint, and calls it our fault', async () => {
      const result = await createFakeAuthProvider().exchangeCode({
        code: 'code-from-somewhere-else',
        redirectUri: REDIRECT,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // `invalid_spec` means stop, not retry. The fault is on our side.
      expect(result.error.kind).toBe('invalid_spec');
    });
  });

  describe('refresh', () => {
    it('refuses a token it did not issue', async () => {
      const result = await createFakeAuthProvider().refresh('not-ours');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('auth_expired');
    });

    it('is deterministic for the same refresh token', async () => {
      const exchanged = await createFakeAuthProvider().exchangeCode({
        code: fakeAuthorizationCode(['ads:read']),
        redirectUri: REDIRECT,
      });
      expect(exchanged.ok).toBe(true);
      if (!exchanged.ok) return;

      const token = exchanged.value.refreshToken as string;
      expect(await createFakeAuthProvider().refresh(token)).toEqual(
        await createFakeAuthProvider().refresh(token),
      );
    });
  });
});
