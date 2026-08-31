/**
 * Eligibility is one boolean, and the test that earns its place is the
 * exhaustive one: every status and availability pair, so the code copy and the
 * `node_profiles_available_requires_kyc` constraint cannot drift apart quietly.
 */

import { describe, expect, it } from 'vitest';
import { ineligibilityReason, isEligibleForWork, type NodeEligibilityInput } from './eligibility';

const STATUSES: NodeEligibilityInput['kycStatus'][] = [
  'unverified',
  'pending',
  'verified',
  'rejected',
  'suspended',
];
const AVAILABILITIES: NodeEligibilityInput['availability'][] = [
  'available',
  'paused',
  'offboarded',
];

describe('isEligibleForWork', () => {
  it('is true for exactly one of the fifteen pairs', () => {
    const eligible = STATUSES.flatMap((kycStatus) =>
      AVAILABILITIES.map((availability) => ({ kycStatus, availability })),
    ).filter(isEligibleForWork);

    expect(eligible).toEqual([{ kycStatus: 'verified', availability: 'available' }]);
  });

  it('refuses a verified node who paused themselves', () => {
    expect(isEligibleForWork({ kycStatus: 'verified', availability: 'paused' })).toBe(false);
  });

  it('refuses an available node who is not verified', () => {
    // Unrepresentable in the table by constraint. Asserted anyway, because this
    // function will be handed rows from a matcher query rather than from the
    // table, and a join can produce a shape the table cannot hold.
    expect(isEligibleForWork({ kycStatus: 'pending', availability: 'available' })).toBe(false);
  });
});

describe('ineligibilityReason', () => {
  it('is null exactly when the node is eligible', () => {
    for (const kycStatus of STATUSES) {
      for (const availability of AVAILABILITIES) {
        const node = { kycStatus, availability };
        expect(ineligibilityReason(node) === null, `${kycStatus}/${availability}`).toBe(
          isEligibleForWork(node),
        );
      }
    }
  });

  it('tells a pending node that nothing is needed from them', () => {
    expect(ineligibilityReason({ kycStatus: 'pending', availability: 'paused' })).toMatch(
      /nothing is needed from you/i,
    );
  });

  it('tells a rejected node they can try again', () => {
    expect(ineligibilityReason({ kycStatus: 'rejected', availability: 'paused' })).toMatch(
      /submit it again/i,
    );
  });

  it('lets offboarding outrank the KYC status', () => {
    // Somebody who has left should not be told to verify their identity.
    expect(ineligibilityReason({ kycStatus: 'unverified', availability: 'offboarded' })).toMatch(
      /left the marketplace/i,
    );
  });

  it('writes no em dash, per rule 22', () => {
    for (const kycStatus of STATUSES) {
      for (const availability of AVAILABILITIES) {
        expect(ineligibilityReason({ kycStatus, availability }) ?? '').not.toContain('—');
      }
    }
  });
});
