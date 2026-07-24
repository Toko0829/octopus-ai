# ADR-0001 — Durable orchestration: Trigger.dev v3 baseline, Temporal as escape hatch

- **Status:** Accepted
- **Date:** Phase 0
- **Context doc:** [architecture.md](../10-architecture/architecture.md), [ai-orchestrator.md](../30-modules/ai-orchestrator.md)

## Context

Agent runs are long, multi-step, human-observable, and must **pause for days** awaiting a human node. We need durable execution (survive crashes/deploys), retries, idempotency, human-in-the-loop waitpoints, and per-run observability — without building it ourselves.

## Decision

Use **Trigger.dev v3** as the durable orchestration backbone. Agent runs execute as Trigger.dev tasks; human hand-offs use `wait.forToken()` waitpoints (zero compute while suspended). Use **pg-boss** on the existing Postgres for lightweight utility jobs (email, thumbnails, RAG re-index, reconciliation) to avoid standing up Redis at MVP.

## Alternatives considered

- **Temporal** — the gold standard for durable execution; rejected *for now* due to real operational cost. It is the **documented escape hatch** if Trigger.dev is outgrown.
- **Inngest** — strong event-driven `step.waitForEvent` human gates; a fine substitute; kept as a backup option.
- **BullMQ** — needs Redis + self-managed workers + you build observability/human-gates yourself. Reach for it only once Redis exists for other reasons.
- **Vercel Workflows** — ties orchestration to Vercel, away from the Fastify/Supabase core.

## Consequences

- Runs are resumable and observable out of the box; the human-waitpoint pattern is first-class.
- We take a managed-vendor dependency for orchestration (mitigated: self-host path exists).
- Migration trigger to self-host / Temporal is recorded in [infra-devops.md](../30-modules/infra-devops.md).
