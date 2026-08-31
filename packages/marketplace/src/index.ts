/**
 * `@octopus/marketplace` — the expert-marketer side's domain logic, and nothing
 * else.
 *
 * The `@octopus/marketing` split applied to the marketplace: what belongs here
 * is the reasoning a reader can check without running anything, and what does
 * not belong here is IO. **No Supabase client, no `fetch`, no filesystem access
 * and no clock anywhere in this package.** The node's rows are written by
 * `apps/api` through two Postgres functions; the network a real identity
 * provider would touch is that provider's problem, and the only implementation
 * today touches none.
 *
 * Three things live here, and each was named in advance by the migration that
 * deferred it.
 *
 * **The skill taxonomy** (`skill-taxonomy.ts`), because `20260831121000:22-27`
 * put the shape in the column and the vocabulary in a reviewed file: "a file
 * gets reviewed in a diff by a person and a row does not."
 *
 * **The verification seam and its registry** (`verification.ts`,
 * `verification-registry.ts`, `fake-verifier.ts`), because
 * `20260831123000:70-73` left `provider` as unconstrained text and named this
 * registry as its validator. The registry carries `carriesRealPii`, the enforced
 * half of an accepted risk, the way its marketing sibling carries
 * `carriesRealCredentials`.
 *
 * **Eligibility** (`eligibility.ts`), the code mirror of the one constraint in
 * the domain with no second layer behind it, plus the sentence a verified node
 * is owed while the matcher does not exist.
 *
 * `@octopus/contracts` is deliberately **not** a dependency yet. Nothing here is
 * on a wire: the node's surface talks to `apps/api`, which owns the wire types.
 * That changes the first time a marketplace shape appears on a card payload,
 * which is the matcher's offer in slice 4.
 *
 * See docs/30-modules/human-nodes-marketplace.md.
 */

export {
  SKILL_TAXONOMY,
  isKnownSkill,
  parseSkillTag,
  skillEntry,
  skillRejectionReason,
  type ParsedSkillTag,
  type SkillEntry,
} from './skill-taxonomy';

export {
  VerificationCheck,
  VerificationError,
  VerificationKind,
  VerificationResult,
  VerifyRequest,
  type IdentityVerifier,
} from './verification';

export {
  FAKE_OUTCOMES,
  FAKE_VERIFY_PREFIX,
  fakeVerificationRef,
  outcomeFromFakeRef,
  type FakeOutcome,
} from './fake-verification-ref';

export { createFakeVerifier, FAKE_VERIFIER } from './fake-verifier';

export {
  VERIFIER_REGISTRY,
  carriesRealPii,
  isRegisteredVerifier,
  registeredVerifiers,
  verifierFor,
  type VerifierEntry,
} from './verification-registry';

export {
  NO_WORK_YET,
  ineligibilityReason,
  isEligibleForWork,
  type NodeEligibilityInput,
} from './eligibility';
