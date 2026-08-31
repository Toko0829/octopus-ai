/**
 * Eligibility is one boolean, and the test that earns its place is the
 * exhaustive one: every status and availability pair, so the code copy and the
 * `node_profiles_available_requires_kyc` constraint cannot drift apart quietly.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_OPEN_OFFERS,
  ineligibilityReason,
  isEligibleForWork,
  offerabilityGap,
  type NodeEligibilityInput,
} from './eligibility';

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

describe('offerabilityGap', () => {
  it('names the rate as what is stopping offers, because nothing else will', () => {
    // A verified, available node with no rate passes every check on this page
    // and is still excluded by the matcher's pool query. Without this sentence
    // they wait indefinitely with no surface stating why.
    expect(offerabilityGap({ rate: null })).toMatch(/rate/i);
  });

  it('has nothing to say once a rate is set', () => {
    expect(offerabilityGap({ rate: 120 })).toBeNull();
    expect(offerabilityGap({ rate: 0.5 })).toBeNull();
  });

  it('writes no em dash, per rule 22', () => {
    expect(offerabilityGap({ rate: null }) ?? '').not.toContain('—');
    expect(NO_OPEN_OFFERS).not.toContain('—');
  });

  it('no longer promises that the matcher is unbuilt', () => {
    // NO_WORK_YET said "until the matcher ships". The matcher has shipped, and
    // a sentence that outlives its own condition is the drift this repository
    // treats as a bug.
    expect(NO_OPEN_OFFERS).not.toMatch(/matcher ships|no work to offer yet/i);
    expect(NO_OPEN_OFFERS).toMatch(/offer appears here/i);
  });
});
