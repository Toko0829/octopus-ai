# ADR-0030 — An escalation is an event, and a playbook is the card that was approved

**Status:** Accepted · **Date:** 2026-09-11 · **Slice:** workflow remainders

## Context

[business-projects-workflow.md](../30-modules/business-projects-workflow.md) has carried the same sentence since the domain landed on `20260813120000`: "**Not built yet:** `playbook_versions` and `escalations`." Both tables were specified in Phase 0, both appear in the module's key-entity list and in [data-model.md](../10-architecture/data-model.md), and neither has ever had a writer or a reader named for it. Every slice since has walked past them.

This repository's most-documented defect class is a table with no writer: `tasks.risk_tier` unreachable for its whole life, `task_deps` holding no row for two weeks while enforcing an empty set, `campaign_outcomes` guarded and granted and unwritten for a month. The rule that came out of those is that a table lands with its writer, and a writer lands with the reader that needs it. Applying that rule to these two tables is what this ADR does, and the answer for both is that the thing they were specified to hold already exists somewhere else.

## Decision 1: an escalation is derived from `public.events`, not written beside it

`escalations` was specified as `id`, `task_id`, `trigger`, `target` (HUMAN/USER), `created_at`, `resolved_at`. Every one of those columns is already a row in the audit log:

| specified column | where it already is                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `task_id`        | `events.subject_id` with `subject_type = 'task'`                                                                          |
| `target`         | `events.payload->>'to'`, either `escalated` or `needs_user`, on the `task.routed` event the scheduler port writes         |
| `trigger`        | `events.payload->>'reason'` on the same event, which is the router's rule in words ("nothing cites this step", and so on) |
| `created_at`     | that event's `created_at`                                                                                                 |
| `resolved_at`    | the `created_at` of the next transition event on the same task, written by the trigger on `tasks`                         |

`createSchedulerPorts` in `apps/api/src/lib/scheduler.ts` already inserts the `task.routed` event for exactly the three route targets and says why in its own comment: "escalated because nothing cites this step" is not derivable after the fact, so it is recorded at the moment of the decision. That is the escalation record. A second table holding the same five facts would be the second answer to one question that [ADR-0028](0028-a-notification-is-derived-from-the-event.md) refused for notifications, on the same table, for the same reason.

**What would have made the table right:** a reader that needs escalations as rows rather than as a query. The one named anywhere is the task-queue ops console in [admin-ops.md](../30-modules/admin-ops.md), which is Phase 3 and which the no-show and reconcile sweeps have so far made unnecessary. If it arrives and the query over `events` is too slow for it, the fix is a view or a materialised projection **derived from the events**, the way `notifications` is, and not a table application code writes beside them.

## Decision 2: a playbook version is the plan card that was approved

`playbook_versions` was specified as `project_id`, `archetype`, `jurisdiction_pack`, `compiled_dag`, `version`, so a plan is "reproducible and auditable". Two of those columns have no producer anywhere in the system: there is no playbook compiler, because plans come from the reasoning core's planner rather than from an archetype crossed with a jurisdiction pack, and there is no jurisdiction pack, because the marketing wedge is one market and the packs are Phase 5's business-formation vertical.

The other three already exist. `materialise_plan` reads the DAG it builds **from the approved card's own payload**, "so what was approved is what gets built", and `action_embeds` keeps that payload, its `state`, who acted on it and when. A replan produces a new card carrying `supersedes`, and the intake slices made a superseded plan `expired` with `expires_at` stamped. The chain of cards on a project is the version history the table was going to hold, and it is already the thing an owner can read.

**What would make the table right:** the compiler. When a plan is produced by compiling an archetype against a dated jurisdiction pack rather than by a planner, the compiled DAG and the pack version it was compiled from are facts the card does not carry, and `playbook_versions` is where they go. That is the trigger, and it is recorded in the roadmap's deferred table rather than in this module's "not built yet" line, because "not built yet" has meant "not going to be built by any slice this phase" for a month.

## Consequences

- The module's status block, its key-entity list and the two architecture docs stop naming either table as pending. `escalations` is removed from the entity lists; `playbook_versions` is moved to the roadmap's deferred-by-design table with its trigger.
- Nothing is migrated. Neither table exists in Postgres, so there is nothing to drop.
- The third remainder the same sentence named, the sweep that heals a step stranded at `approved`, **is built** in the same change, because it had a writer, a reader and a live symptom. It is documented in the module doc rather than here, since it is an implementation of a decision the executor already recorded, not a new one.
