import { describe, expect, it } from 'vitest';

import {
  OFFER_TTL_MS,
  decideOfferSettlement,
  nextCandidate,
  offerExpiresAt,
  rankCandidates,
  type CandidateNode,
} from './matching';

const node = (nodeId: string, rate: number, jurisdictions: string[] = []): CandidateNode => ({
  nodeId,
  rate,
  jurisdictions,
});

describe('rankCandidates', () => {
  it('puts the cheapest first', () => {
    const ranked = rankCandidates([node('c', 90), node('a', 150), node('b', 40)]);
    expect(ranked.map((n) => n.nodeId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties on node id, not on input order', () => {
    // The replay property: a crashed sweep re-ranking the same pool must reach
    // the same candidate, or the retry offers a different person for the round
    // it already inserted.
    const pool = [node('zeta', 100), node('alpha', 100), node('mid', 100)];
    const forwards = rankCandidates(pool).map((n) => n.nodeId);
    const backwards = rankCandidates([...pool].reverse()).map((n) => n.nodeId);
    expect(forwards).toEqual(['alpha', 'mid', 'zeta']);
    expect(backwards).toEqual(forwards);
  });

  it('does not mutate its input', () => {
    const pool = [node('b', 20), node('a', 10)];
    rankCandidates(pool);
    expect(pool.map((n) => n.nodeId)).toEqual(['b', 'a']);
  });

  it('ignores jurisdictions when the task does not name one', () => {
    // The first vertical: no task carries a location, so this is the live path.
    const ranked = rankCandidates([node('local', 200, ['US-TX-AUSTIN']), node('cheap', 50, [])]);
    expect(ranked[0]!.nodeId).toBe('cheap');
  });

  it('ranks jurisdiction exactness above price when the task names a place', () => {
    const ranked = rankCandidates(
      [node('cheap-national', 50, ['US']), node('pricey-local', 500, ['US-TX-AUSTIN'])],
      { taskJurisdiction: 'US-TX-AUSTIN' },
    );
    expect(ranked.map((n) => n.nodeId)).toEqual(['pricey-local', 'cheap-national']);
  });

  it('sorts anyone who does not cover the place below everyone who does', () => {
    const ranked = rankCandidates([node('elsewhere', 10, ['US-CA']), node('covers', 900, ['US'])], {
      taskJurisdiction: 'US-TX',
    });
    expect(ranked.map((n) => n.nodeId)).toEqual(['covers', 'elsewhere']);
  });
});

describe('nextCandidate', () => {
  it('takes the best node nobody has offered this task to', () => {
    const ranked = rankCandidates([node('a', 10), node('b', 20), node('c', 30)]);
    expect(nextCandidate(ranked, new Set())?.nodeId).toBe('a');
    expect(nextCandidate(ranked, new Set(['a']))?.nodeId).toBe('b');
    expect(nextCandidate(ranked, new Set(['a', 'b']))?.nodeId).toBe('c');
  });

  it('returns null once the pool is exhausted', () => {
    const ranked = rankCandidates([node('a', 10)]);
    expect(nextCandidate(ranked, new Set(['a']))).toBeNull();
    expect(nextCandidate([], new Set())).toBeNull();
  });
});

describe('decideOfferSettlement', () => {
  const now = new Date('2026-09-03T12:00:00Z');

  it('waits while an open offer still has time', () => {
    expect(
      decideOfferSettlement({ status: 'open', expiresAt: new Date('2026-09-03T12:00:01Z') }, now),
    ).toBe('wait');
  });

  it('expires an open offer that has run out', () => {
    expect(
      decideOfferSettlement({ status: 'open', expiresAt: new Date('2026-09-03T11:59:59Z') }, now),
    ).toBe('expire');
  });

  it('treats the exact boundary as expired', () => {
    // Not a live offer with zero seconds left. Reading the boundary as live
    // leaves a row that repeated ticks landing on the same instant never settle.
    expect(decideOfferSettlement({ status: 'open', expiresAt: new Date(now) }, now)).toBe('expire');
  });

  it('cascades on every settled status, whatever the clock says', () => {
    const future = new Date('2027-01-01T00:00:00Z');
    for (const status of ['declined', 'expired', 'withdrawn', 'accepted'] as const) {
      expect(decideOfferSettlement({ status, expiresAt: future }, now), status).toBe('cascade');
    }
  });
});

describe('offerExpiresAt', () => {
  it('is 48 hours out', () => {
    expect(OFFER_TTL_MS).toBe(48 * 60 * 60 * 1000);
    expect(offerExpiresAt(new Date('2026-09-03T12:00:00Z')).toISOString()).toBe(
      '2026-09-05T12:00:00.000Z',
    );
  });
});
