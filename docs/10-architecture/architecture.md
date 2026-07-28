# System Architecture

> The authoritative description of how the two-layer brain, the services, the durable orchestration, and Postgres-as-source-of-truth fit together. Read this before touching cross-service behavior. Update it when the topology, service boundaries, or the sync/async contract changes.
>
> **Implementation status (Phase 1):** the **chat write path is live**. `apps/api` implements `POST /api/rooms/:roomId/messages` (JWKS `preHandler` → RLS membership → `INSERT` → Postgres trigger broadcasts) and `GET /api/rooms/:roomId/messages` (since-cursor catch-up), both typed from `packages/contracts`. Verified end-to-end against Supabase: 24 assertions covering auth, idempotent replay, RLS refusal for non-members, and confirmed Realtime delivery to a live subscriber. `apps/web` consumes the API for real: Server Components read through `lib/api-server.ts`, the browser goes through the thin BFF at `/api/bff/*`, and there is **no mock data left in the app**. Also live: `GET /api/rooms`, `POST /api/rooms`, `GET /api/rooms/:roomId/channels`, `GET /api/rooms/:roomId/members`. The **Node-to-Python seam is live**: `POST /api/rooms/:roomId/agent-runs` returns `202 + runId`, calls `services/ai` for proposals, and executes them by posting to chat as the agent. Not yet wired: `fastify-type-provider-zod` + `@fastify/swagger` (routes validate with the contract's Zod schemas directly, so there is still one source of truth, but the OpenAPI document is not generated yet), TS client generation from the Python service's OpenAPI (`apps/api/src/lib/ai.ts` is hand-maintained meanwhile), and durability for agent runs. See [DEVELOPMENT.md](../../DEVELOPMENT.md).

## System topology

```
                        ┌───────────────────────────────────────────────┐
   Browser  ── HTTPS ──▶ │ apps/web  (Next.js 15, Vercel)                 │
   (chat UI)            │  RSC + thin BFF · holds Supabase session cookie │
                        │  reads/aggregates · PROXIES mutations           │
                        └───────┬───────────────────────────▲────────────┘
                                │ ts-rest (JWT)             │ Realtime (Broadcast + Presence)
                                ▼                           │
        ┌───────────────────────────────────┐              │
        │ apps/api  (Fastify 5, Fly.io)      │              │
        │  JWKS verify · chat WRITE path     │              │
        │  project/task CRUD · webhooks      │              │
        └───┬─────────────┬──────────────┬───┘              │
            │             │              │                  │
   trigger  │      service_role          │ triggers run     │
   run      ▼             ▼              ▼                  │
   ┌────────────────┐ ┌──────────────┐ ┌───────────────────┴───────────────┐
   │ apps/matcher    │ │ Supabase     │ │ Supabase Postgres 16 (source of    │
   │ (Fastify)       │ │ Auth (GoTrue)│ │ truth): users, rooms, messages,    │
   │ node matching + │ │ JWKS         │ │ projects, tasks, ledger, escrow,   │
   │ waitpoint close │ └──────────────┘ │ documents+doc_chunks (pgvector)    │
   └───────┬─────────┘                  │ RLS · triggers → realtime.broadcast│
           │                            └───────────────▲───────────────────┘
           │ complete waitpoint                          │ INSERT rows (AI as member)
           ▼                                             │
   ┌───────────────────────────────┐          ┌──────────┴───────────────┐
   │ Trigger.dev v3 (durable)      │─────────▶│ apps/agent (Node)         │
   │ waitpoints · retries · run UI │◀─────────│ durable steps · TOOLS     │
   └───────────────────────────────┘          └──────────┬───────────────┘
                                                         │ OpenAPI HTTP
                                                         ▼
                                              ┌──────────────────────────┐
                                              │ services/ai (Python)      │
                                              │ RAG · reasoning · eval    │
                                              │ PROPOSES, never writes    │
                                              └──────────────────────────┘
   pg-boss (utility jobs) · Stripe Connect (escrow/payouts) · Storage (artifacts)
```

Region co-location: Supabase + Fly.io services are co-located in the region nearest the launch cohort to keep Postgres round-trips and Realtime latency low.

## Service map

| Service        | Tech                                                                                     | Responsibility                                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`     | Next.js 15 App Router (Vercel), `@supabase/ssr`, RSC, ts-rest client                     | Discord-style UI; holds the session cookie; light read-aggregation; **proxies all mutations/long work to Fastify**; streams assistant tokens from Realtime. Never runs agent loops.                                                |
| `apps/api`     | Node 22 + Fastify 5 (Fly.io), jose/JWKS, `fastify-type-provider-zod`, `@fastify/swagger` | Authoritative REST API. Verifies JWTs; owns the chat **write** path; project/task CRUD; triggers agent runs; hosts webhooks (Stripe, Trigger.dev, IDV).                                                                            |
| `apps/matcher` | Fastify (may start as a module of `api`), `service_role`, geo + skill/rating filters     | Finds eligible nodes for a human task, notifies, manages accept/decline, adds the accepted node to the room (RLS membership), and **completes the agent's waitpoint** on verification.                                             |
| `apps/agent`   | Node 22, executed **as Trigger.dev tasks**, Zod-typed tools                              | Drives the run: calls `services/ai` for each reasoning step, then **executes the side effects** it proposes — persists plan/tasks/artifacts, posts to chat, `request_human_node`. Authz and spend caps live here, in tool code.    |
| `services/ai`  | **Python** (FastAPI + Pydantic, LlamaIndex), OpenAPI-typed seam, stateless               | The reasoning core and RAG: retrieval, planning, drafting, tool **selection**, eval gates, provider calls. **Proposes only** — it never writes rows or moves money. ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) |
| Trigger.dev v3 | Managed (Trigger Cloud) or self-host on Fly.io                                           | Durable orchestration: long-run compute, waitpoints, retries, idempotency, per-run trace UI.                                                                                                                                       |
| pg-boss        | On Supabase Postgres                                                                     | Utility jobs (email, thumbnails, RAG re-index, reconciliation) — no Redis at MVP.                                                                                                                                                  |
| Supabase       | Postgres 16 + RLS, GoTrue (JWKS), Storage, Realtime                                      | Single source of truth + auth + storage + chat transport.                                                                                                                                                                          |

## The two-layer brain

1. **Durable execution backbone** (Trigger.dev v3) — survives crashes/deploys, retries steps, and _sleeps for days_ on human waitpoints at zero compute cost. It owns _when_ work runs and guarantees replay-safety.
2. **Supervisor / orchestrator reasoning core** (`services/ai`, Python) — decides _what_ to do: plans the task DAG, routes tasks (AI/HUMAN/USER), selects tools, and runs a maker-checker critic. Read-only sub-agents are spawned as tools; they never write the DAG. It **proposes**; `apps/agent` (Node) commits the result and performs every side effect.

Separation matters: the reasoning core can be non-deterministic and fallible; the backbone makes the _system_ deterministic, resumable, and auditable around it. The language split reinforces it — a jailbroken prompt in the Python core still cannot move money, because money only exists behind Node tool code and Postgres.

## Language split — Python AI service ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The AI/RAG layer is a **separate Python service** (`services/ai`, FastAPI); the rest of the backend stays Node/Fastify.

- **Python (`services/ai`)** owns RAG (ingestion + retrieval + rerank), the agent **reasoning core** (planning, drafting, tool selection), evaluation (Ragas/DeepEval), provider calls (OpenAI for generation + embeddings, Cohere for rerank — [ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)), and future self-hosted/trained models. Stateless behind an OpenAPI-typed HTTP seam; ingestion/eval run as jobs; shares the same Supabase Postgres (`service_role`, server-side only).
- **Node/Fastify** owns chat, realtime, auth, projects/tasks, marketplace, payments, notifications, the **durable backbone** (Trigger.dev) that drives the Python core, and **all side-effecting tools** (`post_message`, escrow, `request_human_node`) — which must run in the Postgres/RLS/Stripe world with authz in tool code.
- **Rule: Python proposes, Node executes.** The Python core decides _what_ to do; Node performs the side effects with guardrails. A jailbroken prompt in Python still cannot move money. This maps directly onto the two-layer brain (reasoning core = Python, durable backbone + execution = Node).

## Postgres as the single source of truth

- Chat, projects, tasks, ledger, escrow, and embeddings all live in one Postgres. There is no second store to keep in sync.
- **The AI participates by `INSERT`ing rows** (messages, tasks, artifacts) exactly like a human member — there is no privileged side channel. This keeps RLS and audit uniform.
- Triggers turn state changes into realtime broadcasts and event-sourced audit records.

## Realtime transport

- **Broadcast-from-Postgres + Presence.** Messages are `POST`ed to Fastify → inserted (moderation/ordering/AI fan-out hook) → a Postgres trigger calls `realtime.broadcast_changes()` to topic `chat:room:{id}`.
- We deliberately **avoid Postgres Changes** (WAL-per-subscriber, poor fan-out, column leakage). See [ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md).
- A `packages/realtime` abstraction (write-via-Fastify, subscribe-to-topic) makes a future swap to a Fastify uWebSockets + Redis/Upstash gateway **non-breaking**, triggered past the ~500-concurrent soft ceiling.
- Late joiners / reconnects fetch history via a **since-cursor** REST call — live subscription is not a substitute for durable catch-up.

## Acting as the caller, not as `service_role`

Request-scoped routes reach Postgres through a client built from the **publishable** key plus **the caller's own access token**, so `auth.uid()` resolves inside RLS policies and every statement is membership-filtered by the database. Fastify's checks and RLS must _both_ fail before anything leaks. The secret key bypasses RLS entirely and is reserved for trusted writes with no user context (agent/system messages, the matcher inserting a node into `room_members`); it is never used to serve a user request. See `apps/api/src/lib/supabase.ts`.

Two corollaries that are easy to get wrong:

- **RLS is not a grant.** A policy filters rows the role is already permitted to touch. A table with perfect policies and no `GRANT` is simply unreachable — the failure is `permission denied`, not an empty result. Every migration must issue both.
- **Trust the database for membership.** Routes do not re-implement membership; they let the policy decide and translate the outcome. A non-member gets `404` (the room is invisible to them, and the API does not confirm it exists) rather than `403`.

## Synchronous vs asynchronous boundary

- **Synchronous (request thread):** verify JWT, persist a message, start a run. That's it.
- **Asynchronous (durable tasks):** all agent work, human waitpoints, payouts. Long operations return `202 + runId`; the client follows progress via Realtime.
- Rule: **Next.js and Realtime never do heavy or long work.**

## Cross-cutting concerns

- **Idempotency:** every external side effect carries an idempotency key (durable activity + DB unique constraint) so replays never double-register, double-notify, or double-pay.
- **Event-sourcing:** every plan diff, tool call, escalation, approval, and payout is immutable — for audit, liability, and disputes.
- **Trace correlation:** `projectId` + `agentRunId` thread through web/api/matcher/agent, each LLM call (LLM-trace sink), and Sentry. See [observability.md](observability.md).
- **Connection pooling:** Fastify talks to Postgres through Supavisor/PgBouncer transaction pooling to survive connection storms.

## Canonical data flow

The 10-step "open a cafe" trace lives in [core-loop.md](../00-overview/core-loop.md) and is the reference for all service interactions.

## Failure modes (designed-for)

| Failure                          | Handling                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Crash/deploy mid-run             | Durable replay from last completed step; idempotency prevents duplicates. |
| Human waitpoint never completed  | Expiry → escalate to ops; never hang.                                     |
| Node no-show / offer decline     | Auto-cascade to next ranked node.                                         |
| Connection exhaustion            | Supavisor transaction pooling; backpressure.                              |
| Realtime overload                | Broadcast abstraction + since-cursor catch-up; WS-gateway migration path. |
| Poison message / bad tool output | Layered guardrails; quarantine; kill switch.                              |

## Open scaling questions & documented escape hatches

- **Realtime ceiling** → Fastify uWebSockets + Redis/Upstash gateway ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)).
- **Durable orchestration outgrown** → self-host Trigger.dev, then **Temporal** ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md)).
- **Vector scale** (tens of millions of chunks / high QPS) → pgvectorscale (StreamingDiskANN) in-Postgres first, dedicated store (Qdrant) only if forced ([ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md)).

Each is deliberately deferred; triggers are recorded in [infra-devops.md](../30-modules/infra-devops.md) and [roadmap.md](roadmap.md).
