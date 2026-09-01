/**
 * The ledger pairs, and the guard that stops a silent arithmetic failure from
 * reporting a balanced book.
 *
 * The properties asserted here are the ones whose violation is invisible. An
 * unbalanced pair is not a type error and does not raise; it is a ledger that
 * reconciles to a number nobody notices is wrong. A `NaN` amount makes every
 * comparison false, which in a naively written balance check reads as "these
 * differ" for the wrong reason and in a slightly different one reads as
 * "balanced".
 */

import { describe, expect, it } from 'vitest';
import {
  ESCROW,
  NODE_PAYABLE,
  OWNER_FUNDS,
  REF_TYPE_ESCROW_HOLD,
  entriesBalance,
  escrowHoldPair,
  escrowRefundPair,
  escrowReleasePair,
  type LedgerEntry,
} from './ledger';

const hold = { holdId: '11111111-1111-4111-8111-111111111111', amount: 500, currency: 'USD' };

describe('the hold pair', () => {
  it('debits the owner and credits escrow, for the same amount', () => {
    const pair = escrowHoldPair(hold);

    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({ account: OWNER_FUNDS, debit: 500, credit: 0 });
    expect(pair[1]).toMatchObject({ account: ESCROW, debit: 0, credit: 500 });
  });

  it('balances', () => {
    // The property `marketplace_engagements.sql` asserts on the SQL side, after
    // a real accept. Both halves are pinned so the two cannot drift quietly
    // (the ADR-0011 discipline, applied to the pair rather than to the cap).
    expect(entriesBalance(escrowHoldPair(hold))).toBe(true);
  });

  it('carries the hold id on both sides, which is what makes them a pair', () => {
    for (const entry of escrowHoldPair(hold)) {
      expect(entry.refId).toBe(hold.holdId);
      expect(entry.refType).toBe(REF_TYPE_ESCROW_HOLD);
      expect(entry.currency).toBe('USD');
    }
  });
});

describe('the refund pair', () => {
  it('is the exact reverse, sharing the same reference', () => {
    const pair = escrowRefundPair(hold);

    expect(pair[0]).toMatchObject({ account: ESCROW, debit: 500, credit: 0 });
    expect(pair[1]).toMatchObject({ account: OWNER_FUNDS, debit: 0, credit: 500 });
    expect(pair.every((e) => e.refId === hold.holdId)).toBe(true);
  });

  it('balances, and so does a hold and its refund taken together', () => {
    expect(entriesBalance(escrowRefundPair(hold))).toBe(true);
    // The settled-hold property: once refunded, the four entries about this hold
    // sum to zero on every account, which is what makes "this hold is settled" a
    // fact a reader can derive rather than a state column they must trust.
    expect(entriesBalance([...escrowHoldPair(hold), ...escrowRefundPair(hold)])).toBe(true);
  });
});

describe('entriesBalance refuses what it cannot reason about', () => {
  function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
    return {
      account: OWNER_FUNDS,
      debit: 100,
      credit: 0,
      currency: 'USD',
      refType: REF_TYPE_ESCROW_HOLD,
      refId: hold.holdId,
      ...over,
    };
  }

  it('refuses NaN rather than arithmetic-ing it', () => {
    // The `spend.ts` guard, applied to a ledger. NaN in a sum makes the total
    // NaN and every comparison false, so a check written a shade differently
    // would report balanced from a silent arithmetic failure.
    expect(entriesBalance([entry({ debit: Number.NaN }), entry({ debit: 0, credit: 100 })])).toBe(
      false,
    );
  });

  it('refuses Infinity', () => {
    expect(
      entriesBalance([
        entry({ debit: Number.POSITIVE_INFINITY }),
        entry({ debit: 0, credit: 100 }),
      ]),
    ).toBe(false);
  });

  it('refuses a negative amount, which is the other side wearing the wrong sign', () => {
    expect(entriesBalance([entry({ debit: -100 }), entry({ debit: 0, credit: -100 })])).toBe(false);
  });

  it('refuses an entry that is both a debit and a credit', () => {
    // Mirrors `ledger_entries_one_side`. Such a row is not a half-movement, it
    // is a row nobody can read.
    expect(entriesBalance([entry({ debit: 100, credit: 100 })])).toBe(false);
  });

  it('refuses an entry that is neither', () => {
    expect(entriesBalance([entry({ debit: 0, credit: 0 })])).toBe(false);
  });

  it('refuses an empty set rather than calling nothing balanced', () => {
    // Zero equals zero, so a naive implementation returns true here and a caller
    // that built no entries at all is told its ledger is fine.
    expect(entriesBalance([])).toBe(false);
  });

  it('catches a genuinely unbalanced pair', () => {
    expect(entriesBalance([entry({ debit: 100 }), entry({ debit: 0, credit: 99 })])).toBe(false);
  });
});

describe('the release pair', () => {
  it('debits escrow and credits the node, for the same amount', () => {
    const pair = escrowReleasePair(hold);

    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({ account: ESCROW, debit: 500, credit: 0 });
    expect(pair[1]).toMatchObject({ account: NODE_PAYABLE, debit: 0, credit: 500 });
  });

  it('balances', () => {
    expect(entriesBalance(escrowReleasePair(hold))).toBe(true);
  });

  it('carries the hold as its reference, not the payout', () => {
    // The one decision in this function. A payout-referenced pair would leave
    // the hold's entries permanently unbalanced, and "this hold is settled"
    // would stop being derivable from the ledger — which is the whole reason a
    // system that already has `escrow_holds.state` also keeps one.
    for (const entry of escrowReleasePair(hold)) {
      expect(entry.refType).toBe(REF_TYPE_ESCROW_HOLD);
      expect(entry.refId).toBe(hold.holdId);
    }
  });

  it('settles a hold to zero on every account, whichever way it settled', () => {
    // The property `settle_payout` and the reconcile sweep are both written to
    // preserve, asserted here on both endings so that neither can drift alone.
    // Four entries about one hold, netting to nothing.
    const released = [...escrowHoldPair(hold), ...escrowReleasePair(hold)];
    const refunded = [...escrowHoldPair(hold), ...escrowRefundPair(hold)];

    for (const entries of [released, refunded]) {
      expect(entriesBalance(entries)).toBe(true);

      const net = new Map<string, number>();
      for (const e of entries) {
        net.set(e.account, (net.get(e.account) ?? 0) + e.debit - e.credit);
      }
      // `escrow` is the account both endings pass through, so it is the one
      // that must come back to zero; the counterparty account keeps the money.
      expect(net.get(ESCROW)).toBe(0);
    }
  });

  it('sends the money somewhere different from a refund', () => {
    // Release and refund are the same shape with opposite meanings, and the
    // only thing separating them is the account on the credit side. A copy-paste
    // that credited `owner_funds` here would balance, would settle the hold, and
    // would quietly pay the owner for the node's work.
    const release = escrowReleasePair(hold);
    const refund = escrowRefundPair(hold);

    expect(release[1]!.account).toBe(NODE_PAYABLE);
    expect(refund[1]!.account).toBe(OWNER_FUNDS);
  });

  it('refuses an amount nobody can reason about', () => {
    const entries: LedgerEntry[] = escrowReleasePair({ ...hold, amount: Number.NaN });
    expect(entriesBalance(entries)).toBe(false);
  });
});
