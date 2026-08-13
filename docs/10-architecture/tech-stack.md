# Tech Stack (pinned)

> The pinned, versioned inventory of every technology, **why** it was chosen, and which alternatives were rejected (and when to reach for them). Prevents stack drift and re-litigation of settled decisions. **Do not add a datastore/framework/vector DB without an ADR.** Update on any dependency or version change (this doc is a `readme_trigger` in `.docmeta.yml`).

## Pinned versions

| Area              | Package                                                                               | Version (target)                                     | Notes                                                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend          | `next`                                                                                | 15.x (App Router)                                    | RSC, Server Actions, on Vercel                                                                                                                                                                               |
| Frontend          | `react` / `react-dom`                                                                 | 19.x                                                 | —                                                                                                                                                                                                            |
| Auth (client)     | `@supabase/ssr`, `@supabase/supabase-js`                                              | latest 2.x                                           | cookie-based sessions                                                                                                                                                                                        |
| Runtime           | Node.js                                                                               | 22 LTS                                               | services + agent                                                                                                                                                                                             |
| Backend           | `fastify`                                                                             | 5.x                                                  | authoritative API                                                                                                                                                                                            |
| Backend           | `fastify-type-provider-zod`, `@fastify/swagger`, `jose`                               | latest                                               | typed routes, OpenAPI, JWKS verify                                                                                                                                                                           |
| Contracts         | `@ts-rest/core` + `zod`                                                               | latest                                               | shared client/server contract                                                                                                                                                                                |
| DB                | Postgres (Supabase)                                                                   | 16                                                   | RLS, triggers                                                                                                                                                                                                |
| Vector            | `pgvector`                                                                            | 0.8.x                                                | `halfvec`, HNSW, iterative scans                                                                                                                                                                             |
| Orchestration     | Trigger.dev                                                                           | v3                                                   | durable runs + waitpoints                                                                                                                                                                                    |
| Utility jobs      | `pg-boss`                                                                             | latest                                               | on Postgres, no Redis                                                                                                                                                                                        |
| RAG orchestration | LlamaIndex (TS + Python worker)                                                       | latest                                               | ingestion + retrieval                                                                                                                                                                                        |
| Embeddings        | **OpenAI `text-embedding-3-large`** (default) · **BAAI `bge-m3`** (local option)      | request `dimensions: 1024` · bge-m3 is natively 1024 | one model for the whole corpus; selected by `EMBED_PROVIDER` ([ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md), [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md))               |
| Rerank            | **BAAI `bge-reranker-v2-m3`** (in-process, default) · Cohere `rerank-v3.5` (fallback) | —                                                    | cross-encoder over top-25. Local by default per [ADR-0009](../40-adr/0009-local-reranker.md), which amends ADR-0007's rerank pin: measured level with Cohere on the golden set, at ~71s per goal on 12 cores |
| Generation        | **OpenAI** (tiered: strong / fast / cheap)                                            | latest IDs — verify, do not hardcode from memory     | planner/executor/classifier tiering                                                                                                                                                                          |
| AI SDK            | `openai` (Python) in `services/ai`                                                    | latest 1.x                                           | the reasoning loop is Python ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))                                                                                                                  |
| Payments          | Stripe Connect (Express)                                                              | latest API                                           | escrow-equivalent + payouts                                                                                                                                                                                  |
| KYC/IDV           | Persona (or Stripe Identity)                                                          | —                                                    | liveness, Face Match/Search                                                                                                                                                                                  |
| Monorepo          | Turborepo + pnpm                                                                      | latest                                               | remote cache                                                                                                                                                                                                 |
| Observability     | OpenTelemetry, Sentry, LLM-trace sink (Langfuse), PostHog                             | latest                                               | traces, errors, LLM cost/eval, product analytics                                                                                                                                                             |

> **Model IDs and provider pricing change.** Always confirm the current model ID and limits against the provider before pinning in code — never from memory. Version the embedding model name on every `doc_chunks` row so re-embeds are traceable.

## Frontend + BFF

- **Next.js 15** on Vercel: RSC for reads, Route Handlers/Server Actions as a _thin_ BFF that attaches the Supabase access token and proxies to Fastify. **No agent loops, no long jobs** (serverless timeouts). Streams assistant tokens from Realtime.
- **ts-rest client** derived from `packages/contracts` for typed calls to Fastify.

## Backend services

- **Fastify 5** (`apps/api`, `apps/matcher`): JWT verification via `jose` + cached JWKS in a `preHandler` hook; Zod-validated routes; OpenAPI via `@fastify/swagger`. Owns the chat write path and all mutations.

## Data layer

- **Supabase Postgres 16** with **RLS** as the authorization backstop; **Supavisor** transaction pooling; **Storage** (S3-compatible, RLS-scoped buckets, signed URLs); **Realtime** (Broadcast-from-Postgres + Presence).

## Durable orchestration + jobs

