/**
 * Which skills a plan step needs, derived from the funnel stage it came from.
 *
 * **This file exists because `tasks` carries nothing to match on.** The module
 * doc's matching algorithm opens with "eligible pool = verified skills cover
 * `required_skills`", and `required_skills` appears exactly once in this
 * repository: in that sentence. There is no column, no contract field and no
 * type. What a task actually carries is `title`, `detail`, `stage`,
 * `owner_type`, `risk_tier`, `acceptance_criteria` and `citations`
 * (`20260813120000:114-143`, unchanged since).
 *
 * Three ways to close that gap were available and two were rejected.
 *
 * **Ask the planner for `required_skills`.** It puts a matching decision inside
 * the model, needs a contract change, a column and an eval pass, and hands a
 * model authority over which humans get paid. Rules 7 and 11 point the other
 * way, and this repository has three recorded cases of a model agreeing with a
 * disposition and then ignoring it (decomposition's stage count, the
 * groundedness gate's bias, the risk tier the clamp exists to raise).
 *
 * **Ask the owner at dispatch.** They escalated the step precisely because they
 * did not know how to do it; asking them to name the expertise it needs is
 * asking the question they are stuck on.
 *
 * **A reviewed map, which is what this is.** The planner emits exactly six
 * stages (`services/ai/src/octopus_ai/planner.py:96`, normalised into fixed
 * order by `parse_plan` so a card cannot silently show four), and six is small
 * enough to state completely and read in a diff. It is the third registry in
 * this package for the same reason as the first two: "a file gets reviewed in a
 * diff by a person and a row does not" (`20260831121000:22-27`).
 *
 * **The pool is a union, not an intersection.** A node claiming any mapped tag
 * is eligible. The alternative, requiring every tag, would mean a `content`
 * step needs one person who claims both `copywriting` and `seo`, which narrows
 * a cold-start pool to nobody for no safety reason: these are marketing steps,
 * not regulated acts, and the owner reviews the work either way. Ranking does
 * not depend on which tag matched, because with `trust_score` NULL and
 * `completed_engagements` zero on every row there is nothing yet to weigh a
 * closer match against.
 *
 * **The three jurisdictional skills are unreachable from here, and that is
 * structural.** `notary`, `legal-filing` and `bookkeeping` all require a place
 * (`skill-taxonomy.ts`), and no full-funnel marketing stage can produce work
 * that needs a notary. They become reachable when the business-formation
 * vertical lands, which is Phase 5 and a different planner. Until then the
 * jurisdiction filter in `jurisdiction.ts` is written, tested and never
 * exercised by a real match, which is stated there rather than discovered.
 */

import { isKnownSkill } from './skill-taxonomy';

/**
 * The map. Ordered within each stage from most to least central, which is
 * documentation rather than behaviour: the pool is a union and ranking ignores
 * which tag matched.
 */
const STAGE_SKILLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  strategy: Object.freeze(['copywriting']),
  content: Object.freeze(['copywriting', 'seo']),
  creative: Object.freeze(['creative-video', 'copywriting']),
  channels: Object.freeze(['paid-ads', 'outreach']),
  conversion: Object.freeze(['copywriting', 'email-lifecycle']),
  measurement: Object.freeze(['analytics']),
});

/** The stages this map knows, for tests and for the doc to stay honest against. */
export const MAPPED_STAGES: readonly string[] = Object.freeze(Object.keys(STAGE_SKILLS));

/**
 * The skills a step from this stage needs, or an empty list.
 *
 * **Fails closed**, and the empty list is a real answer rather than a default:
 * `tasks.stage` is nullable free text (`20260813120000:123`), so a hand-written
 * row, an older planner or a future vertical can all put something here that
 * this map has never seen. Returning a guess would offer somebody's step to
 * whoever happened to match; returning nothing lets the caller say plainly that
 * it does not know what kind of expert this needs, which is what
 * `apps/api/src/routes/task-actions.ts` does before the task moves anywhere.
 */
export function skillsForStage(stage: string | null | undefined): readonly string[] {
  if (typeof stage !== 'string') return [];
  return STAGE_SKILLS[stage.trim().toLowerCase()] ?? [];
}

/**
 * Every tag this map can emit, deduplicated.
 *
 * The matcher reads the per-stage list; this exists so a test can assert the
 * whole map against the taxonomy in one pass, and so a reader can see the
 * reachable vocabulary without unioning six lines by eye.
 */
export function mappedSkillTags(): readonly string[] {
  const seen = new Set<string>();
  for (const tags of Object.values(STAGE_SKILLS)) {
    for (const tag of tags) seen.add(tag);
  }
  return Object.freeze([...seen].sort());
}

/**
 * Whether every tag in the map is one the taxonomy actually accepts.
 *
 * Exported rather than left to the test file because the failure it catches is
 * silent: a tag renamed in `skill-taxonomy.ts` and not here would match zero
 * nodes forever, and the symptom would be "the marketplace never finds anyone"
 * rather than an error. The test asserts this is true; keeping the predicate
 * beside the map is what makes the assertion one line rather than a loop that
 * could drift from the map it checks.
 */
export function mapIsWithinTaxonomy(): boolean {
  return mappedSkillTags().every((tag) => isKnownSkill(tag));
}
