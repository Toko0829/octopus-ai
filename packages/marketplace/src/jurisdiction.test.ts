import { describe, expect, it } from 'vitest';

import {
  bestCoveringJurisdiction,
  isJurisdictionCode,
  jurisdictionCovers,
  jurisdictionExactness,
} from './jurisdiction';

describe('isJurisdictionCode', () => {
  it('accepts what private.is_jurisdiction_code accepts', () => {
    expect(isJurisdictionCode('US')).toBe(true);
    expect(isJurisdictionCode('US-TX')).toBe(true);
    expect(isJurisdictionCode('US-TX-AUSTIN')).toBe(true);
    expect(isJurisdictionCode('GE-TB')).toBe(true);
  });

  it('refuses what it refuses', () => {
    expect(isJurisdictionCode('us-tx')).toBe(false); // lower case
    expect(isJurisdictionCode('USA')).toBe(false); // three-letter country
    expect(isJurisdictionCode('US-TX-AUSTIN-78701')).toBe(false); // four segments
    expect(isJurisdictionCode('US-')).toBe(false);
    expect(isJurisdictionCode('')).toBe(false);
    expect(isJurisdictionCode('US-TOOLONGSEGMENT')).toBe(false); // over ten chars
  });
});

describe('jurisdictionCovers', () => {
  it('is reflexive', () => {
    expect(jurisdictionCovers('US-TX', 'US-TX')).toBe(true);
  });

  it('covers downward, never upward', () => {
    expect(jurisdictionCovers('US', 'US-TX-AUSTIN')).toBe(true);
    expect(jurisdictionCovers('US-TX', 'US-TX-AUSTIN')).toBe(true);
    expect(jurisdictionCovers('US-TX-AUSTIN', 'US-TX')).toBe(false);
    expect(jurisdictionCovers('US-TX-AUSTIN', 'US')).toBe(false);
  });

  it('does not treat a shared character prefix as containment', () => {
    // The whole reason this is segment-wise. 'US-TX'.startsWith('US-T') is true
    // and the containment is false; a raw prefix test would offer Texas work to
    // somebody who serves nowhere at all.
    expect(jurisdictionCovers('US-T', 'US-TX')).toBe(false);
    expect(jurisdictionCovers('US-TX', 'US-TXA')).toBe(false);
    expect(jurisdictionCovers('U', 'US')).toBe(false);
  });

  it('does not cross siblings', () => {
    expect(jurisdictionCovers('US-TX', 'US-CA')).toBe(false);
    expect(jurisdictionCovers('US-TX-AUSTIN', 'US-TX-DALLAS')).toBe(false);
    expect(jurisdictionCovers('US', 'GE-TB')).toBe(false);
  });

  it('fails closed on a malformed code at either end', () => {
    expect(jurisdictionCovers('us-tx', 'US-TX')).toBe(false);
    expect(jurisdictionCovers('US-TX', 'us-tx')).toBe(false);
    expect(jurisdictionCovers('', 'US')).toBe(false);
  });
});

describe('jurisdictionExactness', () => {
  it('counts segments', () => {
    expect(jurisdictionExactness('US')).toBe(1);
    expect(jurisdictionExactness('US-TX')).toBe(2);
    expect(jurisdictionExactness('US-TX-AUSTIN')).toBe(3);
  });

  it('scores a malformed code below every valid one', () => {
    expect(jurisdictionExactness('nonsense')).toBe(0);
    expect(jurisdictionExactness('')).toBe(0);
  });
});

describe('bestCoveringJurisdiction', () => {
  it('prefers the most specific covering claim', () => {
    // The module doc's rule: Austin-local outranks Texas-state for Austin work.
    expect(bestCoveringJurisdiction(['US', 'US-TX', 'US-TX-AUSTIN'], 'US-TX-AUSTIN')).toBe(
      'US-TX-AUSTIN',
    );
    expect(bestCoveringJurisdiction(['US', 'US-TX'], 'US-TX-AUSTIN')).toBe('US-TX');
  });

  it('ignores claims that do not cover the target', () => {
    expect(bestCoveringJurisdiction(['US-CA', 'US-TX-DALLAS'], 'US-TX-AUSTIN')).toBeNull();
    expect(bestCoveringJurisdiction([], 'US-TX')).toBeNull();
  });

  it('is unaffected by the order the claims arrive in', () => {
    const claims = ['US-TX-AUSTIN', 'US', 'US-TX'];
    expect(bestCoveringJurisdiction(claims, 'US-TX-AUSTIN')).toBe('US-TX-AUSTIN');
    expect(bestCoveringJurisdiction([...claims].reverse(), 'US-TX-AUSTIN')).toBe('US-TX-AUSTIN');
  });
});