- **Trigger.dev v3** for agent runs (long compute, `wait.forToken()` human waitpoints, retries, idempotency, run UI). See [ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md).
- **pg-boss** for utility jobs on the existing Postgres.

## RAG stack

- **pgvector** in-Postgres (`halfvec(1024)`, HNSW cosine, iterative scans) — [ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md).
- **BAAI `bge-m3`** embeddings at 1024 dims (or OpenAI `text-embedding-3-large` at the same width), in-process **`bge-reranker-v2-m3`** rerank, Postgres FTS (`tsvector`/GIN) for sparse, RRF fusion. Both model steps run locally, so retrieval depends on no paid provider. See [ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md) as amended by [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md) and [ADR-0009](../40-adr/0009-local-reranker.md).
- **Optional local embedder: BAAI `bge-m3`** in-process via FlagEmbedding, selected with `EMBED_PROVIDER=local` ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)). Natively 1024-dim, so `halfvec(1024)` and the HNSW index are unchanged. torch ships as the optional `local-embed` extra, never as a base dependency. The two vector spaces are **not** interchangeable: switching re-embeds the whole corpus, which the ingestion content hash enforces.
- **LlamaIndex** for ingestion + query transformation; **LlamaParse / Unstructured / Docling** for layout-aware parsing/OCR.
- Full spec: [rag.md](rag.md).

## AI SDKs & model tiering

- The **`openai` Python SDK** in `services/ai` for the plan-then-act loop. The loop is Python because the reasoning core is ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)); Node drives it per step and executes the side effects.
- **Model tiering:** a stronger model for planning/critic, a faster model for executor steps, a cheap model for classification/routing. Configured centrally; never hardcode a single model.

## Observability

- **OpenTelemetry** traces across web/api/matcher/agent; **Sentry** errors (with source maps); **Langfuse** (or equivalent) for per-run LLM prompt/response/token/cost + online eval; **PostHog** product analytics; uptime/synthetics on chat + agent-start paths. See [observability.md](observability.md).

## Python AI service ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The AI/RAG layer is a separate **Python** service; the rest of the backend is Node/Fastify. Pinned Python tooling:

| Area                      | Choice                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| Web framework             | **FastAPI** + **Pydantic v2** (auto-OpenAPI → typed TS client)                            |
| Runtime / packaging       | Python 3.12, **uv** (lockfile + venv)                                                     |
| RAG orchestration         | **LlamaIndex** (Python)                                                                   |
| Parsing / OCR             | LlamaParse / Unstructured / Docling                                                       |
| Embeddings / rerank / gen | OpenAI · Cohere SDKs (managed); `sentence-transformers` / `FlagEmbedding` if self-hosting |
| Eval                      | **Ragas** + **DeepEval** (CI gate)                                                        |
| Lint / format / test      | **ruff** + **pytest**                                                                     |
| DB access                 | psycopg / SQLAlchemy over the same Supabase Postgres (`service_role`, server-side only)   |
| Deploy                    | Fly.io container, co-located with Postgres                                                |

Seam: OpenAPI-typed HTTP + shared Postgres + job queue for ingestion. Node owns durability (Trigger.dev) and all side-effecting tools. See [architecture.md](architecture.md) and [ai-orchestrator.md](../30-modules/ai-orchestrator.md).

## Rejected alternatives (with rationale)

| Rejected                                  | Instead of                            | Why / when to revisit                                                                                                                                          |
| ----------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tRPC**                                  | ts-rest + OpenAPI                     | We need a language-agnostic OpenAPI contract (webhooks, future non-TS consumers, external docs). ([ADR-0004](../40-adr/0004-tsrest-over-trpc.md))              |
| **Postgres Changes**                      | Broadcast-from-Postgres               | WAL-per-subscriber fans out poorly and can leak columns. ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md))                               |
| **Dedicated vector DB** (Pinecone/Qdrant) | pgvector in Postgres                  | Loses transactional consistency + RLS-for-free; only earns its keep past tens of millions of chunks. ([ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md)) |
| **BullMQ / Redis at MVP**                 | pg-boss                               | Avoids standing up Redis; reach for BullMQ only once Redis exists for other reasons.                                                                           |
| **Temporal at MVP**                       | Trigger.dev v3                        | Gold-standard durability at real operational cost; documented escape hatch. ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md))          |
| **Default shadcn + Inter + zinc**         | custom "Ink & Bioluminescence" tokens | Reads as generic AI slop; we diverge deliberately. ([ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md))                                             |
| **Vercel Workflows**                      | Trigger.dev                           | Ties orchestration to Vercel, away from the Fastify/Supabase core.                                                                                             |

## Dependency & upgrade policy

- Every new dependency is a maintenance liability — justify it, prefer the stack you have.
- Renovate/Dependabot for patches; majors get an ADR if they change behavior.
- Version-bump checklist: run eval gates (RAG), run pgTAP RLS tests, check bundle size (web), re-generate OpenAPI + ts-rest client, update this doc.
