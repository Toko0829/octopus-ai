# Observability

> How the whole system is traced, logged, measured, and evaluated — including the LLM-specific observability a non-deterministic, business-running agent demands. Update when instrumentation conventions, the trace-correlation model, or SLOs change. Owner of `packages/observability/**` wiring alongside [infra-devops.md](../30-modules/infra-devops.md).

## Principle: no silent failures

Every service and every agent step is instrumented. A failure that isn't traced, logged, or alerted is a bug. Fallbacks that swallow errors are prohibited (see [AGENTS.md](../../AGENTS.md) rule 16).

## Trace correlation model

- Two IDs thread through everything: **`projectId`** (the venture) and **`agentRunId`** (the durable run).
- They propagate across `apps/web` → `apps/api` → `apps/matcher` → `apps/agent`, into each durable run, each LLM call, and each Sentry event.
- Any log line, span, LLM trace, or error can be pivoted back to the exact project + run + step.

## OpenTelemetry

- Standard OTel instrumentation across web/api/matcher/agent (HTTP, DB, queue spans).
- Span attributes always include `projectId`, `agentRunId`, `taskId` (when applicable), `userId`/`nodeId` (non-PII surrogate), and `tool` for tool spans.
- Exporters to the chosen backend (e.g. Grafana Tempo / Honeycomb / vendor).

## Error tracking

- **Sentry** across all runtimes with source maps; release tagging; alerting on new/regressed issues.
- Durable-run failures surface in Sentry and in the append-only **`events` log**, which records every transition with the rule that fired. **There is no step-level replay UI**: [ADR-0010](../40-adr/0010-postgres-durable-runner.md) declined one knowingly and named the audit-trail explorer in [admin-ops.md](../30-modules/admin-ops.md) as its Phase 3 replacement.

## LLM observability

The differentiator for an agent that runs businesses:

- **Per run/step:** prompt, response, model, token counts, **cost**, latency, tool calls, confidence.
- **Prompt versioning** so a regression can be tied to a prompt change.
- **Online eval:** faithfulness/relevancy scoring on sampled production traffic; thumbs-up/down captured from the group chat feed back as labels.
- Single sink (**Langfuse** or equivalent) that both Ragas (offline) and DeepEval (CI) publish to — see [rag.md](rag.md).

## Data-layer & platform logs

- Supabase/Postgres logs (Logflare): slow queries, **RLS denials** (a spike signals a bug or an attack), connection-pool saturation.
- Realtime metrics: concurrent connections (watch the ~500 ceiling), broadcast rate, presence churn.
- **Broadcast delivery is a blind spot by default and needs its own signal.** `realtime.send()` traps its own exceptions, so when a broadcast fails the message still commits and the client still gets `201` — the write path looks perfectly healthy while nothing is delivered. This is not hypothetical: it happened on this project, where `realtime.messages` had no partitions until the Realtime service cold-started, and subscribers saw `MissingPartition` while writes kept succeeding. Alert on broadcast rate diverging from message-insert rate rather than on write errors, and treat `MissingPartition` in Realtime logs as an incident.
- Auth logs: sign-in anomalies, JWKS refresh.

## Product analytics

- **PostHog** for funnels and behavior (goal → plan → first paid node → business launched) — **no PII in events**.
- Feeds [analytics.md](../30-modules/analytics.md) dashboards.

## Uptime & synthetics

- Uptime/synthetic checks on the two paths that must never be down: **posting a chat message** and **starting an agent run**.

## SLOs & alerting

| Signal                         | Alert when                                                  |
| ------------------------------ | ----------------------------------------------------------- |
| Chat write availability        | error rate > 0.5% or p95 latency regression                 |
| Chat broadcast delivery        | writes committing without a matching broadcast (see below)  |
| Agent-start success            | `202` path failing / runs not starting                      |
| Parse-failure rate (ingestion) | sudden spike (source format changed)                        |
| Stale sources                  | any high-stakes source past its freshness SLA               |
| Eval scores                    | any gate metric regresses below threshold                   |
| LLM cost                       | per-run or daily cost runaway vs baseline                   |
| RLS denials                    | unexpected spike                                            |
| Waitpoints                     | age exceeds expiry (stuck runs)                             |
| Escrow                         | held funds without a matching ledger entry (reconciliation) |

## Dashboards & on-call

- **Run explorer:** per-project timeline of steps, tool calls, escalations, approvals, payouts (from the event-sourced `events` table).
- **LLM cost/quality:** cost per run/project, token usage, eval scores over time, hallucination/escalation rates.
- **Retrieval quality:** hit-rate, rerank scores, citation coverage.
- **Marketplace health:** match latency, node liquidity, dispute rate, escrow float.
- On-call routing and playbooks live in [`docs/50-runbooks/`](../50-runbooks/).
