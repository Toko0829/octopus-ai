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

### A room can carry more than one project, and for a while it could not

`rooms.project_id` is written once, by `materialise_plan`, under `where ... and project_id is null`. So the **first** project approved in a room claims it permanently, and every plan approved in that room afterwards created a project that was never linked to anywhere.

That mattered because delivery resolved the room by asking `rooms` which project it belonged to. Measured on the live database rather than reasoned about: a real run produced **8 approved tasks and 8 stored artifacts, none of which reached the chat**, while the room still pointed at a project from nine days earlier. The lookup found no room and returned early, so the person saw "Plan approved" and then nothing at all, with no error anywhere. Rule 16's silent failure producing the exact "plans visibly, delivers invisibly" symptom the artifact card was built to end.

`roomForProject` now resolves through `projects.source_embed_id` to the card's `room_id`. That link is unique, set at creation, and never changes: a project came from exactly one card, posted in exactly one room. `rooms.project_id` keeps its meaning as "the project this room is currently about", which is fine for a UI to read and is simply not the delivery path, because it answers a question that changes and this one does not. Both call sites, the artifact announcement and the waiting digest, now log loudly when no room resolves instead of returning quietly.

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

## Structured plans across the seam

The reasoning core can now return a **plan** as well as prose. `packages/contracts` owns the wire shape (`PlanEmbedPayload`, six fixed `FunnelStage` values, `StepOwner`, `TaskRiskTier`), so Python, Fastify and the browser all derive from one definition. `TaskRiskTier` lives here rather than in `packages/core` because it crosses the wire: the tier is an input to an authorisation decision, and the router imports the same definition the card is rendered from.

Four properties this path depends on:

- **Proposals are a discriminated union.** An unknown `kind` fails the parse rather than being skipped, so a core that invents a proposal kind breaks the run instead of quietly doing nothing.
- **The payload is validated before it is stored, not on the way out.** Node parses the plan against the contract and refuses to write one that fails. Storing an invalid payload would move the failure to every future read and into the browser, where it is much harder to attribute.
- **The two casings are mapped field by field, never spread.** The core speaks snake_case and the contract speaks camelCase. For most fields that is cosmetic; for `risk_tier` it is not, because `riskTier` carries a default, so spreading the core's step would drop the tier, parse cleanly, and land every step on `reversible` with nothing raising anywhere. That is the same outcome the tier exists to prevent, reached through the mapping instead of through the planner, so `planEmbedPayload` in `apps/api/src/routes/agent-runs.ts` is pure, exported, and pinned by tests.
- **A plan writes two rows: the message and its embed.** The message body carries the plan in plain text, so it stays legible in a notification, in the audit trail, or in any client that does not know this embed type. The card is an enhancement of a readable message, never the only way to read it. The insert is keyed by the same deterministic idempotency key, so a replayed run posts neither twice.

`GET /api/rooms/:roomId/messages` returns each message with its embed joined, so the stream and its cards arrive together and cannot render out of step. Realtime is the exception: the trigger broadcasts the `messages` row and cannot see `action_embeds`, so a card materialises on the next fetch.

## Intake runs before retrieval, and the card carries its state

An agent run no longer goes straight to `/plan`. It calls `POST /intake` first, and that call decides whether this turn plans or asks. Details of the scoring are in [ai-orchestrator.md](../30-modules/ai-orchestrator.md); what belongs here is the seam.

**A goal and an answer are the same event on the wire.** Both arrive as a chat message that starts an agent run, and only the room's state tells them apart. Reading a fresh goal as an answer buries it inside a stale intake; reading an answer as a goal throws away what the person just said and asks again. `decideIntakeTurn` in `@octopus/core` makes that call, with no IO, so the rule is checkable without a database.

**The question card is where the intake's state lives.** The AI service is stateless by design (ADR-0006), so something on this side has to carry the slots between rounds, and an `action_embeds` row is already written, already RLS-scoped to the room, and already visible to the person whose answers it holds. A new table would have been a second place for the same facts. It also means the state and the questions it produced cannot disagree, because they are one row.

Four properties this path depends on:

- **Only the room's owner answers.** Intake answers describe the person's own budget, customers and timeline, and a human node sitting in the room must not be able to state them. `required_role` on the embed cannot enforce this, because an answer arrives as a chat message and never reaches the action route where that role is checked, so the check lives in the run. A message from anyone else is treated as a new goal, which is what it would have been without an intake in flight.
- **The card is consumed with a conditional update**, `eq('state','pending')` in the same statement, so two runs racing on one answer cannot both proceed. Same guard the approve path uses.
- **It is consumed after the intake call, not before.** Marking first would mean a failed or timed-out intake silently swallows what the person typed. This way the card stays pending and the next message tries again.
- **Intake failing plans anyway.** Any error falls through to planning on the original message, which is the behaviour that existed before intake. It improves a query; it is not a precondition for answering. Nothing is granted by passing through, because the groundedness gate still runs inside `/plan`.

`answered` was added to `embed_state` rather than reusing `approved`. The four original states describe a verdict and a question has none, so recording an answered question as approved would put an untrue sentence in the audit trail and hand `feedback_events` a labelled example of a person approving something they were never shown.

**Acting on a card is now an allow-list.** `approve` means "materialise this plan into a project", and the action route is reached by embed id alone, so a component check refuses anything that is not a plan before `materialise_plan` is handed a payload written for a different shape.

## Acting on an embed

`POST /api/rooms/:roomId/embeds/:embedId/actions` records a verdict on a card. Four checks, in order, none of which the client can answer for itself:

