# Tech Stack (pinned)

> The pinned, versioned inventory of every technology, **why** it was chosen, and which alternatives were rejected (and when to reach for them). Prevents stack drift and re-litigation of settled decisions. **Do not add a datastore/framework/vector DB without an ADR.** Update on any dependency or version change (this doc is a `readme_trigger` in `.docmeta.yml`).

## Pinned versions

| Area | Package | Version (target) | Notes |
|---|---|---|---|
| Frontend | `next` | 15.x (App Router) | RSC, Server Actions, on Vercel |
| Frontend | `react` / `react-dom` | 19.x | — |
| Auth (client) | `@supabase/ssr`, `@supabase/supabase-js` | latest 2.x | cookie-based sessions |
| Runtime | Node.js | 22 LTS | services + agent |
| Backend | `fastify` | 5.x | authoritative API |
| Backend | `fastify-type-provider-zod`, `@fastify/swagger`, `jose` | latest | typed routes, OpenAPI, JWKS verify |
| Contracts | `@ts-rest/core` + `zod` | latest | shared client/server contract |
| DB | Postgres (Supabase) | 16 | RLS, triggers |
| Vector | `pgvector` | 0.8.x | `halfvec`, HNSW, iterative scans |
| Orchestration | Trigger.dev | v3 | durable runs + waitpoints |
| Utility jobs | `pg-boss` | latest | on Postgres, no Redis |
| RAG orchestration | LlamaIndex (TS + Python worker) | latest | ingestion + retrieval |
| Embeddings | Voyage `voyage-3-large` | 1024-dim (Matryoshka) | one model for the whole corpus |
| Rerank | Cohere `rerank-3.5` | — | cross-encoder over top-40 |
| Generation | Anthropic Claude (Opus/Sonnet/Haiku tiers) | latest IDs — verify, do not hardcode from memory | planner/executor/classifier tiering |
| AI SDK | Vercel AI SDK v5 (or Anthropic SDK) | 5.x | tools, `stopWhen`, streaming |
| Payments | Stripe Connect (Express) | latest API | escrow-equivalent + payouts |
| KYC/IDV | Persona (or Stripe Identity) | — | liveness, Face Match/Search |
| Monorepo | Turborepo + pnpm | latest | remote cache |
| Observability | OpenTelemetry, Sentry, LLM-trace sink (Langfuse), PostHog | latest | traces, errors, LLM cost/eval, product analytics |

> **Model IDs and provider pricing change.** Always confirm the current Claude model ID and limits against the provider before pinning in code — never from memory. Version the embedding model name on every `doc_chunks` row so re-embeds are traceable.

## Frontend + BFF

- **Next.js 15** on Vercel: RSC for reads, Route Handlers/Server Actions as a *thin* BFF that attaches the Supabase access token and proxies to Fastify. **No agent loops, no long jobs** (serverless timeouts). Streams assistant tokens from Realtime.
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
- **Voyage-3-large** embeddings (multilingual, Matryoshka-truncatable), **Cohere Rerank 3.5**, Postgres FTS (`tsvector`/GIN) for sparse, RRF fusion.
- **LlamaIndex** for ingestion + query transformation; **LlamaParse / Unstructured / Docling** for layout-aware parsing/OCR.
- Full spec: [rag.md](rag.md).

## AI SDKs & model tiering

- **Vercel AI SDK v5** or **Anthropic SDK** for the plan-then-act loop.
- **Model tiering:** a stronger model for planning/critic, a faster model for executor steps, a cheap model for classification/routing. Configured centrally; never hardcode a single model.

## Observability

- **OpenTelemetry** traces across web/api/matcher/agent; **Sentry** errors (with source maps); **Langfuse** (or equivalent) for per-run LLM prompt/response/token/cost + online eval; **PostHog** product analytics; uptime/synthetics on chat + agent-start paths. See [observability.md](observability.md).

## Rejected alternatives (with rationale)

| Rejected | Instead of | Why / when to revisit |
|---|---|---|
| **tRPC** | ts-rest + OpenAPI | We need a language-agnostic OpenAPI contract (webhooks, future non-TS consumers, external docs). ([ADR-0004](../40-adr/0004-tsrest-over-trpc.md)) |
| **Postgres Changes** | Broadcast-from-Postgres | WAL-per-subscriber fans out poorly and can leak columns. ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)) |
| **Dedicated vector DB** (Pinecone/Qdrant) | pgvector in Postgres | Loses transactional consistency + RLS-for-free; only earns its keep past tens of millions of chunks. ([ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md)) |
| **BullMQ / Redis at MVP** | pg-boss | Avoids standing up Redis; reach for BullMQ only once Redis exists for other reasons. |
| **Temporal at MVP** | Trigger.dev v3 | Gold-standard durability at real operational cost; documented escape hatch. ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md)) |
| **Default shadcn + Inter + zinc** | custom "Ink & Bioluminescence" tokens | Reads as generic AI slop; we diverge deliberately. ([ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md)) |
| **Vercel Workflows** | Trigger.dev | Ties orchestration to Vercel, away from the Fastify/Supabase core. |

## Dependency & upgrade policy

- Every new dependency is a maintenance liability — justify it, prefer the stack you have.
- Renovate/Dependabot for patches; majors get an ADR if they change behavior.
- Version-bump checklist: run eval gates (RAG), run pgTAP RLS tests, check bundle size (web), re-generate OpenAPI + ts-rest client, update this doc.
