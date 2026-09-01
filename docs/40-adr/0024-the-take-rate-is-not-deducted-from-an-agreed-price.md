# ADR-0024 — The take rate is not deducted from a price somebody already agreed to

- **Status:** Accepted
- **Date:** 2026-09-07
- **Context:** Marketplace slice 7 (payout)
- **Constrains:** the first pricing slice, which has to change the **offer**
  before it can change a payout
- **Related:** [ADR-0013](0013-approving-a-campaign-publishes-it.md), whose
  ordering this slice takes, and
  [ADR-0011](0011-spend-cap-checked-twice.md), whose "the model never proposes
  the figure" stance this extends to the platform's own cut

## The decision

`payouts.platform_fee` lands as a real column and is written from one constant in
`apps/api/src/lib/payout.ts`. **That constant is `0`.** A node is paid exactly the
`agreed_price` frozen onto their engagement at acceptance, which is exactly the
amount `accept_offer` held in escrow, which is exactly the figure the offer showed
them before they said yes.

The 15–25% marketplace take rate in [vision.md](../00-overview/vision.md) is not
implemented, and implementing it is a **pricing slice** rather than a line in this
one.

## Why not just take the cut here

Because escrow holds the price the node was shown, and the node was shown it
_before_ they accepted. `offers` carries no fee, no gross-versus-net distinction
and no rate; `node_profiles.rate` is what the matcher ranks on and what
`accept_offer` freezes; the node console renders "Accept and lock the price"
beside that number. Deducting 20% at release would mean every one of those
surfaces showed somebody a figure and then paid them a different one.

That is not a rounding problem or a copy problem. It is the same class of act
ADR-0011 refuses in the other direction: there, a model must not propose the
budget because once written, a figure a model invented and a figure a person
authorised are the same number on the same row. Here, a fee introduced after
acceptance would make the number a person agreed to and the number they are paid
two different things, with only our word connecting them — and the party who
benefits from the gap is us.

## What a take rate actually requires

All of it is real work, and none of it belongs in a sweep:

- **The offer names the fee**, or names the net, before anybody accepts. That is a
  schema change to `offers` and a change to what the matcher ranks on: if the
  platform takes a cut, "rate ≤ escrowed task budget" and "rank by price" are both
  asking about the wrong number.
- **The node console shows it** on the accept confirmation, beside the price, in
  the same place it currently says the price is locked.
- **The escrow arithmetic decides what the owner is charged.** Either the owner
  pays the node's price plus a fee (the ceiling commits more than the node
  receives) or the node receives less than the ceiling commits. Those are
  different products with different `budget_ceiling` behaviour, and
  [ADR-0020](0020-the-ceiling-has-two-committer-classes.md) already says four
  places must agree on that sum.
- **The chart of accounts gains `platform_fee`**, and the release pair becomes
  three entries rather than two.
- **Somebody chooses a number**, which is a business decision this repository has
  recorded as a range and never as a figure.

Building any of that as a side effect of "the expert gets paid" would be shipping
a pricing model nobody reviewed, inside a slice whose subject is a state machine.

## Why the column lands anyway

`platform_fee` is in the data-model spec ([data-model.md](../10-architecture/data-model.md)),
so omitting it would be divergence rather than deferral, and rule 1 says
reconcile rather than diverge.

**A column with a constant value is not the anti-pattern this repository keeps
recording.** That one is a _rule_ enforced over an empty set — `task_deps` guarded
against cycles while holding no rows, `room_members.scope` reading as a control
while enforcing nothing, `held → released` permitted with nothing able to walk it.
This is a _fact_ with a value: every payout row carries a fee, and the fee is
zero. It follows `node_profiles.trust_score`, which landed as a nullable column
specifically so its writer would arrive to a column rather than to a migration.

The constant is in code rather than in an environment variable, and that is
deliberate: a fee settable by deployment is a fee that could differ between two
nodes doing the same work on the same platform, with no surface on which either of
them could have seen it.

## Consequences

- **A node is paid what the offer said.** The one property this ADR exists to
  protect.
- **`amount` and `agreed_price` and `escrow_holds.amount` are all equal in this
  build**, and the code reads the hold rather than assuming the equality, so the
  day a fee exists the arithmetic has one place to change.
- **The platform earns nothing from the marketplace yet**, which is true and
  should be said plainly rather than obscured by a column that looks like it is
  doing something.
- **`apps/api/src/lib/payout.test.ts` asserts `platform_fee` is 0 and `amount` is
  the full price.** When a take rate lands, that assertion is what fails first,
  and it fails next to a test that will remind whoever changed it that the offer
  has to name the fee.
