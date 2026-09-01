/**
 * The keys, pinned as literal strings.
 *
 * Asserting the exact output rather than "it contains the id" is the point: the
 * escrow key is built a second time in SQL (`'escrow:' || p_offer_id` inside
 * `public.accept_offer`), so this test and the pgTAP assertion on
 * `escrow_holds.idempotency_key` are what stop the two derivations drifting into
 * a state where a retry writes a second hold instead of colliding.
 */

import { describe, expect, it } from 'vitest';
import { escrowKey, payoutKey, refundKey } from './keys';

const OFFER = 'e0000000-0000-4000-8000-000000000001';
const HOLD = '11111111-1111-4111-8111-111111111111';

describe('escrowKey', () => {
  it('is the literal string accept_offer builds in SQL', () => {
    expect(escrowKey(OFFER)).toBe(`escrow:${OFFER}`);
  });

  it('is derived from the offer, so a later cascade round is a different key', () => {
    // The epoch problem, solved by choosing the right id rather than by counting.
    // A step that came back to the market is offered again as a NEW offer row,
    // so the second acceptance derives a different key and funds its own hold.
    // `publishIdempotencyKey` needed an explicit epoch for exactly this case.
    expect(escrowKey('offer-round-0')).not.toBe(escrowKey('offer-round-1'));
  });

  it('is stable across calls, which is the whole mechanism', () => {
    expect(escrowKey(OFFER)).toBe(escrowKey(OFFER));
  });
});

describe('refundKey', () => {
  it('is prefixed apart from the hold key', () => {
    // `escrow_holds.idempotency_key` and `messages.idempotency_key` are separate
    // namespaces, but a bare uuid in either would let two different acts collide
    // on one string. The prefix is what keeps them distinct.
    expect(refundKey(HOLD)).toBe(`escrow-refund:${HOLD}`);
    expect(refundKey(HOLD)).not.toBe(escrowKey(HOLD));
  });

  it('is derived from the hold, so one hold announces its refund once', () => {
    expect(refundKey(HOLD)).toBe(refundKey(HOLD));
    expect(refundKey('hold-a')).not.toBe(refundKey('hold-b'));
  });
});

describe('payoutKey', () => {
  const ENGAGEMENT = 'a0000000-0000-4000-8000-00000000000e';

  it('is prefixed apart from every other key in the namespace', () => {
    expect(payoutKey(ENGAGEMENT)).toBe(`payout:${ENGAGEMENT}`);
    expect(payoutKey(ENGAGEMENT)).not.toBe(escrowKey(ENGAGEMENT));
    expect(payoutKey(ENGAGEMENT)).not.toBe(refundKey(ENGAGEMENT));
  });

  it('is derived from the engagement, so a reassigned step pays its second node', () => {
    // The case that decides this. A step taken, abandoned past its deadline and
    // reassigned has TWO engagements: different node, possibly different price.
    // A key derived from the task would collide on the second payout, read back
    // a row belonging to somebody else, and report the wrong person paid.
    expect(payoutKey('engagement-first')).not.toBe(payoutKey('engagement-second'));
  });

  it('is stable across calls, which is the whole mechanism', () => {
    expect(payoutKey(ENGAGEMENT)).toBe(payoutKey(ENGAGEMENT));
  });
});
