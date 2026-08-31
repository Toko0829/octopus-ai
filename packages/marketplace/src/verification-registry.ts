/**
 * Which providers may decide whether a person is who they say they are,
 * declared rather than discovered.
 *
 * `20260831123000:70-73` left `node_verifications.provider` as plain `text` and
 * named this file as the validator: "a provider is a reviewed file, and a check
 * constraint would need a migration per provider." The stance is
 * `adapter-registry.ts`'s, held for a heavier reason. Every entry here is a
 * claim that somebody read what this implementation does with a stranger's
 * passport.
 *
 * **An unknown provider raises**, never falls back to the fake. On the ad
 * publish path a silent fallback would report success while nothing reached a
 * platform. Here it would write `verified` against a node on the strength of a
 * provider name nobody registered, and `verified` is what makes somebody
 * eligible for paid work funded from another person's authorised budget.
 */

import { createFakeVerifier, FAKE_VERIFIER } from './fake-verifier';
import type { IdentityVerifier } from './verification';

/**
 * What using this provider actually means for the data we hold.
 *
 * `carriesRealPii` is the enforced half of an accepted risk, and it is the
 * reason this registry holds records rather than bare factories. It is the
 * `carriesRealCredentials` pattern applied to identity, and the two accepted
 * risks are different: there, a plaintext token in a column; here, a person's
 * documents and biometrics existing at all.
 *
 * `security-compliance.md` accepts today's posture only while the sole provider
 * is the in-repo fake, which checks nothing and holds nothing. A real provider
 * arrives with a DPA, a retention schedule, a lawful basis recorded for the
 * processing, and the deletion path a person can ask us to walk. The writer
 * refuses on this flag, so that arrives as a failing write rather than as a
 * paragraph nobody opened.
 */
export interface VerifierEntry {
  create: () => IdentityVerifier;
  /**
   * True when using this provider means real identity documents or biometrics
   * are collected about a real person, whether or not they land in our database.
   * Set it truthfully. Somebody's passport is on the other side of it.
   */
  carriesRealPii: boolean;
}

export const VERIFIER_REGISTRY: Readonly<Record<string, VerifierEntry>> = Object.freeze({
  [FAKE_VERIFIER]: {
    create: createFakeVerifier,
    carriesRealPii: false,
  },
});

export function registeredVerifiers(): string[] {
  return Object.keys(VERIFIER_REGISTRY);
}

export function isRegisteredVerifier(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERIFIER_REGISTRY, provider);
}

/**
 * `hasOwnProperty` rather than a truthiness check, so `constructor` and
 * `toString` cannot resolve through the prototype chain into something that is
 * not a verifier entry. The same guard `adapterFor` and `authProviderFor` use.
 */
function entryFor(provider: string): VerifierEntry {
  if (!isRegisteredVerifier(provider)) {
    throw new Error(
      `Unknown identity verifier "${provider}". Registered: ${registeredVerifiers().join(', ')}. ` +
        'Adding one is a reviewed change to packages/marketplace/src/verification-registry.ts, not a row.',
    );
  }
  return VERIFIER_REGISTRY[provider]!;
}

export function verifierFor(provider: string): IdentityVerifier {
  return entryFor(provider).create();
}

/**
 * Raises on an unknown provider rather than answering `false`.
 *
 * The tempting reading, "a provider we have never heard of certainly collects no
 * real documents", is the exact inversion that matters: an unregistered name is
 * one nobody reviewed, and answering `false` would let the writer record its
 * verdicts. Fail closed, the way `carriesRealCredentials` does.
 */
export function carriesRealPii(provider: string): boolean {
  return entryFor(provider).carriesRealPii;
}
