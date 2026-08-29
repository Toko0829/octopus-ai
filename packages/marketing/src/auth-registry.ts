/**
 * Which providers a workspace may connect an account to, declared rather than
 * discovered.
 *
 * The sibling of `adapter-registry.ts` and it holds the same stance for the same
 * reason: **a file gets reviewed in a diff by a person; a row does not.** Every
 * entry here is a claim that somebody read what this implementation does with a
 * person's account credentials. `channel_connections.provider` is plain `text`
 * validated against this map, which is why the column carries no enum.
 *
 * **An unknown provider raises**, never falls back to the fake. On the publish
 * path a silent fallback would report success while nothing reached a platform;
 * here it would be worse, because it would mean storing a credential under a
 * provider name nobody registered and later handing it to whichever adapter
 * answered to that string.
 */

import type { ChannelAuthProvider } from './auth';
import { createFakeAuthProvider, FAKE_AUTH_PROVIDER } from './fake-auth-provider';

/**
 * What connecting to this provider actually puts in the database.
 *
 * `carriesRealCredentials` is the enforced half of an accepted risk, and it is
 * the reason this registry holds records rather than bare factories.
 * `channel_connections` stores `access_token` and `refresh_token` as plain
 * columns. security-compliance.md accepts that **only** while the sole provider
 * is the in-repo fake whose tokens authorise nothing and reach no network, and
 * names the trigger to fix it: the first real provider credential, "in that
 * change, not after it, because the interval between a real token landing and
 * the encryption landing is exactly the exposure".
 *
 * That was a sentence in a document, and the next person to add Meta was not
 * going to read it. `writeConnection` refuses to store a token for any provider
 * where this is true, so the trigger fires as a failing write rather than as a
 * paragraph nobody opened.
 */
export interface AuthProviderEntry {
  create: () => ChannelAuthProvider;
  /**
   * True when a successful exchange yields a credential that authorises real
   * actions on somebody's real account. Set it truthfully; it is the only thing
   * standing between a live token and a plaintext column.
   */
  carriesRealCredentials: boolean;
  /**
   * What we ask the platform for. Requested, not granted: a person can untick a
   * scope on the consent screen, and `checkScopes` compares this against what
   * came back.
   */
  defaultScopes: readonly string[];
}

export const AUTH_PROVIDER_REGISTRY: Readonly<Record<string, AuthProviderEntry>> = Object.freeze({
  // The only entry today. A real provider lands with its own ADR, its own
  // registered redirect URI, and the envelope encryption the flag above is
  // there to insist on.
  [FAKE_AUTH_PROVIDER]: {
    create: createFakeAuthProvider,
    carriesRealCredentials: false,
    defaultScopes: Object.freeze(['ads:read', 'ads:write']),
  },
});

export function registeredAuthProviders(): string[] {
  return Object.keys(AUTH_PROVIDER_REGISTRY);
}

export function isRegisteredAuthProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUTH_PROVIDER_REGISTRY, provider);
}

/**
 * `hasOwnProperty` rather than a truthiness check, so `constructor` and
 * `toString` cannot resolve through the prototype chain into something that is
 * not a provider entry. The same guard `adapterFor` uses, for the same reason.
 */
function entryFor(provider: string): AuthProviderEntry {
  if (!isRegisteredAuthProvider(provider)) {
    throw new Error(
      `Unknown channel auth provider "${provider}". Registered: ${registeredAuthProviders().join(', ')}. ` +
        'Adding one is a reviewed change to packages/marketing/src/auth-registry.ts, not a row.',
    );
  }
  return AUTH_PROVIDER_REGISTRY[provider]!;
}

export function authProviderFor(provider: string): ChannelAuthProvider {
  return entryFor(provider).create();
}

/**
 * Raises on an unknown provider rather than answering `false`.
 *
 * The alternative reading, "a provider we have never heard of certainly does not
 * carry real credentials", is the exact inversion that matters: an unregistered
 * name is one nobody reviewed, and answering `false` would let the writer store
 * its token. Fail closed.
 */
export function carriesRealCredentials(provider: string): boolean {
  return entryFor(provider).carriesRealCredentials;
}

export function defaultScopesFor(provider: string): string[] {
  return [...entryFor(provider).defaultScopes];
}
