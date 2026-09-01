# ADR-0019 — `claimed → matching` stays dropped, because `claimed` is transit-only

- **Status:** Accepted
- **Date:** Phase 2, slice 5 of the marketplace sequence (`20260904125000`)
- **Context docs:** [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md), [business-projects-workflow.md](../30-modules/business-projects-workflow.md), [payments-billing.md](../30-modules/payments-billing.md)
- **Reverses a commitment made in:** the slice table in `human-nodes-marketplace.md`, which listed `claimed → matching` as the arc slice 5 would restore. Also a consequence stated in [ADR-0016](0016-an-engagement-has-no-state-of-its-own.md).

## Context

`20260813120000` declared the task machine with `claimed → escrow_funded | matching`.
`20260815220000` rewrote the map for an unrelated reason and **silently dropped
eight arcs**, this one among them. The module doc then booked each dropped arc to
the slice that would first make it reachable, and gave slice 5 this one.

The reasoning was ADR-0016's. That ADR argues an engagement has no state column of
its own, and ends on two consequences: one live engagement per task, expressed as
a partial unique index rather than a plain one, "because reassignment after a
no-show creates a second engagement **and `claimed → matching` exists to say
so**." So the arc was booked as the machine's way of expressing reassignment.

Slice 5 built acceptance. This ADR records that it did not restore the arc, and
why the earlier reasoning pointed at the wrong state.

## Decision

**`claimed → matching` stays dropped.** `public.accept_offer` moves the task
`offered → claimed → escrow_funded` as two conditional UPDATEs **inside one
transaction**, so `claimed` exists for no observable instant. The reassignment
arc the machine needs leaves from `escrow_funded` or later, and it lands with the
slice that builds the no-show and reassignment path (slice 6), which is where the
question genuinely reopens.

The second consequence ADR-0016 states is unaffected: `engagements_one_live_idx`
is a partial unique index on `where ended_at is null`, so a second engagement on
one task is still legal and is still how reassignment is expressed. Only the
sentence naming `claimed → matching` as the arc that "says so" is withdrawn.

## Rationale

**Acceptance and funding are one act, so `claimed` is not a state anything sits
in.** `claimed → escrow_funded` is the machine's only exit from `claimed`. That
is not an accident of the map: accepting without funding leaves a node holding
work nobody paid for, which is `20260827120000`'s seventeen-permanently-stuck-steps
defect reproduced deliberately. So the two moves happen in one transaction, and
nothing can be at `claimed` when that transaction is not running.

**An arc out of a state nothing occupies is the defect this sequence exists to
avoid.** A map permitting an unmakeable transition is a guard that spends its life
not guarding, and the next reader cannot tell "unused" from "not yet wired". This
repository has recorded that shape five times (`tasks.risk_tier`, `task_deps`,
`artifacts.storage_path`, `projects.budget_ceiling`, `profiles.role`) and refused
it once explicitly in [ADR-0018](0018-offer-exhaustion-returns-the-step-to-its-owner.md).

**The arc would also collide on a unique index, quietly.** `cascadeRound` in
`apps/api/src/lib/match.ts` derives the next round by counting
`offered → matching` transitions in `events`. A restored `claimed → matching`
producer would send a task back to the market **without** incrementing that
count, so the next offer would be written at a round that already has one and
collide on `offers_task_round_idx`. The sweep would read the old row back and
finish a move for the wrong candidate. That is a second, independent reason the
arc cannot simply be restored and used: it needs a round derivation that counts
both ways in, which is a change to the cascade rather than to the map.

**The reassignment case the arc was booked for starts later than `claimed`.** A
no-show is a node who accepted and then did nothing, which means escrow is funded
and a thread exists. Recovering from it has to unwind those, and the state it
leaves from is `escrow_funded` or `in_progress`, not `claimed`. Restoring an arc
out of `claimed` would not have served the case it was booked for.

## Consequences

- **Slice 5 restores no arc**, so the slice table's "State arcs it restores"
  column reads "none, deliberately (ADR-0019)". **Five consecutive slices have
  now restored none**, which is worth saying plainly rather than smoothing over:
  the machine `20260813120000` declared was drawn wider than the product has
  needed, and each slice is finding that again.
- **No task-map migration ships in slice 5 at all.** `offered → claimed` and
  `claimed → escrow_funded` have been in `private.task_transition_allowed` since
  `20260813120000` and simply had no producer. They gain one; the map is
  untouched.
- **Two `task.transitioned` events per acceptance**, and this is deliberate
  rather than an artefact. Collapsing the two moves into one direct
  `offered → escrow_funded` arc would need a map change to hide an audit row, and
  the trail of a step that was taken and then funded is two facts.
  `marketplace_engagements.sql` asserts the count is 2.
- **The premise is falsifiable and this ADR names the falsifier.** **If
  acceptance ever splits into two transactions, `claimed` gains a crash window,
  a task can be observed sitting in it, and the arc out becomes necessary.** The
  most likely cause would be a real payment provider whose charge has to be
  created outside the database transaction. The slice that does that reopens this
  decision, and `20260904125000`'s header says so beside the code.

## Alternatives considered

- **Restore the arc and leave it unused**, as documentation of intent. Rejected as
  the `task_deps` defect, and refused on identical grounds by ADR-0018 one slice
  earlier.
- **Collapse the two moves into a single `offered → escrow_funded` arc**, so that
  `claimed` is not entered at all. Rejected: it needs a map change to remove a
  state the specification uses and the module doc names, it loses one audit
  event, and it makes "a node took this step" and "the step is funded" the same
  fact when they are two.
- **Restore it now and give it a producer in the accept path** — a rollback arc
  when funding fails. Rejected because that producer does not exist and cannot:
  the whole transaction unwinds instead, so a failed funding leaves the task at
  `offered`, which is where it already was.
