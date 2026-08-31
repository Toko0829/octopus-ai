/**
 * The matcher's decisions, without the IO that makes them matter.
 *
 * The `@octopus/marketing` split, applied again: ranking a pool, picking the
 * next candidate and deciding whether an offer has settled are all things a
 * reader can check by reading, so they live here with no clock and no client.
 * The sweep in `apps/api/src/lib/match.ts` is the IO half and is deliberately
 * thin.
 *
 * **What this can rank on is much less than the module doc specifies, and the
 * gap is data rather than design.** The doc ranks by "skill/credential fit,
 * jurisdiction exactness, rating + completion-rate, price, responsiveness,
 * current workload". Of those, on every row that exists today: `trust_score` is
 * NULL (its writer is slice 8's ratings), `completed_engagements` is 0 (nothing
 * completes an engagement yet), `node_skills.verified` is false and unsettable,
 * `node_credentials.verified` likewise, and responsiveness has nowhere to be
 * recorded. Jurisdiction is populated but never asked for, because no task
 * carries a location (see `jurisdiction.ts`).
 *
 * That leaves **price**, and this file says so rather than dressing three NULL
 * columns up as a weighted score. A weighted rank over fields that are all
 * constant is a rank by whatever the database returned first, wearing
 * arithmetic. The weights arrive with the data.
 */

import { bestCoveringJurisdiction, jurisdictionExactness } from './jurisdiction';

/**
 * How long an offer stays open.
 *
 * **48 hours, and it is a constant rather than an env var** because nothing
 * about a deployment should change it: there is no reason for staging and
 * production to disagree about how long a person gets to answer.
 *
 * Two facts set the number. A node has no push channel, no email and no SMS,
 * because the notifications module is specified and unbuilt, so an offer is
 * discovered by visiting `/node`; anything shorter than a full day plus a time
 * zone would expire against people who simply had not looked yet. And the work
 * is full-funnel marketing rather than a notarization with a closing date, so
 * two days costs the owner little. It shortens when offers are actually
 * delivered to somebody.
 */
export const OFFER_TTL_MS = 48 * 60 * 60 * 1000;

/** A node the pool query returned, reduced to what ranking reads. */
export interface CandidateNode {
  nodeId: string;
  /** Already parsed. PostgREST returns `numeric` as a string; the sweep parses. */
  rate: number;
  /** `node_profiles.service_jurisdictions`. Empty is normal and not disqualifying. */
  jurisdictions: readonly string[];
}

export interface RankOptions {
  /**
   * Where the work is, when that is known. **It never is in the first
   * vertical**: no task carries a jurisdiction. Present so the ordering ADR-0015
   * specifies exists and is tested rather than being written from scratch under
   * pressure by the first regulated act.
   */
  taskJurisdiction?: string;
}

/**
 * Rank a pool, best first.
 *
 * Three keys, in order:
 *
 * 1. **Jurisdiction exactness, descending**, when the task names a place. A node
 *    serving `US-TX-AUSTIN` outranks one serving `US-TX` for Austin work, which
 *    is the module doc's rule verbatim. Candidates covering the place always
 *    outrank candidates that do not.
 * 2. **Rate, ascending.** The only populated preference signal, and the one that
 *    favours the person whose budget nothing else protects yet: escrow does not
 *    exist, so no cap is being checked anywhere in this slice.
 * 3. **`nodeId`, ascending**, as a stable tiebreak.
 *
 * **The tiebreak is deliberately not random.** Randomness would be defensible as
 * fairness and is wrong here for three reasons: a crashed sweep re-ranking the
 * same pool must reach the same candidate or the replay opens a different
 * offer, a dispute needs the ranking to be reconstructible from the rows, and a
 * node asking "why did they get it" deserves an answer. Sorting on the id is
 * arbitrary and admits it, where a shuffled list pretends to a fairness it is
 * not measuring. Rotating fairly across nodes needs an offer history to rotate
 * against, which is what slice 8 accumulates.
 *
 * Pure: returns a new array and does not touch its input.
 */
export function rankCandidates(
  candidates: readonly CandidateNode[],
  options: RankOptions = {},
): CandidateNode[] {
  const target = options.taskJurisdiction;

  const depthOf = (node: CandidateNode): number => {
    if (!target) return 0;
    const covering = bestCoveringJurisdiction(node.jurisdictions, target);
    return covering ? jurisdictionExactness(covering) : -1;
  };

  return [...candidates].sort((a, b) => {
    const depthDiff = depthOf(b) - depthOf(a);
    if (depthDiff !== 0) return depthDiff;

    if (a.rate !== b.rate) return a.rate - b.rate;

    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

/**
 * The next node to offer to, skipping everyone already offered this task.
 *
 * The skip set is the cascade's memory, and it is read from `offers` rows rather
 * than tracked in the sweep, so it survives a crash and a redeploy. It is also
 * why `offers_task_node_idx` exists: the unique index makes a repeat offer
 * impossible even if this function were wrong.
 */
export function nextCandidate(
  ranked: readonly CandidateNode[],
  alreadyOffered: ReadonlySet<string>,
): CandidateNode | null {
  return ranked.find((node) => !alreadyOffered.has(node.nodeId)) ?? null;
}

/** What the sweep should do about one offer it found. */
export type OfferSettlement = 'expire' | 'cascade' | 'wait';

export interface SettleableOffer {
  status: 'open' | 'declined' | 'expired' | 'withdrawn' | 'accepted';
  expiresAt: Date;
}

/**
 * Whether an open offer has run out, has already settled, or is still live.
 *
 * - `expire` — open and out of time. The sweep settles the row, then cascades on
 *   a later pass. Two steps rather than one so the trail records that it expired
 *   rather than merely that it moved on.
 * - `cascade` — already settled (a node declined, or a previous pass expired or
 *   withdrew it), so the task should go back to `matching` for the next
 *   candidate.
 * - `wait` — open with time left. Nothing to do.
 *
 * **The boundary counts as expired.** `expiresAt === now` is out of time: an
 * offer whose deadline is exactly now has had its full window, and treating the
 * boundary as live would leave a row that no clock tick can ever settle if the
 * comparison lands on it repeatedly.
 */
export function decideOfferSettlement(offer: SettleableOffer, now: Date): OfferSettlement {
  if (offer.status !== 'open') return 'cascade';
  return offer.expiresAt.getTime() <= now.getTime() ? 'expire' : 'wait';
}

/** When an offer created now should run out. */
export function offerExpiresAt(now: Date): Date {
  return new Date(now.getTime() + OFFER_TTL_MS);
}
