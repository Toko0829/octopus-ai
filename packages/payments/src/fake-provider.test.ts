/**
 * The fake provider, and the one property that matters about it.
 *
 * Determinism is not a convenience here. A retried accept recomputes the same
 * idempotency key, asks for the same charge and must be handed back the same
 * reference, because the replayed `accept_offer` returns the engagement it
 * already made and the hold it already stored. A random reference would mean the
 * second call reported a charge that matches nothing on the row.
 */

import { describe, expect, it } from 'vitest';
import { createFakeProvider, fakeChargeId, fakeTransferId } from './fake-provider';
import { escrowKey, payoutKey } from './keys';

describe('createFakeProvider', () => {
  it('derives the reference from the idempotency key', async () => {
    const provider = createFakeProvider();
    const key = escrowKey('e0000000-0000-4000-8000-000000000001');

    const first = await provider.createCharge({
      amount: 500,
      currency: 'USD',
      idempotencyKey: key,
    });
    const second = await provider.createCharge({
      amount: 500,
      currency: 'USD',
      idempotencyKey: key,
    });

    expect(first.chargeId).toBe(second.chargeId);
    expect(first.chargeId).toBe(fakeChargeId(key));
  });

  it('gives different keys different references', async () => {
    const provider = createFakeProvider();

    const a = await provider.createCharge({ amount: 1, currency: 'USD', idempotencyKey: 'a' });
    const b = await provider.createCharge({ amount: 1, currency: 'USD', idempotencyKey: 'b' });

    expect(a.chargeId).not.toBe(b.chargeId);
  });

  it('is visibly fake, in the table where that matters most', async () => {
    // `escrow_holds.charge_id` holds this string on every row this build writes.
    // A reference shaped like a real Stripe id would be a fake in costume, in
    // the one place a reader most needs to know no money was involved.
    const provider = createFakeProvider();
    const result = await provider.createCharge({
      amount: 500,
      currency: 'USD',
      idempotencyKey: escrowKey('x'),
    });

    expect(result.chargeId.startsWith('ch_fake_')).toBe(true);
  });

  it('does not depend on the amount, because nothing is charged', async () => {
    const provider = createFakeProvider();

    const cheap = await provider.createCharge({ amount: 1, currency: 'USD', idempotencyKey: 'k' });
    const dear = await provider.createCharge({
      amount: 9999,
      currency: 'USD',
      idempotencyKey: 'k',
    });

    expect(cheap.chargeId).toBe(dear.chargeId);
  });
});

describe('createFakeProvider.transfer', () => {
  const key = payoutKey('a0000000-0000-4000-8000-00000000000e');

  it('derives the reference from the idempotency key', async () => {
    // Sharper here than for a charge. The payout sweep records `transfer_id`
    // AFTER this returns, so a crash in that window is resumed by calling again
    // with the same key; a random reference would store a second id for a
    // transfer that, at a real idempotent provider, happened once.
    const provider = createFakeProvider();

    const first = await provider.transfer({
      amount: 500,
      currency: 'USD',
      destination: 'node-1',
      idempotencyKey: key,
    });
    const second = await provider.transfer({
      amount: 500,
      currency: 'USD',
      destination: 'node-1',
      idempotencyKey: key,
    });

    expect(first.transferId).toBe(second.transferId);
    expect(first.transferId).toBe(fakeTransferId(key));
  });

  it('is visibly fake, and visibly not a charge', async () => {
    // `payouts.transfer_id` holds this on every row this build writes. The
    // prefix differs from `ch_fake_` so nobody reconciling the two money tables
    // can mistake a charge for a transfer.
    const provider = createFakeProvider();
    const result = await provider.transfer({
      amount: 500,
      currency: 'USD',
      destination: 'node-1',
      idempotencyKey: key,
    });

    expect(result.transferId.startsWith('tr_fake_')).toBe(true);
    expect(result.transferId).not.toBe(fakeChargeId(key));
  });

  it('gives different keys different references', async () => {
    const provider = createFakeProvider();

    const a = await provider.transfer({
      amount: 1,
      currency: 'USD',
      destination: 'n',
      idempotencyKey: 'a',
    });
    const b = await provider.transfer({
      amount: 1,
      currency: 'USD',
      destination: 'n',
      idempotencyKey: 'b',
    });

    expect(a.transferId).not.toBe(b.transferId);
  });

  it('does not depend on the destination, because nobody is paid', async () => {
    const provider = createFakeProvider();

    const one = await provider.transfer({
      amount: 500,
      currency: 'USD',
      destination: 'node-1',
      idempotencyKey: key,
    });
    const other = await provider.transfer({
      amount: 500,
      currency: 'USD',
      destination: 'node-2',
      idempotencyKey: key,
    });

    expect(one.transferId).toBe(other.transferId);
  });
});
