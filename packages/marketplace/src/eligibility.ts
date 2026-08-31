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
 * What an eligible node is owed today, which is the truth rather than a promise.
 *
 * `human-nodes-marketplace.md:64-76` names the dead end this slice must not
 * create: "a person who completes KYC and is never offered anything". Being
 * ops-invited is what makes that a decision rather than an accident, and saying
 * it plainly on the surface is the other half. It stops being true when the
 * matcher lands, and this constant is where that edit happens.
 */
export const NO_WORK_YET =
  'There is no work to offer yet. Octopus cannot match you to a task until the matcher ships, and you were invited knowing that.';
