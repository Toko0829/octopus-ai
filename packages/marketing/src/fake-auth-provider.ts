/**
 * A complete, deterministic implementation of the auth seam, with no
 * authorization server behind it.
 *
 * The sibling of `fake-adapter.ts`, and it keeps the same three properties.
 * **Everything is derived, nothing is invented**: the same code yields the same
 * tokens and the same account id, in this process or the next one or in CI.
 * **No clock, no randomness, no network**, which is why `expiresInSeconds` is
 * relative and the caller is the half that knows what time it is. And **the
 * refusal is a first-class outcome**, because the arm where somebody declines on
 * a consent screen is the one that never gets written.
 *
 * **Its authorization server is a page in our own web app**, at
 * `/connections/fake-consent`, resolved as a sibling of whatever redirect URI it
 * is handed. That colocation is the honest thing rather than a shortcut: this
 * provider is not pretending to be a platform, it is a way to exercise the whole
 * three-legged round trip, including a person clicking Cancel, without an
 * account anywhere. A real provider returns its own origin here and nothing else
 * about this file changes.
 */

import { createHash } from 'node:crypto';
import {
  DENY_MARKER,
  FAKE_CODE_PREFIX,
  fakeAuthorizationCode,
  scopesFromFakeCode,
} from './fake-consent-code';
import type {
  AuthorizeRequest,
  AuthResult,
  ChannelAuthProvider,
  ChannelCredential,
  ExchangeRequest,
} from './auth';

export const FAKE_AUTH_PROVIDER = 'fake';

// The code format is shared with the consent screen, which runs in a browser and
// therefore cannot import this file: `node:crypto` below is exactly what it must
// not pull in. Re-exported so callers have one import rather than two.
export { DENY_MARKER, fakeAuthorizationCode };

function derive(label: string, code: string): string {
  return `${label}:${createHash('sha256').update(`${label}|${code}`).digest('hex').slice(0, 24)}`;
}

function credentialFor(code: string): ChannelCredential {
  return {
    accessToken: derive('fake-access', code),
    refreshToken: derive('fake-refresh', code),
    // Deliberately finite rather than null. A non-expiring token would leave
    // `token_expires_at` unwritten by the only provider that exists, so the
    // column and everything that renders it would go untested until the first
    // real platform arrived. One hour is what most of them issue.
    expiresInSeconds: 3600,
    grantedScopes: scopesFromFakeCode(code),
    externalAccountId: derive('fake-acct', code),
  };
}

export function createFakeAuthProvider(): ChannelAuthProvider {
  return {
    provider: FAKE_AUTH_PROVIDER,

    authorizeUrl({ state, redirectUri, scopes }: AuthorizeRequest): string {
      // Resolved against the redirect URI rather than configured, so the fake
      // consent page is always on the same origin the callback will land on and
      // there is no second setting to keep in step.
      const url = new URL('fake-consent', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', scopes.join(','));
      return url.toString();
    },

    async exchangeCode({ code }: ExchangeRequest): Promise<AuthResult<ChannelCredential>> {
      if (code.includes(DENY_MARKER)) {
        return {
          ok: false,
          error: { kind: 'access_denied', message: 'The account owner declined the connection.' },
        };
      }
      if (!code.startsWith(FAKE_CODE_PREFIX)) {
        // A code this provider did not mint. `invalid_spec` rather than
        // `provider_error`, because the fault is on our side of the wire and the
        // caller should stop rather than retry.
        return {
          ok: false,
          error: { kind: 'invalid_spec', message: 'That is not an authorization code we issued.' },
        };
      }
      return { ok: true, value: credentialFor(code) };
    },

    async refresh(refreshToken: string): Promise<AuthResult<ChannelCredential>> {
      if (!refreshToken.startsWith('fake-refresh:')) {
        return {
          ok: false,
          error: { kind: 'auth_expired', message: 'That refresh token was not issued by us.' },
        };
      }
      // Derived from the refresh token, so refreshing twice with the same token
      // yields the same credential. A provider that rotated its refresh token
      // would return a new one here; this one does not, and nothing calls it.
      return {
        ok: true,
        value: {
          accessToken: derive('fake-access', refreshToken),
          refreshToken,
          expiresInSeconds: 3600,
          grantedScopes: [],
          externalAccountId: null,
        },
      };
    },
  };
}
