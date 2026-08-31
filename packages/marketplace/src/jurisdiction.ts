/**
 * Containment and specificity over hierarchical jurisdiction codes.
 *
 * [ADR-0015](docs/40-adr/0015-service-geo-is-a-jurisdiction-code.md) rejected
 * PostGIS and said why: the matching rule the module doc specifies is "service
 * geo/jurisdiction **includes** the task location", ranked by "jurisdiction
 * **exactness** (Austin-local > Texas-state)". That is a containment test over a
 * hierarchy plus an ordering on depth, not a geometry query. The ADR named these
 * two operations and left them to be written by the slice that first needs them.
 * This is that file.
 *
 * **Nothing exercises it against a real task yet, and saying so is the point.**
 * A jurisdiction filter needs a jurisdiction on both sides. Nodes have one
 * (`node_profiles.service_jurisdictions`); tasks do not, and neither does
 * anything reachable from one: `projects.market` is free text
 * (`20260813120000:97`), which is the very fact ADR-0015 cites. The matcher
 * therefore calls `rankCandidates` with no task jurisdiction in the first
 * vertical, and these functions rank nothing. They are written now because the
 * ADR specifies them, because slice 5's engagement work needs them the moment a
 * regulated act appears, and because writing them beside the marketplace's other
 * pure logic is cheaper than writing them under pressure later. The limit ADR
 * -0015 states out loud is repeated here: **we cannot answer "within 25 km" and
 * are not pretending to.**
 *
 * **The shape is stricter than the skill taxonomy's, and the two disagree.**
 * `private.is_jurisdiction_code` (`20260831120000:107-114`) accepts
 * `^[A-Z]{2}(-[A-Z0-9]{1,10}){0,2}$`: upper case, at most three segments, each
 * subdivision at most ten characters. The skill-tag regex
 * (`20260831121000:31-33`) accepts a `:`-suffix of `[A-Z]{2}(-[A-Za-z0-9]+){0,2}`,
 * which is mixed case and unbounded in length. So `notary:US-tx` is a legal
 * skill tag whose suffix is **not** a legal jurisdiction code. Nothing joins
 * those two columns today; the day something does, it must normalise through
 * `isJurisdictionCode` first rather than assume the strings are comparable. That
 * asymmetry is recorded here because it is invisible at both ends.
 */

/** Mirrors `private.is_jurisdiction_code` (`20260831120000:107-114`) exactly. */
const JURISDICTION_SHAPE = /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,2}$/;

/** Whether a string is a well-formed jurisdiction code. */
export function isJurisdictionCode(code: string): boolean {
  return JURISDICTION_SHAPE.test(code);
}

/**
 * How specific a code is: 1 for a country, 2 for a subdivision, 3 for a locality.
 *
 * The ranking input ADR-0015 calls "exactness". Returns 0 for anything
 * malformed, so a bad code sorts below every good one rather than throwing
 * inside a comparator.
 */
export function jurisdictionExactness(code: string): number {
  if (!isJurisdictionCode(code)) return 0;
  return code.split('-').length;
}

/**
 * Whether `claim` contains `target`: does a node serving `claim` cover work in
 * `target`?
 *
 * **Segment-wise, never `startsWith`.** `'US-TX'.startsWith('US-T')` is true and
 * the containment is false: `US-T` is not an ancestor of `US-TX`, it is a
 * different (and malformed) code that happens to share a prefix of characters.
 * A raw prefix test would silently offer Texas work to somebody who serves
 * nowhere, and it would fail in the direction that costs somebody a job rather
 * than in the direction that raises an error. Comparing whole segments is the
 * only correct reading of a hierarchy whose separator is meaningful.
 *
 * Containment is reflexive (`US-TX` covers `US-TX`) and runs one way only: a
 * node serving `US-TX` covers `US-TX-AUSTIN`, and a node serving
 * `US-TX-AUSTIN` does **not** cover all of `US-TX`. Both codes must be
 * well-formed; a malformed one covers nothing, which fails closed.
 */
export function jurisdictionCovers(claim: string, target: string): boolean {
  if (!isJurisdictionCode(claim) || !isJurisdictionCode(target)) return false;

  const claimParts = claim.split('-');
  const targetParts = target.split('-');
  if (claimParts.length > targetParts.length) return false;

  return claimParts.every((part, i) => part === targetParts[i]);
}

/**
 * The most specific claim that covers `target`, or null if none does.
 *
 * This is what a ranker wants: not "does anything match" but "how close was the
 * closest match", so that Austin-local outranks Texas-state for Austin work
 * exactly as the module doc specifies. Returning the code rather than its depth
 * keeps the caller able to explain a ranking decision in a sentence.
 */
export function bestCoveringJurisdiction(claims: readonly string[], target: string): string | null {
  let best: string | null = null;
  let bestDepth = 0;

  for (const claim of claims) {
    if (!jurisdictionCovers(claim, target)) continue;
    const depth = jurisdictionExactness(claim);
    if (depth > bestDepth) {
      best = claim;
      bestDepth = depth;
    }
  }

  return best;
}
