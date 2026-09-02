# ADR-0026 — The dispute exit map

**Status:** Accepted · **Date:** 2026-09-08 · **Slice:** marketplace 8 (disputes + ratings)

## Context

`20260815220000` rewrote `private.task_transition_allowed` for an unrelated reason and silently dropped eight arcs. Five of them concerned `disputed`. Every slice since has restored arcs only where a producer landed in the same push, and every slice since slice 4 has restated the same refusal about this one:

> No `-> disputed` arc is restored. Slice 8, with the ops console. A `disputed` task nobody can move is the `escalated` defect on purpose. — `20260906123000:53-54`

That defect is a measured one rather than a principle: `escalated` had no exit but the owner giving up, and **twelve tasks sat in it on the live database** when slice 4 was written. Restoring the inbound arcs without a console would have manufactured the same dead end deliberately, with money frozen inside it.

Slice 8 builds the console, so the arcs come back. What they come back to is this ADR.

## Decision

### The four inbound arcs are restored together

```
escrow_funded  -> disputed     the owner paid, the node never started
in_progress    -> disputed     the work is happening and the owner objects
rejected       -> disputed     the NODE objects: the owner sent back work they did
payout_pending -> disputed     the owner objects after approving, before the sweep pays
```

Together, because they are one product fact observed from four points, and shipping a subset would mean choosing which grievances are expressible by which party. `in_review -> disputed` was never dropped and is unchanged.

**`rejected` is the load-bearing one.** It is the only arc in this system a node walks against the owner. Without it a node whose work was wrongly sent back has two options: redo work they believe was fine, or stop answering — and stopping is read by the no-show sweep as _their_ failure, which reassigns the step away from them and loses them both the work and the fee for a decision they could not contest. A market where only the buyer can escalate is one where the seller's only argument is to walk away.

**`payout_pending` is the freeze.** `PAYABLE_TASK_STATES` in `apps/api/src/lib/payout.ts` is `('approved', 'payout_pending')`, so moving the task to `disputed` is what stops the money. There is no freeze flag and there must not be one: a flag the sweep might not read is a freeze that might not hold.

### `disputed -> matching` is added; it is the only new edge

The other four restore arcs that were declared in `20260813120000`. This one has never existed. `admin-ops.md:15` specifies **reassign** as a dispute outcome, and `matching` is where a step goes to find a different person — `20260906123000` established exactly that for the no-show sweep, with the reasons it gave then: not `failed`, which is terminal and blocks dependents; not `escalated`, which would make `engagements.outcome = 'reassigned'` a word the schema uses and the product never means.

`cascadeRound` in `apps/api/src/lib/match.ts` counts returns from dispatch as `to = 'matching' and from <> 'escalated'`, written against the shape of the arrival rather than a list of origins, so an arrival from `disputed` is absorbed without enumeration.

### `disputed -> in_progress` is dropped permanently

Declared by `20260813120000:324`, dropped by `20260815220000`, and **not restored**. It reads as "give the step back to the same node", which is a real outcome that already has a path: ops upholds the owner's rejection, the task returns to `rejected`, and the node redoes the work through `rejected -> in_progress`, an arc that has existed since the map was written.

A second edge to the same destination would let a resolution skip the state that records what was decided. `rejected` is not a detour on that route; it is the record.

### The five resolutions, and what each moves

| resolution         | task arc                | engagement               | escrow                                                                                             |
| ------------------ | ----------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| `released`         | `disputed -> approved`  | **stays live**           | untouched; the payout sweep releases it                                                            |
| `refunded`         | `disputed -> cancelled` | ends `disputed_resolved` | `held -> refunded`, full                                                                           |
| `partial`          | `disputed -> cancelled` | ends `disputed_resolved` | refund + a new hold released ([ADR-0025](0025-a-partial-settlement-is-a-refund-and-a-new-hold.md)) |
| `reassigned`       | `disputed -> matching`  | ends `disputed_resolved` | `held -> refunded`, full                                                                           |
| `rejection_upheld` | `disputed -> rejected`  | **stays live**           | nothing moves                                                                                      |

**`released` moves no money in the resolution, and that is the elegant half.** The freeze was the task leaving `PAYABLE_TASK_STATES`; un-freezing is putting it back. The engagement stays live, the hold stays `held`, and the next payout sweep picks the step up exactly as it would have. If a `payouts` row already exists from the pass the dispute interrupted, `payoutKey(engagement_id)` collides, the sweep reads its own row back and settles it — the recovery path built for a crash, reused for a freeze. A second money path here would be a second way to pay somebody.

