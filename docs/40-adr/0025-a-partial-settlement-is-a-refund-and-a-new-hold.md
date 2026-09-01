# ADR-0025 — A partial settlement is a refund and a new hold

**Status:** Accepted · **Date:** 2026-09-08 · **Slice:** marketplace 8 (disputes + ratings)

## Context

`admin-ops.md:15` has specified four dispute outcomes since Phase 0: **release / partial / refund / reassign**. Three of them map onto arcs that already exist. The fourth does not, and never could have.

`escrow_holds` has exactly two settlements and they are both terminal:

```
held -> released     the node earned it
held -> refunded     the owner gets it back
```

There is no arc between them, and `20260907120000` refused to add one in the migration that created the first half:

> Taking back money somebody earned, or paying twice for work that was cancelled, would each require a **new** hold with its own key and its own reason, **and that is what a dispute is (slice 8)**.

That sentence was written before there was anything to decide, and it is now the thing being decided. A partial settlement has to split one hold two ways. The hold cannot be edited into that shape: `held -> released` is one row-state, `held -> refunded` is the other, and "half of each" is not a state the machine has or should acquire.

Three options were live.

## Decision

**A partial settlement refunds the original hold in full and mints a new hold for the node's share, released inside the same transaction.**

`public.resolve_dispute`, on `p_resolution = 'partial'`:

1. `held -> refunded` on the original hold, with the full reversing pair;
2. `insert` a new hold for the release amount, keyed `dispute-release:<dispute_id>`, with its own hold pair;
3. `held -> released` on that new hold, with its own release pair.

Eight ledger entries across two `ref_id`s, four per hold, each hold summing to zero. The net across both is exactly `owner_funds` out by the released share and `node_payable` in by the same.

## Why not the alternatives

**Add a `partially_released` state, or amount columns to `escrow_holds`.** This is the option that looks cheapest and is the most expensive. It makes every existing reader of `escrow_holds` wrong: four separate computations sum holds at `state = 'held'` to decide what a project has committed (ADR-0020), and a third settled-but-not-really state would have to be taught to all four, in two languages, correctly, forever. It also breaks the property that makes this ledger auditable — that a hold's entries sum to zero once it is settled — by introducing a hold that is settled twice for different amounts.

**Write the split as a pair of ledger entries with no hold behind them.** Tempting, because the ledger is where the arithmetic lives. Refused because `ledger_entries` is deliberately not the source of truth for obligations: it is append-only, has no lifecycle, and every entry in it is _about_ a `ref_id` that does have one. Entries with no hold behind them would be the first money in this system that no state machine governs, and reconciliation would have nothing to reconcile against.

**A partial settlement is a composition of settlements this system already knows how to make.** That is the whole argument for the chosen shape. No new state, no new arc, no new ledger pair function — `packages/payments/src/ledger.ts` is untouched, and the three pairs it already exports (`escrowHoldPair`, `escrowRefundPair`, `escrowReleasePair`) are exactly the three the SQL mirrors.

## Consequences

**ADR-0020's four committed-budget computations need no change at all**, and this is the property that made the decision safe rather than merely tidy. All four count `escrow_holds` at `state = 'held'`. The new hold is inserted and released inside one transaction, so **nothing outside that transaction ever observes a second `held` row**: the committed sum is correct before, correct after, and never wrong in between. Verified against `checkSpendCap` (`packages/marketing/src/spend.ts`), `readSpendInputs` (`apps/api/src/lib/spend-reads.ts`), and the SQL sums inside `accept_offer` and `materialise_campaign`.

**The key is derived from the dispute row, not the task or the engagement.** `disputeReleaseKey(disputeId)` in `packages/payments/src/keys.ts`, mirrored in SQL as `'dispute-release:' || v_dispute.id`. A step can be disputed, resolved back to `in_progress` through `rejected`, worked again and disputed a **second** time, all under one engagement — so a key derived from either id would collide on the second settlement and read back the first one's hold. `disputes` carries a partial unique index on `(task_id) where resolved_at is null`, so every new grievance is a new row and the epoch is **inherited from the row** rather than counted from `events` the way `pauseIdempotencyKey` has to (ADR-0014). This is `escrowKey`'s trick, where a re-offered step mints a new `offers` row.

**The new hold carries the original's `charge_id`.** It is the same money from the same nominal charge, and minting a second charge reference would claim a second charge happened. Nothing was charged at all: `carriesRealMoney` still refuses every provider but the in-repo fake, checked in the ops route before the RPC.

**The arithmetic reads the hold, never `agreed_price`** (ADR-0024). They are equal in this build because `platform_fee` is a constant zero; reading the hold is what keeps that an equality rather than an assumption.

**Both bounds on the split are strict.** `0 < release < hold.amount`. A partial of the whole amount is `released` and a partial of nothing is `refunded`; letting either be spelled as a partial would put two names on one outcome and make the `disputes.resolution` column ambiguous about what happened.

**The cost, stated:** a task that has been through a partial settlement has two `escrow_holds` rows, and any future reader that assumes one hold per task is wrong. `apps/api/src/routes/ops.ts` reads them as a list for this reason, and the console shows every hold with its state rather than "the" hold.

## Falsifier

If a real payment provider is ever wired and its refund API cannot reverse a charge partially without a corresponding partial capture, this shape may need a provider-side counterpart rather than a purely internal one. Nothing here is refunded at a provider today — `20260906124000` established that "nothing is refunded at a provider, because nothing was ever charged" — so the question is deferred with the counsel gate in `payments-billing.md`, not answered.

## Links

- [payments-billing.md](../30-modules/payments-billing.md) · [admin-ops.md](../30-modules/admin-ops.md) · [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md)
- [ADR-0020](0020-the-ceiling-has-two-committer-classes.md) — the four committed-budget computations this decision had to leave alone
- [ADR-0024](0024-the-take-rate-is-not-deducted-from-an-agreed-price.md) — why the arithmetic reads the hold
- [ADR-0014](0014-cpa-ceiling-authorises-auto-pause.md) — the epoch argument this inherits structurally rather than by counting
- `20260907120000_escrow_release_arc.sql` — where the refusal that forced this was written
- `20260908125000_resolve_dispute.sql` — the implementation
- `supabase/tests/marketplace_disputes.sql` — the eight entries and the two nets, pinned
