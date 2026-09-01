/**
 * Whether a node can be offered work, and what to say when they cannot.
 *
 * The code mirror of `node_profiles_available_requires_kyc`, which
 * `20260831120000:173-178` flagged as "the single most valuable line" in the
 * table: the one eligibility rule with no second layer behind it. This file is
 * not that second layer and must not be mistaken for one. The constraint is
 * what cannot be bypassed; this is what a surface reads so it can explain
 * itself, and what the matcher will read in slice 4 so it does not select rows
 * it would then have to filter.
 *
 * The two copies fail in the same direction, which is the condition under which
 * this repository tolerates a duplicated rule at all: anything this calls
 * eligible that the constraint refuses is a failed write, never a bad row.
 */

/** The fields eligibility actually depends on. Deliberately not the whole row. */
export interface NodeEligibilityInput {
  kycStatus: 'unverified' | 'pending' | 'verified' | 'rejected' | 'suspended';
  availability: 'available' | 'paused' | 'offboarded';
}

export function isEligibleForWork(node: NodeEligibilityInput): boolean {
  return node.kycStatus === 'verified' && node.availability === 'available';
}

/**
 * Why not, in a sentence written for the node rather than about them.
 *
 * Returns null when they are eligible. Separate from the boolean because a guard
 * wants a boolean and a person waiting to be given work is owed a reason: a
 * disabled control with no explanation is the shape that makes somebody think
 * the product is broken.
 */
export function ineligibilityReason(node: NodeEligibilityInput): string | null {
  if (node.availability === 'offboarded') {
    return 'You have left the marketplace, so nothing will be offered to you.';
  }
  switch (node.kycStatus) {
    case 'unverified':
      return 'Verify your identity to start receiving work.';
    case 'pending':
      return 'Your identity check is with the provider. Nothing is needed from you.';
    case 'rejected':
      return 'Your identity check did not pass. You can submit it again.';
    case 'suspended':
      return 'Your account is suspended. Support has the details.';
    case 'verified':
      return node.availability === 'paused'
        ? 'You are paused, so nothing will be offered to you until you turn this back on.'
        : null;
  }
}

/**
 * What an eligible node with nothing in front of them is told.
 *
 * This constant replaces `NO_WORK_YET`, whose own comment named this edit in
 * advance: "It stops being true when the matcher lands, and this constant is
 * where that edit happens." The matcher has landed, so the sentence changes from
 * a standing apology to a description of how work arrives. What has **not**
 * changed is that nodes are still ops-invited: the matcher decides who is
 * offered a step, not who may become a node, and `invite_node` is still granted
 * to `service_role` alone.
 */
export const NO_OPEN_OFFERS =
  'There is no work to offer you right now. When an owner sends a step out for an expert and you match it, the offer appears here.';

/**
 * The gaps a node can close themselves that eligibility does not cover.
 *
 * `node_profiles.rate` is nullable and the matcher's pool query requires it,
 * because a rate is what an offer is measured against and `20260831120000:160-165`
 * sized the column to `projects.budget_ceiling` for exactly that comparison. So
 * a verified, available node with no rate is eligible by every check on this
 * page and will still never be offered anything.
 *
 * That is the dead-end shape this repository keeps recording, in its quietest
 * form: nothing is broken, no control is disabled, and the person waits
 * indefinitely for a reason no surface states. Returns null when there is
 * nothing to say.
 *
 * **The second gap arrived with escrow, and it is quieter still.** Slice 5 funds
 * a step by holding the node's rate as a whole amount against the project's
 * authorised budget, and an hourly rate is a price per hour: there is no hours
 * field anywhere to multiply by, and estimating one at acceptance would be
 * guessing at the number that decides what somebody is paid. So
 * `readEligiblePool` filters `rate_period = 'task'` and `accept_offer` refuses an
 * hourly rate again behind it.
 *
 * A node who set an hourly rate has therefore done everything the page asks and
 * is still invisible to the matcher, which is exactly the situation the no-rate
 * sentence exists for. It is a real product limit rather than a bug, and per-hour
 * work returns when there is a way to agree how many hours.
 */
export function offerabilityGap(node: {
  rate: number | null;
  ratePeriod?: 'hour' | 'task' | null;
}): string | null {
  if (node.rate === null) {
    return 'Set your rate to start receiving offers. Work is matched against it, so a node without one is never offered anything.';
  }
  if (node.ratePeriod === 'hour') {
    return 'Change your rate to a price per step to start receiving offers. Work is funded as one whole amount held in escrow, so a per-hour rate cannot be matched yet.';
  }
  return null;
}
