# Module: Infrastructure & DevOps

> The **foundation module**: monorepo layout, deployment topology, region co-location, connection pooling, CI/CD, migrations, secrets, and observability wiring. Everything else is built on it, so it is the **first module implemented**.
>
> **Owner paths:** `.github/workflows/**`, `packages/config/**`, `packages/observability/**`, root tooling, `supabase/` config · **Depends on:** foundation for all; provisions auth-identity's Supabase; wires observability.
>
> Update on any change to the monorepo layout, deployment, CI/CD, secrets, or the doc-drift check.
>
> **Implementation status (Phase 0):** scaffolded — Turborepo + pnpm workspaces, `.github/workflows/ci.yml`, and the working `scripts/check-docs.mjs` doc-drift check. See [DEVELOPMENT.md](../../DEVELOPMENT.md).

## Monorepo layout

**Turborepo + pnpm workspaces** with remote caching.

```
apps/
  web       Next.js frontend + thin BFF (Discord-style chat UI)
  api       Fastify authoritative REST API, JWT verify, chat write path, webhooks
  matcher   Fastify marketplace/node-matching + waitpoint completion
  agent     agent runtime (AI SDK loop) executed as Trigger.dev v3 tasks
packages/
  db            Supabase migrations, RLS policies, generated TS types, query layer, pg-boss setup
  contracts     Zod schemas + ts-rest/OpenAPI contract shared by api and web
  core          domain logic (projects, tasks, escrow, room membership)
  rag           chunking, embedding, hybrid pgvector retrieval, ingestion jobs
  agent-tools   Zod-typed agent tools (rag_retrieve, request_human_node, …)
  realtime      chat transport abstraction (Supabase Broadcast now, Fastify WS later)
  ui            shared React components / design system
  observability OpenTelemetry, Sentry, LLM-trace wiring
  config        eslint, tsconfig, env schema (zod-validated), shared constants
supabase/       migrations, RLS policies, seed, edge functions
```

## Deployment topology

- `apps/web` → **Vercel**.
- `apps/api`, `apps/matcher`, agent workers → **Fly.io** (containers).
- Trigger.dev → Cloud first, self-host on Fly.io later.
- Supabase → managed cloud.
- **Region co-location** near the launch cohort to minimize Postgres/Realtime latency.

## Connection pooling

Fastify → Postgres via **Supavisor / PgBouncer transaction pooling** to survive connection storms (serverless + many workers).

## CI/CD

**GitHub Actions** + Turborepo remote cache; review apps per PR; the **`.docmeta.yml` doc-drift check** (fails a PR that touches mapped code without touching its owning doc); RAG **eval gates**; **pgTAP** RLS tests; OpenAPI + ts-rest client regeneration.

## Migrations

Supabase CLI; one concern per migration; RLS policy + pgTAP test land **with** the table. Owned by [data-model.md](../10-architecture/data-model.md).

## Secrets & env

Doppler/Infisical; **Zod-validated env schema** (`packages/config`); no secrets in the repo or client bundle; `service_role` server-only.

## Durable-orchestration deployment

Managed Trigger.dev first; self-host (then Temporal) as the documented escape hatch ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md)).

## Observability wiring

OpenTelemetry, Sentry, LLM-trace sink, Logflare, PostHog, uptime/synthetics — wired centrally in `packages/observability`. Conventions in [observability.md](../10-architecture/observability.md).

## Python AI service ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The AI/RAG layer lives in `services/ai` (Python), alongside the Node workspaces:

- **Layout:** `services/ai` with `pyproject.toml` + **uv** lockfile (kept out of the pnpm workspace graph; Turborepo can shell out to its scripts).
- **CI:** a parallel job — `uv sync`, **ruff** (lint/format), **pytest**, and the **Ragas/DeepEval eval gate** on the RAG golden set (same thresholds as [rag.md](../10-architecture/rag.md)).
- **Deploy:** Fly.io container **co-located with Supabase Postgres** to keep pgvector round-trips cheap.
- **Secrets/config:** same Doppler/Infisical source; `service_role` is server-only; the service never ships to a client.
- **Seam:** FastAPI auto-OpenAPI → a generated typed TS client for the Node side (consistent with [ADR-0004](../40-adr/0004-tsrest-over-trpc.md)).
- **Doc registry:** `.docmeta.yml` maps `services/ai/**` to its owning docs.

**Implemented (Phase 1):** `services/ai` exists with `pyproject.toml` + `uv.lock`, ruff, and pytest. CI runs it as a **parallel `ai` job** (`uv sync --frozen`, `ruff check`, `pytest`) alongside the Node job. The Ragas/DeepEval eval gate is deliberately absent until RAG lands, since there is no golden set to evaluate; it is added in the same change as the corpus. Locally: `uv run --directory services/ai uvicorn octopus_ai.main:app --reload --port 8000` (see [DEVELOPMENT.md](../../DEVELOPMENT.md)).

## Scaling escape hatches (with triggers)

| Escape hatch                                   | Trigger                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Fastify uWebSockets WS gateway + Redis/Upstash | past ~500 concurrent / need server-authoritative ordering ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)) |
| Self-host / Temporal orchestration             | Trigger.dev cost/limits outgrown ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md))                        |
| pgvectorscale / dedicated vector DB            | tens of millions of chunks or high QPS ([ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md))                                  |

## Key entities / artifacts

`packages/config` (env schema) · `packages/db` (migrations, RLS) · `.docmeta.yml` · CI pipelines · deployment configs · secrets.
