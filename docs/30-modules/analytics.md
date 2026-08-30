# Module: Analytics & Metrics

> Owns product analytics, funnels, unit-economics metrics, and the LLM-specific cost/quality analytics a business-running agent demands. Turns the event-sourced audit stream and LLM traces into decision-grade insight.
>
> **Owner paths:** analytics wiring in `packages/observability` + `apps/web` (dashboards) · **Depends on:** observability (trace/LLM sinks), ai-orchestrator (run metrics), business-projects-workflow (lifecycle events), payments-billing (economics), admin-ops (dashboards).
>
> Update on any change to the tracking plan, metrics, or dashboards. Instrumentation conventions live in [observability.md](../10-architecture/observability.md).

## Responsibilities

Measure whether Octopus actually delivers **growth outcomes** (the marketing wedge), at what cost and quality, where the funnel leaks, and **how fast the [learning flywheel](../10-architecture/learning-flywheel.md) is compounding** — all **without PII in events**.

## Event model & tracking plan

Events for: project lifecycle (created → planned → active → launched), task outcomes (AI-done / escalated / human-done / failed), node matching (offered → accepted → paid), and payouts. Sourced from the event-sourced `events` table + the LLM trace sink; **no PII in analytics events**.

## Funnels

Wedge funnel: `goal → plan approved → campaign live → first result → retained`. North-star funnel (later verticals): `goal → plan → first paid node → business launched`. Drop-off at each stage drives product work.

## Marketing outcomes & flywheel health

- **Growth outcomes:** impressions → clicks → conversions → ROAS/CPA, attributed per campaign/asset (the wedge's north star).
- **Flywheel health:** outcome-labeled data volume, **human-correction rate over time (target: down)**, retrieval-of-real-outcomes coverage, outcome lift (customer N vs customer 1). See [learning-flywheel.md](../10-architecture/learning-flywheel.md).
- **Spend governance:** managed ad spend vs caps, auto-pause events (**produced now**: `campaign.auto_paused` in `events`, with spend/conversions/ceiling/allowance in the payload, per [ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)), budget-reallocation efficacy.

## Unit economics & marketplace metrics

Take-rate, escrow float, node liquidity, match latency, node acceptance rate, dispute rate, CAC/LTV (as data allows).

## LLM analytics

Cost per run/project, token usage, eval scores over time, hallucination/escalation rates — the levers that keep an autonomous agent affordable and trustworthy.

## Retrieval quality

Hit-rate, rerank scores, citation coverage — feeds RAG tuning ([rag.md](../10-architecture/rag.md)).

## SLO / quality dashboards

Regression alerts on eval scores, stale sources, and cost runaway (mirrors [observability.md](../10-architecture/observability.md)).

## Privacy

Privacy-preserving analytics: surrogate IDs, aggregate metrics, no personal data in the event stream (see [security-compliance.md](../10-architecture/security-compliance.md)).

## Key entities

`analytics_events` · `funnels` · `metric_rollups` · `llm_run_metrics` · `retrieval_metrics` · **`campaign_outcomes` · `creative_performance` · `correction_rate_rollups` (flywheel)**.
