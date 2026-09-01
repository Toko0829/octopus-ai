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
import { createFakeProvider, fakeChargeId } from './fake-provider';
import { escrowKey } from './keys';

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
