/**
 * The seam every identity check sits behind, written before any real provider.
 *
 * Same discipline as `adapter.ts` and `auth.ts` in `@octopus/marketing`, for the
 * same reason: if this arrived with Persona, Persona's shape would become the
 * interface and Stripe Identity would be the one that has to bend. Neither is
 * wired, because both bill per check and this project has no paid providers in
 * development.
 *
 * **What a verifier knows and what it does not.** A verifier answers "what did
 * the checks say". It does not decide the person's `kyc_status`: that is
 * `decide_node_kyc` in Postgres, because the decision has to be made in the same
 * transaction as the rows it rests on, and because an append-only table means the
 * verdict has to be derived from what is recorded rather than from what was
 * returned. A provider that returned a status would be deciding something it
 * cannot see the history of.
 *
 * **What never crosses this seam.** No document, no image, no date of birth, no
 * number. `node_verifications.detail` holds verdicts, scores and references only
 * (`20260831123000:75-79`), and `security-compliance.md` is explicit that
 * sensitive KYC material stays with the provider. A verifier that wanted to hand
 * us a passport scan would have nowhere to put it, which is the point.
 */

import { z } from 'zod';

/** Mirrors `public.verification_kind`. */
export const VerificationKind = z.enum([
  'document',
  'liveness',
  'face_match',
  'face_search',
  'sanctions_pep',
  'license_check',
]);
export type VerificationKind = z.infer<typeof VerificationKind>;

/**
 * Mirrors `public.verification_result`.
 *
 * There is no `pending`, deliberately, and `20260831123000:41-51` gives the
 * reason: "we asked and are waiting" is a property of the node, not of a check,
 * so it lives in `kyc_status`. A check that has not answered has no row.
 */
export const VerificationResult = z.enum(['passed', 'failed', 'inconclusive', 'error']);
export type VerificationResult = z.infer<typeof VerificationResult>;

/**
 * One check's answer.
 *
 * `detail` is free-form because every provider names its own signals, and
 * constrained by convention rather than by schema for the same reason. What
 * keeps a passport number out of it is the registry entry below, not this type.
 */
export const VerificationCheck = z.object({
  kind: VerificationKind,
  result: VerificationResult,
  /** The provider's own id for this check, so a support conversation can start. */
  providerRef: z.string().min(1).nullable().default(null),
  detail: z.record(z.unknown()).default({}),
});
export type VerificationCheck = z.infer<typeof VerificationCheck>;

/**
 * What a verifier is asked.
 *
 * `sessionRef` is the provider's own reference for the flow the person just
 * completed, the exact counterpart of an OAuth authorization code: minted by
 * whoever hosted the screen, opaque to us, and meaningless to any other
 * provider. A real verifier looks it up over the network. The fake encodes the
 * outcome the person picked, the way `fakeAuthorizationCode` encodes the scopes
 * they ticked.
 *
 * There is no `outcome` field on this type, and that absence is deliberate: a
 * seam carrying a parameter only the fake reads is a seam shaped around the
 * fake.
 */
export const VerifyRequest = z.object({
  nodeId: z.string().uuid(),
  sessionRef: z.string().min(1),
});
export type VerifyRequest = z.infer<typeof VerifyRequest>;

/**
 * A verifier could not answer, as distinct from answering "no".
 *
 * The distinction is the whole reason this class exists. A provider outage that
 * read as a failed check would reject people for our own downtime, and
 * `rejected` is a status a person has to appeal out of. A thrown error becomes
 * an `error` result and returns the node to `unverified`, which costs them a
 * resubmission and accuses them of nothing.
 */
export class VerificationError extends Error {
  constructor(
    message: string,
    /** Whether the same request could succeed later without the person redoing anything. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}

export interface IdentityVerifier {
  readonly name: string;
  /**
   * The checks this provider performed. Never empty: a provider that ran nothing
   * has not verified anybody, and returning `[]` would let the caller derive
   * `verified` from an absence.
   */
  verify(request: VerifyRequest): Promise<VerificationCheck[]>;
}