1. **Membership**, evaluated by RLS as the caller. A non-member gets `404`, not `403`: the room is invisible to them and the API does not confirm it exists.
2. **`required_role`**, re-checked server-side. An unknown role **denies** rather than defaulting to permitted, so adding a role later cannot accidentally open an action before its check is written.
3. **State**, so an embed is single-use. Approving twice is two approvals, which matters little for a plan and a great deal for Pay and Sign, so the guard is here now rather than added when money arrives.
4. **A conditional update** (`eq('state','pending')` in the same statement). Reading the state and then writing it is a race; doing both at once is not.

The verdict is then written to `feedback_events` (flywheel v0) and posted into the room as a system message, because the chat is the audit trail and a state change nobody can see is not one anyone can dispute. If the flywheel write fails the decision still stands and the failure is logged loudly: losing a label must not un-approve a plan.

## Approving a plan is what creates the work

An approval calls `public.materialise_plan(embedId)`, which creates a `projects` row and one `tasks` row per step, and links the room to the project. Four properties, and the first two are the reason it is a database function rather than a sequence of calls from Node.

- **All of it, or none of it.** supabase-js speaks PostgREST, one statement per call, so it has no transactions. A project created without its tasks is a project the scheduler would call finished. One function is one transaction.
- **What was approved is what gets built.** The function reads the payload out of `action_embeds` itself rather than accepting a task list from the route. Passing the steps in would mean the rows materialised are whatever the caller says they are, and the entire point of the card is that a person read a specific plan and agreed to _it_.
- **Idempotent per card.** `projects.source_embed_id` is unique, and a repeat call returns the project it already built. That is what makes the ordering safe: materialising happens **after** the verdict is recorded, so if it fails the decision still stands and a retry cannot produce a second project. Rolling the approval back instead would silently undo a person's decision because of an error they never saw.
- **The wire's owner becomes the row's owner.** `AI` / `HUMAN` / `YOU` map to `ai` / `human` / `user`, and an unrecognised value **raises** rather than defaulting. Defaulting would quietly route a task meant for a person to the AI, which is the one direction this mapping must never fail in.

**No `task_deps` are written.** The planner returns stages and steps, not dependencies, and inferring "strategy before content" from stage order would invent a constraint nobody stated. An invented edge is worse than a missing one: a missing edge lets things run in parallel that perhaps should not, while an invented one blocks work for a reason that does not exist and cannot be traced to anything.

`PlanEmbedPayload` gained `goal` for this, carrying the request in the person's own words. It also repairs the flywheel label, since `feedback_events.subject` stores this payload and an output with no input is not a training pair.

**One scheduler tick runs immediately after**, so the person who just approved something sees where each step went rather than watching rows sit `PENDING` until some future trigger fires. It is not fatal: the approval and the project both stand whatever the tick does, and the next tick finds the same tasks. The decisions live in `@octopus/core` with no database access at all; `apps/api/src/lib/scheduler.ts` is the adapter that gives them one. See [business-projects-workflow.md](../30-modules/business-projects-workflow.md) for the router's rules and for the one place the tick deliberately stops short.

## Timeouts across the Node/Python seam

`requestPlan` in `apps/api/src/lib/ai.ts` bounds a full grounded turn: decompose, embed, hybrid search, cross-encoder rerank, the **groundedness gate**, then generation. It defaults to **90s**, raised from 30s when [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md) moved embedding in-process, because a CPU embed is work rather than an API call and a normal turn could exceed the old budget.

The gate is one cheap-tier model call per goal and adds roughly a second to a turn dominated by tens of seconds of cross-encoder CPU, so the budget is unchanged. It is worth stating rather than assuming, because it is the one step in the turn that can only ever be added to: it is a safety check, so it cannot be dropped to save time, and the correct response to it not fitting is a larger instance rather than a shorter check.

It is now configurable via `AI_REQUEST_TIMEOUT_MS`, because reranking moved in-process ([ADR-0009](../40-adr/0009-local-reranker.md)) and the cost now scales with the cores the AI service has: roughly **71s per goal on 12 threads, 230s on one**. 90s fits a well-provisioned instance and not a small one.

**The default was deliberately not raised to cover the slowest case.** Agent runs are asynchronous (`202 + runId`), so a slower instance produces a longer wait rather than a failure, while a default long enough for a single vCPU would mean a genuinely hung service takes four minutes to report instead of ninety seconds. Size the instance, or raise the budget per environment.

Two properties this depends on, both easy to regress:

- **The reasoning service warms its model at startup**, so the budget covers steady-state work rather than a cold load. Without that, the first request after a deploy pays several seconds of model load and the timeout fires on a service that is perfectly healthy.
- **A timeout is reported as a timeout**, and this line was written as settled while the code did the opposite, which is worth recording because it is exactly the drift the doc rule exists to catch. `requestPlan` did throw a specific error, and the route then flattened **every** `AiServiceError` into "the reasoning service did not respond" before posting it. The distinction existed in the logs and was lost on the one surface a person reads, which is indistinguishable from the service being down and sends debugging in the wrong direction. `AiServiceError` now carries a `kind` (`timeout` / `unreachable` / `status` / `contract`) and `failureNotice` maps it to what the room sees. A timeout is also the only one of the four that is **not a fault**, so it is the only one that suggests what to do; the rest are ours to fix and say so plainly. Found by hitting it: a whole-funnel goal exceeded 90s on a developer machine and reported a healthy service as unresponsive. If this budget is hit in normal use, the answer is to find what got slower, not to raise the number again.

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
