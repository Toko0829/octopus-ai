/**
 * A verifier that checks nothing and says so.
 *
 * The counterpart of `fake-adapter.ts` and `fake-auth-provider.ts`: the only
 * registered implementation, in-repo, deterministic, reaching no network and
 * costing nothing. Persona and Stripe Identity both bill per check, and this
 * project runs on no paid providers in development.
 *
 * **The outcome is chosen by a person on a screen in our own app.** That is the
 * `/connections/fake-consent` precedent, where the fake's consent page has a
 * working Cancel button so the refusal arm can be exercised by clicking rather
 * than by mocking. Here it means every arc of the KYC map has a writer: `pass`
 * reaches `verified`, `fail` reaches `rejected`, and `inconclusive` and `error`
 * both return the node to `unverified` with a resubmission available.
 *
 * **What it deliberately does not do.** It runs no `face_search`, so it never
 * writes a `matched_node_id`. A duplicate-identity finding names a third party
 * and is the reason `node_verifications` has no policy at all
 * (`20260831123000:104-119`); inventing one from a fake would put a real
 * accusation in an append-only table on the strength of nothing.
 */

import { outcomeFromFakeRef, type FakeOutcome } from './fake-verification-ref';
import { VerificationError, type IdentityVerifier, type VerificationCheck } from './verification';

export const FAKE_VERIFIER = 'fake';

/**
 * The three checks a document-and-selfie flow performs, which is the shape a
 * real provider's basic tier answers in. `sanctions_pep` is included because it
 * is the one a marketplace paying people out cannot skip, and because omitting
 * it here would make the first real integration look like an added requirement
 * rather than a wired-up one.
 */
const CHECKS = ['document', 'liveness', 'sanctions_pep'] as const;

function resultFor(outcome: FakeOutcome, kind: (typeof CHECKS)[number]): VerificationCheck {
  const result =
    outcome === 'pass'
      ? 'passed'
      : outcome === 'fail'
        ? // Only the document check fails, so the recorded reason is specific.
          // A blanket failure across three unrelated checks is not a shape any
          // real provider produces, and a fake that produced it would let code
          // downstream assume failures arrive in bulk.
          kind === 'document'
          ? 'failed'
          : 'passed'
        : outcome === 'inconclusive'
          ? 'inconclusive'
          : 'error';

  return {
    kind,
    result,
    providerRef: null,
    detail: {
      note: 'Built-in test verifier. No identity was checked and nothing was submitted to any provider.',
    },
  };
}

export function createFakeVerifier(): IdentityVerifier {
  return {
    name: FAKE_VERIFIER,
    async verify(request) {
      // Matches the fake auth provider's refusal arm: a reference this provider
      // did not issue is a transport-level problem rather than a verdict about
      // the person, so it throws instead of returning `failed`.
      if (!request.sessionRef.startsWith('fake-verify.')) {
        throw new VerificationError(
          `The built-in verifier did not issue session reference "${request.sessionRef}".`,
          false,
        );
      }

      const outcome = outcomeFromFakeRef(request.sessionRef);
      return CHECKS.map((kind) => resultFor(outcome, kind));
    },
  };
}
