# ADR-0010 — Durable runs on Postgres, not on a managed orchestrator

- **Status:** Accepted
- **Date:** Phase 2
- **Context docs:** [architecture.md](../10-architecture/architecture.md), [ai-orchestrator.md](../30-modules/ai-orchestrator.md), [business-projects-workflow.md](../30-modules/business-projects-workflow.md), [infra-devops.md](../30-modules/infra-devops.md)
- **Amends:** [ADR-0001](0001-durable-orchestration-trigger-vs-temporal.md), which pinned Trigger.dev v3 as the durable backbone. Temporal remains the documented escape hatch, unchanged.

## Context

ADR-0001 was written in Phase 0, before any of the workflow existed, and it chose a managed orchestrator for five things: durable execution, retries, idempotency, human-in-the-loop waitpoints, and a per-run trace UI. It has been blocked on credentials ever since, and "durable runs" has sat in every status note as the outstanding item.

Two things have changed since, and both were decided for other reasons.

**[ADR-0006](0006-python-ai-service-node-backend.md) removed the continuation.** The reasoning core is stateless and Node drives it one step at a time, committing each result to Postgres. There is no in-process execution to preserve across a suspension, because the design deliberately does not hold one.

**`20260813120000` put the state machine in the database.** Task states, their legal transitions, the DAG's acyclicity and the append-only `events` log are enforced by triggers, explicitly so that a guard outlives whichever runner is current. `task_runs` already records one row per attempt with `status`, `attempt`, `error` and timestamps, and `agent_run_id` is deliberately `text` rather than `uuid` with a comment saying the id's shape belongs to whichever orchestrator is running.

So the schema was already written in anticipation of this decision.

## Decision

**Run durable work on the Postgres we already have.** No managed orchestrator, and no third-party dependency in the execution path.

- **State** is the `tasks` state machine, as it already is. A run's progress is rows, not a resumable function.
- **Scheduling** is a periodic tick holding a Postgres advisory lock, so only one instance ticks whatever the deploy topology.
- **Crash recovery** is a lease: a `task_runs` row carries `lease_until`, a live worker extends it, and a sweep reclaims anything whose lease has expired.
- **Retries** stay where they are, in the executor, with each attempt its own `task_runs` row.
- **Human waitpoints** need no new primitive. A task in `ESCALATED` or `NEEDS_USER` **is** the waitpoint: it waits in a row, at zero compute, for as long as it takes, and the next tick picks it up when something changes the state.
- **pg-boss** remains available for utility jobs (email, re-index, reconciliation) on the same Postgres, as ADR-0001 already specified for that purpose.

## Rationale

**We would be buying a solution to a problem this design already avoided.** A durable execution engine earns its price by preserving a continuation across a suspension that may last days. This system has no continuation. The one thing it needs to survive a crash is the state, and the state is in Postgres under trigger-enforced invariants.

**It is what the project's own principles already say.** [ADR-0002](0002-stay-in-postgres-pgvector.md) rejected a dedicated vector database on the grounds of transactional consistency, permissioned access, and one system to operate, back up and secure. Every one of those arguments applies here and none of them was made in ADR-0001, which predates the schema it would drive.

**The blocked credential is not a small thing.** A backbone nobody can run is a backbone nobody has tested, and it has held the same item open across three status notes.

**The work is bounded and mostly written.** Retries exist. Per-attempt rows exist. The transition guard exists. What is genuinely new is a lease column, a reclaim sweep and a locked tick.

## Consequences

- **We own the failure modes**, and the one that matters is double execution: a lease expires, the sweep reclaims the task, and the original process turns out to be alive after all. Mitigated by what is already here, since every external side effect carries an idempotency key with a unique constraint behind it, and reclaiming is a conditional update that a still-running worker will lose rather than race.

- **No step-level replay UI.** This is the real loss and it is worth naming plainly rather than dismissing. What replaces it is the `events` log, which already records every transition with the rule that fired, plus the audit-trail explorer that [admin-ops.md](../30-modules/admin-ops.md) has always planned for Phase 3. A console we build reads our own domain; a vendor's shows generic steps.

- **A tick is a heartbeat, not an event stream.** Work starts within one tick interval rather than instantly. Approval already runs a tick inline for exactly this reason, so the interactive path is unaffected and the interval only bounds background progress.

- **Trigger.dev's remaining advantages are real and we are declining them**: managed infrastructure, and waitpoint semantics somebody else has already got right. If run volume or fan-out ever outgrows a single locked ticker, the escape hatch is unchanged and is still Temporal, which ADR-0001 documented and this does not disturb.

- **`agent_run_id` stays `text`.** It now holds an id this system mints. The column was already shaped for a change of orchestrator, and leaving it loose keeps that true a second time.

## Alternatives considered

- **Keep waiting for Trigger.dev credentials.** Rejected: it has blocked Phase 2's exit gate for the length of the project, and the eventual integration would still be a vendor in the execution path for capability the database already provides.

- **Temporal now.** Rejected for the reason ADR-0001 gave, unchanged: gold-standard durability at real operational cost, and a heavier commitment than this workload justifies. It stays the documented escape hatch.

- **pg-boss as the orchestrator rather than only for utility jobs.** Reasonable, and deliberately kept as an option rather than a requirement. It is a queue with retries and cron, which is most of a tick, but the scheduling question here is "which tasks are ready", and `private.tasks_ready` already answers that in SQL. Adding a second definition of ready-ness in a queue's tables is the drift `business-projects-workflow.md` warns about. pg-boss earns its place for work that genuinely is a job (send this email, re-index that source), not for walking the DAG.
