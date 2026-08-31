# ADR-0016: an engagement has no state of its own; the task is the state machine

- **Status:** Accepted
- **Date:** 2026-08-31
- **Affects:** [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) · [business-projects-workflow.md](../30-modules/business-projects-workflow.md) · [data-model.md](../10-architecture/data-model.md) · [payments-billing.md](../30-modules/payments-billing.md)

## Context

[human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md)
specifies an engagement lifecycle:

> `CLAIMED → ESCROW_FUNDED → IN_PROGRESS → PROOF_SUBMITTED → IN_REVIEW →
APPROVED → PAID` (with `REJECTED → IN_PROGRESS` bounded re-do, and `DISPUTED`
> → ops).

It also lists `engagements` as an entity. The obvious reading is that
`engagements` carries a state column holding those values.

**Every one of those values is already a `public.task_state`.** They were
declared in `20260813120000_workflow_dag.sql`, they are already wired into
`private.task_transition_allowed`, the arcs between them are already enforced
by `tasks_guard_transition` — **including against `service_role`** — and every
transition already writes a `task.transitioned` row into `events`. That
subgraph has been in the machine, unreachable, since the day the DAG landed.

`engagements` is deferred to slice 5, but the decision has to be made now,
because the whole slice sequence after the domain landing is derived from it
and slice 1's deferral of `engagements` is only defensible if the shape is
settled. An ADR written at slice 5 would be a rationalisation of a decision
already spent.

## Decision

**`engagements` carries no state enum.** Engagement state is read from
`tasks.state`. The table carries the facts about the _deal_ that the task
cannot hold.

## Why

**Two machines over one truth is this repository's most expensive recorded
defect.** `is_project_member` and `roomForProject` answered one question two
ways and cost six projects their visibility (`20260827110000`). A second
lifecycle enum would be that again, and **worse, because it would drift
silently**: "the engagement says `in_progress` and the task says `in_review`"
is not an error, it is a confusing screen. The task machine raises on an
illegal arc; a parallel enum would simply hold a different value and nobody
would be told.

**The task machine already enforces more than a new enum could.** It binds
`service_role`, it is `SECURITY DEFINER`, it stamps `updated_at` and writes the
audit event in the same trigger — the house rule that an audit entry cannot be
forgotten by a caller and cannot describe a transition that did not happen. A
new enum would start with none of that and have to earn it back.

**The table is not thin without it.** It carries what is true about the deal
and false about the work:

- `task_id`, `node_id`, `offer_id` — the binding
- `agreed_price` + `currency` — **the price at acceptance**, which must not
  follow `node_profiles.rate` when the node re-prices next week
- `deadline_at`, `accepted_at`, `nda_signed_at`, `terms_hash`
- `ended_at`, `outcome`

The tenancy predicate, the thread admission and the escrow foreign key all hang
off this row.

**`outcome` looks like state and is not.** `completed | reassigned | cancelled
| disputed_resolved`, null until `ended_at`, written once and guarded write-once
by trigger. It has no arcs and no map. This is the distinction the repository
already draws between `campaign_state` and `pause_reason`: the reason is data
and the state is the machine, because a paused campaign is paused however it
got there. A completed engagement and a reassigned one leave otherwise
identical rows, and that difference has to survive.

## Consequences

Both are stated now so slice 5 arrives to them rather than discovering them:

1. **One live engagement per task**, enforced by
   `create unique index engagements_one_live_idx on public.engagements (task_id)
where ended_at is null`. It cannot be a plain `unique (task_id)`, because a
   reassignment after a node no-show creates a second engagement on the same
   task — and the machine already says so: `claimed → matching` is one of the
   arcs `20260815220000` dropped and slice 5 restores.

2. **Multi-node splits are deferred, with a trigger.**
   [payments-billing.md](../30-modules/payments-billing.md) says one charge can
   fund several transfers. Under this design that needs several live
   engagements on one task, which the partial index forbids. **Trigger:** the
   first plan step whose acceptance criteria name more than one node. At that
   point the index is what changes, and the state question does not reopen.

A third consequence is a benefit rather than a cost: the marketplace inherits
the DAG for free. A dependent step is unblocked by `approved` whoever produced
it, so `task_deps_satisfied` needs no marketplace awareness at all.

## Alternatives considered

- **A full `engagement_state` enum mirroring the task states.** Rejected above:
  two machines, silent drift, and everything the task trigger already does
  would have to be rebuilt.
- **A denormalised `state` column on `engagements`, written by the same
  trigger that moves the task.** Rejected. It removes the drift but keeps the
  second copy, and it invites exactly the query that reads the copy instead of
  the source. A view is the right shape if joining ever gets tedious, and a
  view cannot drift.
- **No `engagements` table at all — put `node_id` and `agreed_price` on
  `tasks`.** Rejected: it makes reassignment lossy (the previous engagement's
  price and terms are overwritten), and it puts marketplace columns on the
  table every other module reads.
