# ADR-0023 — A breached deadline returns the step to the market, in one transaction

- **Status:** Accepted
- **Date:** 2026-09-06
- **Context:** Marketplace slice 6 (the engagement loop to `approved`)
- **Reopens:** [ADR-0019](0019-claimed-to-matching-stays-dropped.md), which named
  slice 6 as where the reassignment question genuinely reopens
- **Supersedes:** the slice table's booking of `blocked → in_progress` to slice 6

## The decision

When the expert who accepted a step misses the agreed date, a sweep calls
`public.reassign_engagement`, which in **one transaction** returns the task to
`matching`, refunds the escrow hold with its reversing ledger pair, ends the
engagement with `outcome = 'reassigned'`, and revokes the node's thread access.

Two arcs are restored: `escrow_funded → matching` and `in_progress → matching`.
**Three stay dropped**: `claimed → matching`, `proof_submitted → in_progress`,
and `blocked → in_progress`.

## Why `matching`, and not `escalated` or `failed`

**Not `failed`**, on [ADR-0018](0018-offer-exhaustion-returns-the-step-to-its-owner.md)'s
grounds, unchanged: it is terminal, it blocks every dependent step, and it would
put beyond reach work the marketplace can still finish with a different person.

**Not `escalated`**, and this is the half worth writing down. Two things in the
schema were built for this path and have had no producer since they landed:

- `engagements.outcome` has carried `'reassigned'` since `20260904120000`,
  defined there as a no-show whose step went back to the market;
- `engagements_one_live_idx` is a **partial** unique index on
  `(task_id) where ended_at is null` rather than a plain unique, specifically so a
  second engagement can exist on a task after a first one ends.

Routing a no-show to `escalated` would make `'reassigned'` a word the schema uses
and the product never means, and would leave that partial index unjustified. The
owner still has every control they had: the step at `matching` can be cancelled,
and the panel's other buttons are unaffected.

## Why it is one transaction

`escrow-reconcile.ts` accepts a bounded gap between its four steps, on the
grounds that each is individually idempotent-by-condition and the money figure —
the one an owner reads — is corrected first. **That reasoning does not transfer**,
because one of the actors in this window is a live human doing work, and every
partial state is unsafe in a way a slow correction does not fix:

| Partial state                     | What it does                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task moved, hold still `held`     | `accept_offer`'s ceiling check counts the stale hold, so the replacement node is refused for money already spoken for. The step is back on the market and cannot be taken |
| task moved, engagement still live | the replacement `accept_offer` collides on `engagements_one_live_idx` and unwinds **permanently, on every retry**                                                         |
| hold refunded, task not moved     | the node is still working and their fee is gone                                                                                                                           |
| engagement ended first            | the sweep reads live engagements, so a crash here makes the step invisible to the thing meant to finish unwinding it                                                      |

So this is `accept_offer`'s shape for `accept_offer`'s stated reason: supabase-js
speaks PostgREST and has no transaction, and written in Node this would be six
statements that can half-happen. **It is the second thing in this domain to need
atomicity, and the first for a reason other than accept-and-fund being
inseparable.**

## The race with the node, and who wins

The task move is a **conditional UPDATE on the two states a no-show can be in,
and zero rows raises**, which unwinds everything above it. That is the whole
safety argument rather than defensive tidiness: a node who submitted their proof
in the seconds between the sweep's read and this call has moved the task to
`proof_submitted`, and **they win**. Their work is kept, their escrow is
untouched, and the next pass reads a state it does not select.

## The arc the sweep must never take

Neither new edge leaves from `proof_submitted` or `in_review`. **A deadline that
passes after the work was handed over is the owner's failure to review, not the
node's failure to deliver**, and reassigning there would take work away from
somebody who finished it and give their fee to a stranger. This is enforced
twice, in the map and in the sweep's selection, which is deliberate duplication
for the one rule where a single guard is not enough.

## The defect this arc creates, and the fix that ships with it

`cascadeRound` in `apps/api/src/lib/match.ts` derived the cascade round by
counting `task.transitioned` events with `from = 'offered', to = 'matching'`. A
reassignment reaches `matching` from `escrow_funded` or `in_progress` and does not
increment that count, so the next matcher pass would have:

1. computed **the round the no-show's offer already holds**;
2. collided on `offers_task_round_idx`;
3. taken the `23505` arm, which reads the existing offer back — **the no-show's
   `accepted` offer**;
4. moved the task to `offered` against it, and written `offer.created` naming a
   third node and an offer id that is not theirs.

This is the second, independent objection ADR-0019 raised against reintroducing
an arc into `matching`, arriving exactly as predicted. The predicate now counts
every **return from dispatch** (`to = 'matching' and from <> 'escalated'`), which
is arithmetically identical today, so **no live task renumbers**, and which
absorbs this arc and any future one. Pinned in `match.test.ts` from both sides:
that a reassignment increments the round, and that the owner's first dispatch
does not.

## Why three arcs stay dropped

**`claimed → matching`** — the arc ADR-0019 dropped and this ADR reopens. Accept
and fund are still one transaction, so `claimed` is still transit-only and no
reassignment can leave from it. That ADR's own prediction, that the producer
"leaves from `escrow_funded` or later", is what happened.

**`proof_submitted → in_progress`** — booked to this slice for a withdrawn proof
and for the floor check bouncing a bad hand-over. Retraction has no producer, and
the bounce does not need it: the check runs before anything is written and before
the task moves, so a bounced submission leaves the step where it was. Recorded in
[ADR-0022](0022-proof-is-an-artifact.md).

**`blocked → in_progress`** — nothing writes `blocked` for a human step, so it is
an exit from a state nothing can enter. ADR-0018's grounds, applied again.

## What this costs

**The number of hours is a guess.** `WORK_TTL_HOURS` is seven days, chosen the way
`OFFER_TTL_MS` was: a node has no notification channel, so anything tight would
expire against people who had not looked, and full-funnel marketing work has
other people's calendars in it. It has never been tested against a real deadline
being missed. **Its falsifier is the first miss for a reason other than silence**,
and the number is a constant rather than an env var so that changing it is a
change to the product rather than to a deployment.

**A warning is not a negotiation.** The sweep tells a node once, a day out, and
then acts. There is no way for them to ask for longer except by saying so in the
thread, and no way for the owner to grant it except by not having set the deadline
that way. An extension writer is the obvious next thing and is deliberately not
here: it needs a surface, an authorisation question ("whose extension is it to
grant?") and an audit story, and inventing all three alongside the first producer
of the column is how a control ships without its reasoning.

## Consequences

- `engagements.deadline_at` and `engagements.outcome = 'reassigned'` both get
  their first producers, two slices after landing as facts with no recorder.
- `offers.work_deadline_hours` is new, so the node sees the deadline **before**
  they accept and a later change to the constant cannot shorten time somebody
  already has.
- The `NO_SHOW_ENABLED` / `NO_SHOW_MAX_PER_TICK` pair is on by default; with it
  off, an abandoned step stays `escrow_funded` forever and its hold keeps
  committing the ceiling, which is the dead end this slice exists to close.
- **Five consecutive slices restored no arc; this one restores two**, and both
  arrive with their producer in the same push.