**`refunded` and `partial` land at `cancelled`**, terminal and an existing arc. An owner who got their money back and still wants the work has `reassigned`, which is the resolution built for exactly that. Making `refunded` also mean "and try again" would collapse two decisions an operator has to be able to make separately.

**`rejection_upheld` is refused unless `from_state = 'rejected'`.** "The owner's rejection stands" is meaningless about a dispute raised mid-work, which is why `disputes.from_state` is load-bearing rather than historical.

### No arc from `approved`, `paid` or `done`

A dispute after the transfer has an unresolvable half: `payouts.transfer_id` is write-once and the money has left. `approved` is excluded for a nearer reason — it is the state the sweep picks up first, and an owner who changes their mind has `payout_pending` one tick later, or the `in_review` arc one tick earlier. The window is narrow on purpose: approving **is** the payout authorisation (ADR-0013), and a long undo on an authorisation weakens what the authorisation means.

`proof_submitted` is also absent from what the owner can dispute, though the arc is legal from `in_review`. Work handed over and not yet judged is a review, not a dispute, and `reject_work` with a required note is the cheaper and more informative act. If that rejection is then contested, `rejected -> disputed` is the node's arc.

### `payouts pending -> failed` gets its producer

`20260907121000` declared `failed` in the check constraint, left it out of the map, and named the condition for its return: "Its producer is that console, with a person behind it." This is it — and it is narrower than it sounds. **It is not a failed transfer**: a provider error still retries at tick cadence, because nothing here decides that approved work will never be paid. It is a payout **overtaken by a dispute**, whose hold was refunded underneath it, which would otherwise sit at `pending` forever claiming money is owed that nothing will ever send. There is no `failed -> pending`, because the money went back.

### `disputed_resolved` is admitted to the counterparty projection

`20260907123000` widened `private.engaged_counterparty` to admit `outcome = 'completed'` and explicitly deferred this one:

> the third because **slice 8 has not decided what a resolved dispute leaves the two parties entitled to see**, and guessing on its behalf is how a disclosure decision gets made by whoever wrote the migration first.

It is admitted. Three reasons, in the order they weigh:

1. **Closing it would erase a name at the moment it matters most.** A dispute is a decision made about somebody's money, by an operator, against a named person. `20260907123000` refused this shape one step earlier — "paying somebody is not what erases their name" — and the argument does not weaken when the ending is contested rather than clean.
2. **`cancelled` and `reassigned` are shut because nothing was delivered.** A resolved dispute is the opposite: work was done, or was alleged to have been done, and an operator adjudicated it.
3. **It widens _when_, not _what_.** The pair was open for the entire life of the engagement, including the whole period the dispute was open. Closing it now would withdraw information already disclosed.

**Ratings do not follow.** `submit_rating` gates on `outcome = 'completed'` alone, so a disputed deal is **readable and not rateable**. The parties keep the record; the trust graph does not take a score from a deal an operator had to decide.

## Consequences

- `supabase/tests/marketplace_proof.sql` had a four-way conjunction asserting that neither `failed` nor `disputed` was reachable from the working states. The `disputed` half is now **inverted rather than deleted**, which required splitting the conjunction. A conjunction cannot be half-inverted; that is the recorded cost of asserting four facts in one `ok`.
- `disputes` carries **no state column**. `tasks.state` is the machine (ADR-0016), `disputed` is a value in it, and open is derived as `resolved_at is null`. A status column would be a second machine over one truth.
- Node suspension on repeat low ratings, which `human-nodes-marketplace.md:1040` specifies, is **deliberately not built**. `kyc_status` has no `* -> suspended` arc and adding one without a moderation console would create a state with no exit — this ADR's own defect, one table over.

## Links

- [admin-ops.md](../30-modules/admin-ops.md) · [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) · [payments-billing.md](../30-modules/payments-billing.md)
- [ADR-0016](0016-an-engagement-has-no-state-of-its-own.md) — why `disputes` has no lifecycle
- [ADR-0018](0018-offer-exhaustion-returns-the-step-to-its-owner.md) / [ADR-0023](0023-a-breached-deadline-reassigns.md) — the `failed`-is-terminal and back-to-`matching` reasoning this reuses
- [ADR-0025](0025-a-partial-settlement-is-a-refund-and-a-new-hold.md) — the money half of `partial`
- `20260908120000_dispute_arcs.sql`, `20260908121000_payout_failed_arc.sql`, `20260908126000_counterparty_admits_disputed_resolved.sql`
