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
 * the domain with no second layer behind it, plus the sentences a node is owed
 * when nothing is in front of them and when their own row is what is stopping
 * offers arriving.
 *
 * Slice 4 adds three more, and each closes a gap the schema could not.
 *
 * **The stage-to-skill map** (`stage-skills.ts`), because `tasks` carries no
 * `required_skills` and the two alternatives were a model deciding who gets paid
 * or an owner answering the question they escalated because they could not.
 *
 * **Jurisdiction containment** (`jurisdiction.ts`), the two operations ADR-0015
 * named when it rejected PostGIS, written now and exercised by no real match
 * yet, which that file says out loud.
 *
 * **Matching** (`matching.ts`), the ranking and the offer settlement rule, which
 * rank on price and a stable tiebreak because every other input the module doc
 * specifies is NULL on every row that exists.
 *
 * `@octopus/contracts` is deliberately **not** a dependency, still. The offer
 * shapes that cross the wire are declared there and consumed by `apps/api` and
 * `apps/web`; nothing in this package is on a wire, and an offer never becomes a
 * card payload because it is addressed to one node rather than to a room.
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
  NO_OPEN_OFFERS,
  ineligibilityReason,
  isEligibleForWork,
  offerabilityGap,
  type NodeEligibilityInput,
} from './eligibility';

export {
  MAPPED_STAGES,
  mapIsWithinTaxonomy,
  mappedSkillTags,
  skillsForStage,
} from './stage-skills';

export {
  bestCoveringJurisdiction,
  isJurisdictionCode,
  jurisdictionCovers,
  jurisdictionExactness,
} from './jurisdiction';

export {
  OFFER_TTL_MS,
  decideOfferSettlement,
  nextCandidate,
  offerExpiresAt,
  rankCandidates,
  type CandidateNode,
  type OfferSettlement,
  type RankOptions,
  type SettleableOffer,
} from './matching';
