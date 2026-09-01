# ADR-0020 — `projects.budget_ceiling` has two committer classes, and four places move in step

- **Status:** Accepted
- **Date:** Phase 2, slice 5 of the marketplace sequence (`20260904121000`, `20260904123000`)
- **Context docs:** [payments-billing.md](../30-modules/payments-billing.md), [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md), [data-model.md](../10-architecture/data-model.md)
- **Extends:** [ADR-0011](0011-spend-cap-checked-twice.md), whose discipline this reuses.

## Context

`projects.budget_ceiling` is the one number in this product that means "the owner
authorised this much." Since `20260829140000` exactly one class of thing has been
committed against it: the `budget_cap` of non-terminal sibling campaigns. That
sum appears in three places by design, argued in
[ADR-0011](0011-spend-cap-checked-twice.md): a readable refusal in the API
(`checkSpendCap` over `readSpendInputs`), an authoritative re-check in SQL under a
row lock (`materialise_campaign`), and a figure on the project panel so a person
can see their own headroom.

Slice 5 introduces `escrow_holds`. When a node accepts a step, the price is held
against the same ceiling: that is what "escrow can never exceed the budget
pre-auth" means in payments-billing.md's money flow. So the ceiling now has **two**
classes of committer, and every place that sums one has to sum both.

## Decision

**`projects.budget_ceiling` is committed against by non-terminal campaign
`budget_cap`s AND by `escrow_holds` at `state = 'held'`.** Four places compute
that sum, and they must move in step:

| #   | Place                                                                                           | Pinned by                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `packages/marketing/src/spend.ts` `checkSpendCap`                                               | `packages/marketing/src/spend.test.ts`                                                  |
| 2   | `apps/api/src/lib/spend-reads.ts` `readSpendInputs`                                             | `apps/api/src/lib/spend-reads.test.ts`                                                  |
| 3   | the SQL sum inside `public.materialise_campaign`, and the same sum inside `public.accept_offer` | `supabase/tests/materialise_campaign.sql`, `supabase/tests/marketplace_engagements.sql` |
| 4   | the `committedBudget` projection in `apps/api/src/routes/projects.ts`                           | `apps/api/src/routes/projects.test.ts`                                                  |

**The filters are identical on both classes and on both sides.** A terminal
campaign holds none of the ceiling; a campaign with a null cap contributes
nothing rather than turning the sum into NULL; a `released` or `refunded` hold
holds none of it. Money no longer committed is not money still committed, in
either vocabulary.

**`existingEscrowHolds` is a required field on `SpendCapInput`, not an optional
one.** An optional field defaulting to `[]` would let a call site that had never
heard of escrow keep passing a check that no longer means what it says, silently.
A required field makes every call site a place somebody had to decide.

## Rationale

**A per-class limit is not a limit.** This is the same argument `checkSpendCap`
already makes about per-campaign checks: N campaigns of ceiling-minus-one each
pass individually and blow through the ceiling together. Two classes fail the same
way. A project with its entire ceiling in escrow could authorise a campaign for
the whole ceiling again, and the only visible symptom would be a `budget_ceiling`
that no longer bounds anything.

**The two classes cannot race each other, because both lock the same row.**
`materialise_campaign` and `accept_offer` each take `select ... for update` on the
project row before their re-check, so a campaign approval and an acceptance
serialise rather than both reading a total the other is about to change. That is
ADR-0011's argument extended to a second writer, and it is the reason the SQL
half exists at all: a check made in Node passes for both of two concurrent actors,
because each reads the committed total before either writes.

**Refusals name both classes, because one of them is invisible on screen.** An
owner reading a refusal is looking at a campaign list that shows the campaign
half and says nothing about escrow. A message quoting a single total they cannot
account for reads as a broken check rather than as a full budget, so every refusal
in all four places states the two figures separately. The project panel does the
same, with "of which held in escrow" beneath the committed total.

**Drift fails a test rather than passing quietly**, which is the whole of ADR-0011's
discipline reused. Each of the four places is pinned by a suite asserting the same
boundary in both directions: exactly on the ceiling is authorised, one unit past
it is refused, and a settled hold contributes nothing.

## Consequences

- **A fifth place is one migration away.** Any future reader of "what is committed"
  joins this table. The contract is stated here rather than in four separate
  comments so that adding one means editing this ADR.
- **`escrowHeld` is broken out on `ProjectDetail` as well as folded into
  `committedBudget`.** The two halves settle on different clocks: a campaign cap
  frees up when the campaign ends, a hold frees up when the step finishes or
  stops. An owner looking at a number they cannot reduce needs to know which half
  is which.
- **A hold that is never unwound pins the ceiling permanently**, which is why
  `held → refunded` has a producer in the same slice
  (`apps/api/src/lib/escrow-reconcile.ts`) rather than being left to the payout
  slice. Without it, a kill-switched step would hold part of somebody's budget
  against work that will never happen and nothing could release it.
- **The third class is already visible.** A payout will move a hold from `held` to
  `released`, at which point it stops committing the ceiling and starts being
  money that left. That is a change to which states count, not to how many classes
  there are, and the filter above is written as `state = 'held'` rather than as
  "not refunded" so that it stays correct when release arrives.

## Alternatives considered

- **A `committed_total` column on `projects`, maintained by triggers.** Rejected
  for the reason [ADR-0016](0016-an-engagement-has-no-state-of-its-own.md) refuses
  a second state machine: it is a denormalisation of a sum that two tables already
  hold, it drifts silently when a trigger is forgotten, and the failure mode is a
  number nobody can tell is wrong. The sums here are indexed reads over a handful
  of rows.
- **A CHECK constraint on the ceiling.** Rejected on data-model.md's standing
  ground: a constraint is a rule the database applies to itself with no idea what
  was authorised. This is the transactional arm of a tool, reachable by
  `service_role` alone.
- **One shared SQL function both writers call**, instead of the sum appearing in
  `materialise_campaign` and `accept_offer`. Genuinely tempting and rejected on
  balance: the two differ in what they add to the total (a card's `budgetCap`
  against a node's frozen rate), in the lock they take it under, and in the
  sentence they raise. A helper would have to take all three as parameters and
  would leave the row lock outside it, which is the half that actually matters.
  Both are pinned by suites asserting the same boundary instead.
