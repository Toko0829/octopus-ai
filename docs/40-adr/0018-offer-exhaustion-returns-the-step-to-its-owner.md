# ADR-0018 — An exhausted cascade returns the step to its owner, and `→ failed` stays dropped

- **Status:** Accepted
- **Date:** Phase 2, slice 4 of the marketplace sequence (`20260903120000`)
- **Context docs:** [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md), [business-projects-workflow.md](../30-modules/business-projects-workflow.md)
- **Reverses a commitment made in:** the slice table in `human-nodes-marketplace.md`, which listed `matching → failed` and `offered → failed` as arcs slice 4 would restore.

## Context

`20260813120000` declared the task machine with `matching → offered | failed` and
`offered → claimed | matching | failed`. `20260815220000` rewrote the map for an
unrelated reason and **silently dropped eight arcs**, these two among them.
Nobody noticed for two weeks, which is why `marketplace_rls.sql` began pinning
the absences: an unasserted absence is indistinguishable from an oversight.

The module doc then booked each dropped arc to the slice that would first make it
reachable, and gave slice 4 these two, with the reasoning that "no eligible node"
is a real outcome and must be recordable. `marketplace_rls.sql` said so in a test
message: the arc "is restored in slice 4, with the matcher that can produce it,
and not before."

Slice 4 built the matcher. This ADR records that it did not restore them, and
why the earlier reasoning was wrong.

## Decision

**An exhausted cascade moves the task `matching → escalated`**, an arc that has
existed since `20260813120000`, and posts one system message naming the step and
what the owner can do next. `matching → failed` and `offered → failed` stay
dropped. They are refused for the ordinary reason every unreachable arc in this
machine is refused: nothing produces them.

## Rationale

**`failed` is terminal, and exhaustion is not a terminal condition.** The three
terminal states are `done`, `failed` and `cancelled`, and nothing leaves any of
them. A step that reached `failed` because no expert happened to be available
would block every dependent step in the DAG permanently, and it would do so on
the strength of a fact about our supply on one afternoon rather than a fact about
the work.

**The owner can still do it, and already has the buttons.** `20260827120000` gave
every `escalated` step "I will do this one" and "Try again", and slice 4 adds
"Find an expert" beside them. Returning an exhausted step to `escalated` returns
it to a screen with three live controls. Sending it to `failed` would take a step
somebody could have finished themselves and put it beyond reach, which is the
dead-end shape this repository has now recorded six times.

**The distinction the original reasoning wanted is in the trail, not in the
state.** "No eligible node" is recorded: the `task.transitioned` event carries
`matching → escalated`, and the system message states it in the room in words.
What the arc would have added is a state nobody can leave, in exchange for a
distinction the events log already draws.

**A failure this cascade could produce is not the failure `failed` describes.**
The other producers of `failed` are an executor that could not do the work and a
platform that rejected a campaign: both are statements about the task. Exhaustion
is a statement about the marketplace, and it becomes false as soon as one node
joins.

## Consequences

- **A step can cycle.** Dispatched, exhausted, returned, dispatched again. That is
  bounded in practice by `offers_task_node_idx`: a node is offered a given task
  once ever, so a second dispatch against an unchanged pool exhausts immediately
  and cheaply. The owner sees the same honest message again. Recorded as a limit
  in the module doc rather than left to be discovered.
- **`matching → failed` and `offered → failed` may never be restored**, and that
  is the honest reading rather than a deferral. If a future slice finds a
  marketplace failure the owner genuinely cannot take back, it restores the arc
  with that producer, and this ADR is what it argues against.
- **Three test messages changed and one verdict did not.**
  `marketplace_rls.sql` still asserts the arc is refused; only its stated reason
  moved from "restored in slice 4" to "stays refused". The correction is
  deliberate: a test file promising a future change is a commitment, and leaving
  it in place after deciding otherwise is how a suite starts lying about intent.
- **The slice table's "State arcs it restores" column reads "none, deliberately"
  for slice 4**, matching slices 1 through 3. Four consecutive slices restoring
  no arc is worth noticing rather than smoothing over: it says the machine
  `20260813120000` declared was drawn wider than the product has needed.

## Alternatives considered

- **Restore the arcs and use them.** Rejected above: terminal, blocks dependents,
  and unreachable for the owner.
- **Restore the arcs and leave them unused**, as documentation of intent.
  Rejected as exactly the `task_deps` defect the marketplace sequence was
  ordered to avoid: a map permitting a transition nobody makes is a guard that
  spends its life not guarding, and the next reader cannot tell the difference
  between "unused" and "not yet wired".
- **A new non-terminal state, `unstaffed`.** Rejected because it would be
  `escalated` with a different name: same meaning (a human is needed and none is
  engaged), same controls, same exits. `20260815220000` already produced one
  state-shaped duplicate of a condition, and a second enum value for a condition
  the machine can express is the drift [ADR-0016](0016-an-engagement-has-no-state-of-its-own.md)
  refuses on the engagement side.
