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
import { disputeReleaseKey, escrowKey, payoutKey, refundKey } from './keys';

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

describe('disputeReleaseKey', () => {
  const DISPUTE = 'a0000000-0000-4000-8000-00000000000d';

  it('is prefixed apart from every other key in the namespace', () => {
    // `escrow_holds.idempotency_key` is one namespace shared by every writer, so
    // a bare uuid would let two different acts collide on the same string.
    expect(disputeReleaseKey(DISPUTE)).toBe(`dispute-release:${DISPUTE}`);
    expect(disputeReleaseKey(DISPUTE)).not.toBe(escrowKey(DISPUTE));
    expect(disputeReleaseKey(DISPUTE)).not.toBe(refundKey(DISPUTE));
    expect(disputeReleaseKey(DISPUTE)).not.toBe(payoutKey(DISPUTE));
  });

  it('matches the string public.resolve_dispute builds in SQL', () => {
    // The insert has to happen inside the resolution's transaction, so the
    // arithmetic exists in two languages and the two have to agree. The pgTAP
    // half is in `marketplace_disputes.sql`; this is the other half.
    expect(disputeReleaseKey(DISPUTE)).toBe('dispute-release:' + DISPUTE);
  });

  it('is derived from the dispute rather than the task, so a re-dispute cannot replay', () => {
    // The case that decides this, and the reason it is not keyed on the task or
    // the engagement. A step can be disputed, resolved back to `in_progress`
    // through `rejected`, worked again and disputed a SECOND time, all under one
    // engagement. A key derived from either id would collide on that second
    // settlement and read back the first one's hold, paying against money that
    // was already settled. `disputes` has a partial unique index on
    // `(task_id) where resolved_at is null`, so every new grievance is a new row
    // and the epoch is inherited rather than counted.
    expect(disputeReleaseKey('dispute-first')).not.toBe(disputeReleaseKey('dispute-second'));
  });

  it('is stable across calls, which is the whole mechanism', () => {
    expect(disputeReleaseKey(DISPUTE)).toBe(disputeReleaseKey(DISPUTE));
  });
});
