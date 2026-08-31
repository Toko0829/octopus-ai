# System Architecture

> The authoritative description of how the two-layer brain, the services, the durable orchestration, and Postgres-as-source-of-truth fit together. Read this before touching cross-service behavior. Update it when the topology, service boundaries, or the sync/async contract changes.
>
> **Implementation status (Phase 1):** the **chat write path is live**. `apps/api` implements `POST /api/rooms/:roomId/messages` (JWKS `preHandler` → RLS membership → `INSERT` → Postgres trigger broadcasts) and `GET /api/rooms/:roomId/messages` (since-cursor catch-up), both typed from `packages/contracts`. Verified end-to-end against Supabase: 24 assertions covering auth, idempotent replay, RLS refusal for non-members, and confirmed Realtime delivery to a live subscriber. `apps/web` consumes the API for real: Server Components read through `lib/api-server.ts`, the browser goes through the thin BFF at `/api/bff/*`, and there is **no mock data left in the app**. Also live: `GET /api/rooms`, `POST /api/rooms`, `GET /api/rooms/:roomId/channels`, `GET /api/rooms/:roomId/members`. The **Node-to-Python seam is live**: `POST /api/rooms/:roomId/agent-runs` returns `202 + runId`, calls `services/ai` for proposals, and executes them by posting to chat as the agent. Not yet wired: `fastify-type-provider-zod` + `@fastify/swagger` (routes validate with the contract's Zod schemas directly, so there is still one source of truth, but the OpenAPI document is not generated yet), TS client generation from the Python service's OpenAPI (`apps/api/src/lib/ai.ts` is hand-maintained meanwhile), and durability for the **planning** run, which still executes in-process. Task execution is durable ([ADR-0010](../40-adr/0010-postgres-durable-runner.md): a lease on `task_runs`, a reclaim sweep and the ticker), so a crash there loses a worker rather than a run; a crash inside `POST /agent-runs` before the plan is posted still loses the turn, and the person's message stays in the room to be retried. See [DEVELOPMENT.md](../../DEVELOPMENT.md).

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
   │ apps/matcher    │ │ Supabase     │ │ Supabase Postgres 17 (source of    │
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

### Artifact cards had never rendered, and two lines were why

`apps/api/src/routes/messages.ts` validated every stored embed against a discriminated union with `plan` and `question` arms and no `artifact` arm, and `packages/contracts` `EmbedState` omitted `reported`, which is the state every artifact embed is written with. Either alone drops the row: `toEmbed` returns null on a parse failure, so the card was silently discarded on read and only the plain-text message body reached the room. `ArtifactCard` has existed and never once rendered.

A union that ignores what it does not recognise is right for a corrupt row and wrong for a variant somebody forgot to add, and nothing distinguished the two. Both are closed, and a stored artifact now round-trips.

### `GET /api/rooms/:roomId/projects` and `GET /api/projects/:projectId`

What an approved plan became: the project, its steps, and what those steps
produced. Read-only, as the caller, so RLS decides what exists.

Until these existed the workflow engine had **no surface at all**. A person
approved a plan, the scheduler routed its steps, the executor wrote artifacts, and
the only evidence was a handful of cards scattered through a chat stream that
keeps scrolling. The artifact card answers "did this one step deliver something";
these answer "where is the whole thing up to", which is the question people
actually ask.

**The room resolves to its projects through the plan card, never through
`rooms.project_id`**, for the reason `roomForProject` already records and
`20260827110000` has now applied to the RLS predicate as well: that column is
claimed by the first project approved in a room. Reading it here would list one
project and silently omit the rest.

Three details the list route depends on:

- **The room is confirmed before an empty list is returned.** A room the caller
  cannot see and a room with no projects otherwise produce the same response, and
  telling those apart is most of why this surface exists.
- **Two plain reads merged in the service, not one `.or()` filter string.** Same
  reasoning as `roomForProject`: a hand-built PostgREST filter fails silently when
  it is wrong, and silently returning fewer projects than exist is the defect
  being removed.
- **A project the caller cannot see returns 404, not 403**, the same idiom rooms
  use. The API does not confirm the existence of a project it will not show you.

**Every read of `projects` selects one constant, and that is a repair rather than
a tidy-up.** `ProjectRow` parses all three reads on this route. `6fcd0d6` added
`budget_ceiling` and `currency` to it, updated the detail read, and missed both
reads in `listProjects`, so this endpoint returned **500 for every room holding a
project** from that commit until somebody opened the panel and found it dead.

Two things about how it hid are worth keeping, because neither is specific to
these columns. A PostgREST select is **a string**, so a column the schema requires
and the query omits cannot be seen by a type checker. And `z.coerce.number()`
turns the absent value into `NaN`, so the failure reads as a type complaint about
a value nobody sent rather than as a missing column. `PROJECT_COLUMNS` is now the
single definition, and `projects.test.ts` pins it against `ProjectRow.shape` in
both directions, which is the check that would have caught it.

Counting lives in `apps/api/src/lib/project-progress.ts`, pure and tested, because
a miscount does not throw, does not fail a type check, and renders as a perfectly
plausible progress figure. A step counts as done at `approved` rather than `done`,
matching `private.task_deps_satisfied`, so the number a person reads and the
number the scheduler acts on cannot disagree about what finished means.

### `CampaignSummary` carries what a campaign spent

`buildProjectDetail` gained one read: `campaign_outcomes` for the project,
filtered to `source = 'pull_metrics'`, summed per campaign by a pure
`rollupOutcomes` and merged into each `CampaignSummary`. It runs **as the caller**
like everything else on that route, so `campaign_outcomes_select_member` decides
what is visible and the handler adds no membership logic of its own.

Two properties are load-bearing and both are about null.

**Null means "not measured yet" and is never rendered as zero.** A zero on a spend
figure claims a day was measured and found to have none, which is a different
sentence from "this has not been read yet", and it is the wrong one to show
somebody wondering whether their money is moving.

**The rollup sums `pull_metrics` only.** A `manual` correction is a second row for
the same window rather than a replacement, so including both sources would count a
corrected day twice. The slice that writes the first manual row owns the
supersedence rule, which is the guards-land-with-their-writer ordering applied to a
read rule.

No derived ratios and no `revenueToDate`. Counts are counted, and revenue
attribution means something different on every channel, so it lands with the first
real provider rather than being averaged into existence now.

### `GET /api/projects/:projectId/artifacts/:artifactId/file-url`

A short-lived signed URL for an artifact that is a file rather than text.

**The artifact row is read with the caller-scoped client, and that read is the authorization.** If `artifacts_select_member` does not return the row, there is nothing to sign. The service client appears only afterwards, to mint the URL, because signing needs a key no client may hold. Reading the row with the service client and checking membership in the handler would put the authorization back in this file, where the next handler would have to remember to repeat it.

**The `storage.objects` select policy is the second layer, and it agrees with this route by construction.** Both terminate in `private.is_project_member`. That is the `20260827110000` lesson stated as a design rule rather than as a war story: a read path and a policy that answer the same question differently is a defect waiting for somebody to fix only one of them, and the last time it happened it cost 47 tasks and 28 of 58 artifacts.

**The signed URL is a bearer capability and is treated as one.** Anyone holding it can fetch the object until it expires, without presenting a token. So it is minted per request rather than stored, it lives ten minutes, and **it is never logged** (the catch logs `err.message` rather than the error object, because the storage client's errors can carry a response body). `expiresAt` travels with it so the client can tell "this link is stale" apart from "this file is gone".

Invisible, absent, and "this artifact is text rather than a file" are all `404`, matching the room idiom. The branch that decides which is a pure exported function, tested, because the text case is the common one: every artifact the product has written so far has a `body` and a null `storage_path`, and asking Storage to sign null would surface an ordinary artifact as a `500`.

### `POST /api/projects/:projectId/tasks/:taskId/resolution`

Unsticking one step: `answer` records that the owner did it and completes the
step, `retry` sends it back through the router.

**It names the step, and that is the design rather than a detail.** The other way
to answer is a chat message, and a question card claims _every_ message the owner
writes until it is dealt with, so a new request typed while steps are waiting is
silently filed as an answer to those steps. Two such cards had been holding rooms
for nearly two days. Answering a task by id removes the ambiguity at the source:
nothing has to guess what a sentence was for.

**Owner only, checked here.** Resolving a step either records the owner's own work
as a deliverable or spends compute retrying, and a human node in the room must do
neither. The check reads the room through the project's plan card as the caller,
so a room the caller cannot see yields no owner and it fails closed; a null owner
means nobody, never anybody, matching what `rooms.owner_id` already does for
approvals.

**The completion is a conditional update** on the state that was read, so two
clicks racing cannot both complete one step, and a step that moved underneath the
person is reported as exactly that rather than as an error.

### `POST /api/rooms/:roomId/sources`

Owner-only, membership by RLS as the caller with the 404-not-403 idiom, and exactly one of `text` or `url`. Replies **202** and does the work in a background continuation, posting the outcome into the room: what was recorded, that it was unchanged, or why it failed. Nothing is silent (rule 16).

URL fetching lives here rather than in `services/ai`, which talks to Postgres and to providers and to nothing else. It is the first outbound call either service makes on a user's instruction, so it is guarded on protocol, host, size, time and content type, with the redirect target re-vetted. DNS rebinding is explicitly not defended against and is recorded as a known limit in the module rather than left to be assumed.

### The ticker publishes as well as walking the graph

The same pass that walks the task DAG also sends the campaigns an owner has
already approved ([ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)).
`publishSweep` reads campaigns at `ready` or `publishing`, takes the ones whose
project is still active, and publishes the campaign-level entity through the
provider on the room's channel connection.

**It runs after the graph and before the crawl**, and that ordering is a claim
about who is waiting: somebody who approved a campaign is watching for it to go
live, and nobody is waiting on a regulator's page being re-read. Its own
try/catch, for the reason every sweep on this pass has one.

**Freshly approved campaigns outrank retries.** A row at `publishing` is a resume
or a retry and can recur for as long as a platform stays unhappy; draining those
first would let one failing campaign hold the per-pass cap and starve every
approval behind it.

**The durability argument is ADR-0010's, unchanged.** No new orchestration was
added: the intent row plus a unique idempotency key make each attempt
re-enterable, so a crash loses a worker rather than a publish. The sequence and
its failure map live in
[marketing-growth-engine.md](../30-modules/marketing-growth-engine.md).

`PUBLISH_ENABLED` gates it and defaults to **on**, which inverts `CRAWL_ENABLED`
below deliberately: crawling is off by default to protect somebody else's
servers, and publishing has no stranger to protect, since nothing happens until a
workspace connects an account and an owner approves a budget.

### The ticker measures, between publishing and crawling

The same pass records what live campaigns actually spent. `metricsSweep` reads
campaigns at `live` or `paused` whose project is still active, works out which
closed UTC days each one owes, and appends a row per day to `campaign_outcomes`,
which was the last of the four marketing tables with no writer.

**It runs after the publish sweep and before the crawl**, which is the same
who-is-waiting claim one notch further down. Somebody who approved a campaign is
watching for it to go live, so publishing keeps its place at the front; nobody
watches a number arrive. But these are our own customers' spend figures and the
registered provider makes no network call at all, where the crawl fetches from a
remote host that may be slow or hanging. Its own try/catch, for the reason every
sweep on this pass has one.

**The idempotency argument is different from publishing's and is worth stating
separately.** There is no intent row here, because a read makes nothing to
recover. What makes a re-pull safe is that `campaign_outcomes` is unique on
`(campaign_id, period_start, period_end, source)` and `duePeriods` is the only
thing that ever constructs a window, so a second pull of the same day collides in
Postgres instead of doubling the spend the optimizer reads. The table is
**append-only by grant including for `service_role`**, so `insert ... on conflict
do nothing` is not merely the house idiom, it is the only idiom available: there
is no UPDATE to fall back on.

Days are pulled oldest first and a campaign stops at its first failure, because
the cursor is `max(period_end)` and writing a later day while an earlier one
failed would move the cursor past it permanently. The failure map, the scope
split and the recorded limitations live in
[marketing-growth-engine.md](../30-modules/marketing-growth-engine.md).

`METRICS_ENABLED` gates it and defaults to **on**, sharing `PUBLISH_ENABLED`'s
polarity rather than `CRAWL_ENABLED`'s: there is no stranger to protect, and off
by default would leave the project panel's spend block saying "No numbers yet"
about a campaign that really was spending.

### The ticker optimizes, directly after measuring

The same pass now acts on what was just measured. `optimizeSweep` judges `live`
campaigns whose owner typed a CPA ceiling against their `pull_metrics` rollup
(`decideCpaBreach`: breach iff `spend > ceiling × (conversions + 1)`, abstaining
on anything unmeasured) and pauses a breaching campaign at the platform and then
here, which is the first act on money in the system with no click immediately
behind it. The authorisation is the ceiling itself
([ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)).

**Its ordering argument inverts the publish sweep's**: the platform is called
**before** the rows are written, because a pause creates nothing to lose and the
decision re-derives from durable rows, while our-rows-first would open the one
unacceptable window, a database saying `paused` about a campaign the platform is
still spending on. The idempotency key carries an **epoch** (the count of prior
`paused → live` transitions in `events`), so a crash replays under the same key
while a second breach after an owner's resume is a genuinely new act. No failure
here ever moves a campaign; `live → failed` is not a legal arc.

It sits between metrics and the crawl: it reads days the metrics sweep may have
written this pass, and stopping money outranks re-reading a stranger's page.
`OPTIMIZE_ENABLED` defaults **on** and is the strongest claim of the three
kill-switch flags, because the sweep is doubly inert until an owner types a
ceiling, and off by default would make a typed ceiling an unenforced promise.

### The ticker crawls as well as walking the graph

The same pass that walks the task DAG ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)) now also re-reads the external source registry, under the claim it already holds. Off by default (`CRAWL_ENABLED`), because the registry names real public pages and a dozen developers fetching them on boot is traffic aimed at somebody else's servers for no benefit.

Four properties this depends on, and the second is the one that made the first run worth doing:

- **It runs after the graph, not before.** Walking the DAG is what a person is waiting on; re-reading a regulator's page is not, and it involves a remote host that may be slow or hanging. Its own try/catch for the same reason each project has one: a sweep that throws must not take the tick with it.
- **A page's status code is not evidence it is a document.** Three of the first nine sources answered `200` and stored site navigation, one of them localised to the crawler's own IP. The fetcher is a tag stripper, not a parser, so verification means reading what was stored. Recorded in [rag-knowledge.md](../30-modules/rag-knowledge.md) with what each page produced.
- **`last_crawled` records the attempt, not the success.** A blocked or missing page is retried on its cadence rather than every thirty seconds, which is the difference between a crawler and a nuisance.
- **The page hash is stored only after the ingest succeeds.** Storing it first would make a failed ingest look unchanged forever afterwards, which is the quietest possible way for a source to stop updating.

**Scheduling is here rather than in `pg_cron`, which [rag.md](rag.md) originally specified.** pg_cron runs SQL and SQL cannot make an outbound request, so it could only ever have signalled something that could; that something is this ticker. Outbound HTTP stays in Node for the same reason `POST /sources` does, and `services/ai` keeps its property of reaching Postgres and providers and nothing else.

### `POST /ingest` on the reasoning service

The shared-corpus counterpart to `/sources`, called by the sweep. Deliberately a second endpoint rather than a flag: `/sources` is room-scoped and fixes its own label, authority and doc type because everything arriving there is a person describing their business, while this one carries provenance the registry stated. A request body whose meaning depends on which optional fields happen to be set is the worse of the two designs.

`authority`, `market` and `doc_type` are stated by the registry and passed through unchanged. Inferring authority from a hostname is how a vendor blog becomes a regulator, so it is an editorial claim reviewed in a diff, not a derivation.

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
| Supabase       | Postgres 17 + RLS, GoTrue (JWKS), Storage, Realtime                                      | Single source of truth + auth + storage + chat transport.                                                                                                                                                                          |

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

**An open question card now has a window, and it never had one.** While one is
pending it claims every message the owner writes, which is right for a
conversation and wrong for a mode. `expires_at` has existed on `action_embeds`
since `20260812120000` and nothing ever wrote it, so cards were found holding
rooms for **nearly two days**, one having already swallowed a request its author
meant as a new goal. Nothing failed and nothing said so.

Two hours, chosen from the asymmetry rather than from taste. Expiring early means
an answer is read as a new goal while the step it answered still sits in
`needs_user`, visible and answerable in the project panel: annoying, recoverable.
Expiring late means a real request disappears into a step it was never about, with
no trace. **That asymmetry is the reverse of the one `decideIntakeTurn` was
written under**, when losing an answer was the expensive direction because steps
had no surface at all. The panel changed which way it points.

Filtered on read rather than swept from the table, because an expired card is
still the record of a question that was asked and the audit trail keeps it.

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

**`task_deps` are written from what the planner stated, and from nothing else** (`20260828120000`). For two weeks none were, and the reason held while it held: the planner returned stages and steps, so the only edges available would have been inferred from stage order, and inferring "strategy before content" invents a constraint nobody stated. An invented edge is worse than a missing one, because a missing edge lets things run in parallel that perhaps should not while an invented one blocks work for a reason that does not exist and cannot be traced to anything.

What changed is the planner, not the inference: `PlanStep` carries an `id` and a `dependsOn`, so a step can say which other step's output it consumes, and a second pass over the stages turns those into `hard` edges once every task exists. The function still derives nothing from stage order. An unresolvable reference or a duplicate id **raises**, on the same reasoning as the owner mapping above, and a cycle is refused by the acyclicity trigger rather than re-checked here. All three raise inside the same transaction, so a card that fails on its edges leaves no project behind even though its tasks were already written. `services/ai` drops what it can safely drop before proposing, so those raises are for cards that came from somewhere else.

`PlanEmbedPayload` gained `goal` for this, carrying the request in the person's own words. It also repairs the flywheel label, since `feedback_events.subject` stores this payload and an output with no input is not a training pair.

## Authorising a campaign

The first card whose approval commits money rather than work, and it exists
because a high-risk step had nowhere to go. `routeTask`'s first rule parks
`create_campaign` at `needs_user` whatever the planner proposed, and until now
that was the end of the road: the owner was told a step needed them and given
nothing to approve.

**Node asks, the core usually declines.** After each tick, `produceCampaignCards`
takes the results whose outcome is `needs_user` **and** whose rule is
`high_risk_needs_authorisation`, reading the router's own recorded verdict rather
than re-deriving it from the step's words. For each, `POST /campaign` on the
reasoning service drafts a campaign or declines. Declining is the common answer
and is a `post_message`, not a card: an account connection and a publish are both
`high_risk` and neither is a campaign. One card per task forever, keyed
`campaign-card:${taskId}` on the message, so a replayed tick collides rather than
asking a person to authorise the same spend twice.

**`ProposeCampaignProposal` carries no budget**, in the pydantic model and in its
Zod mirror. The owner types the cap on the card, and
`POST /api/rooms/:roomId/embeds/:embedId/actions` accepts a `budgetCap` for a
campaign card only, refusing it on any other component rather than ignoring it: a
number silently dropped on the way to an authorisation is the failure that field
exists to prevent. The route writes their figure into the card payload in the
**same conditional UPDATE** that records the verdict, so `feedback_events.subject`
and the payload `materialise_campaign` reads both carry what the person actually
entered.

**The spend cap is checked in the route and again in the writer**, which is a
deliberate duplication argued in [ADR-0011](../40-adr/0011-spend-cap-checked-twice.md).
The route refuses readably with the verdict's own sentence and leaves the card
`pending`; the writer re-checks under `for update`, because two cards approved in
the same instant both pass a check made here. `readSpendInputs` does the IO and
`checkSpendCap` in `packages/marketing` does the arithmetic.

Approving calls `public.materialise_campaign(embedId)`, the third sibling of
`materialise_plan` and `apply_plan_diff` with the same four properties. It returns
the **campaign**, not the project, so `EmbedActionResponse` gained `campaignId`;
the project is read back off the payload so the panel can be refreshed. The
scheduler ticks afterwards for a campaign exactly as for a plan, because the
writer closes the authorising step and that is what makes its dependents ready.

**`PATCH /api/projects/:projectId` sets the ceiling**, owner-only and audited as
`project.budget_set`. Before it, `projects.budget_ceiling` had no writer anywhere
in TypeScript and `checkSpendCap` would have refused every campaign forever.
`ProjectDetail` gained `budgetCeiling`, `currency`, `committedBudget` and
`campaigns` so the panel can show the same arithmetic the approval performs.

## Connecting a channel account

The writer `channel_connections` was built for, and the second dead end of the
shape the campaign card closed. `risk.py` clamps on `connect`, `authorise` and
`credentials`, so a "connect your ad account" step is parked at `needs_user`; the
campaign drafter is asked and correctly declines, because an account connection
is not a campaign. The owner was told a step needed them and given nowhere to go.

**The redirect lands on the web origin, not here**
([ADR-0012](../40-adr/0012-oauth-callback-on-the-web-origin.md)). A platform
redirects a browser, and that browser carries the Supabase session, so
`/connections/callback` in `apps/web` can prove who is finishing the flow and
hand the code inward through the BFF. Terminating at Fastify would have made this
the only unauthenticated mutating route in the system, holding one HMAC and
writing to the one table with no RLS behind it.

Four routes, all authenticated. `POST /api/rooms/:roomId/connections/start` signs
the state and returns the provider's authorize URL; the caller names only the
provider and the channel, because a client that could name its own redirect URI
could send somebody's code wherever it liked. `POST …/connections/callback`
verifies the state, exchanges the code and writes the row.
`GET …/connections` is the member projection. `DELETE …/connections/:id` revokes.
Reading is open to any member; the other three are owner-only.

**The state is signed rather than stored** (`lib/oauth-state.ts`): an HMAC over
the room, the user, the provider, the channel, an expiry and a nonce. No
`oauth_states` table, because a row written by one request and read by one other
is a schema whose only reader is itself. Verification order is the safety
property and is the opposite of the convenient one: signature first, since every
field is attacker-supplied until it checks out, then expiry so a stale-but-genuine
state gets its own answer, then the bindings.

**This is the one route group where RLS defends nothing.** `channel_connections`
has no grant to `authenticated`, so the read cannot run as the caller. Membership
is established separately first, by reading the room as the caller so RLS decides
visibility, and only then does a service-role client touch the table through
`lib/connections.ts`, whose column list omits both token columns and is asserted
in the tests.

`ChannelConnection` in `packages/contracts` **has no token field**, so a
projection that started returning one would fail to typecheck before it reached a
browser. `packages/marketing` gained `ChannelAuthProvider`, its fake, a registry
whose `carriesRealCredentials` flag the writer refuses on, and `checkScopes`.

## A node reading and editing their own record

`GET | PATCH /api/node`, `POST | DELETE /api/node/skills[/:tag]`,
`POST /api/node/credentials`, `POST /api/node/credentials/:id/revoke` and
`POST /api/node/verification`. Every path is **`/node`, singular, with no id
segment**, which removes a class of bug before it can be written: there is no
`:userId` to forget to compare against `request.user.sub`, so no request can name
somebody else's record. When the matcher lands and an owner has to read a node,
that is a different route with a different authorisation question and it should
look different.

**This group inverts the connections group on the read side and matches it on the
write side.** Reads run as the caller, because the three readable tables carry
`select`-own policies keyed on `auth.uid()`, so RLS row visibility **is** the
authorization and a person who was never invited simply sees no row. They are
told **404, never 403**: whether somebody is a node is not a fact a stranger gets
to confirm. Writes run as the service role, because none of the four tables has an
INSERT or UPDATE grant to `authenticated` and the suite pins that deliberately, so
every handler reads as the caller first and passes the id it proved into a writer
that constrains on it.

**`node_verifications` is not read anywhere in `lib/nodes.ts`**, and that absence
is the security property rather than an omission: the table refuses
`permission denied` to the subject of its own record, and projecting it through a
service client would hand back exactly what the grant was withheld to prevent.
Two other projections are controls rather than conveniences and are asserted in
both directions against their row schemas: `CREDENTIAL_COLUMNS` omits
`evidence_path` and `NODE_COLUMNS` omits `suspended_reason`.

**Nothing in this group creates a node.** `public.invite_node` is granted to
`service_role` alone and its only caller is `scripts/invite-node.mjs`, because
onboarding is ops-invited for as long as there is no matcher to offer anybody
work. `PatchNodeBody` is `.strict()`, so a body carrying `kycStatus` or
`trustScore` is a 400 rather than a field quietly dropped: a silent drop returns
200 and lets somebody believe a control applied. `packages/marketplace` holds the
skill taxonomy and the verification registry, whose `carriesRealPii` flag the
writer refuses on, exactly as `carriesRealCredentials` works one section above.

## Changing a plan that is already running

`POST /api/projects/:projectId/replan` takes the owner's reason and returns `202`.
The core is handed the project's goal, that reason, and the current DAG, and
answers with a diff; Node posts it as a `replan` card; approving that card runs
`public.apply_plan_diff`, through the same embed-action route a plan approval
uses. So a change to a running project crosses the same authorisation boundary
the original plan did, and **nothing replans on its own**.

The DAG travels in the request rather than being read by the core, because the
task graph is Node's (ADR-0006) and the core reaches Postgres for retrieval only.
It also means the diff is answered against exactly the state this process saw,
which is what makes `apply_plan_diff`'s staleness check meaningful rather than a
race between two readers.

Two guards live in the function rather than the route, for the reason the rest of
this seam already follows. A **stale** op, naming work that has since been
approved or stopped, raises and takes the whole diff with it, because skipping it
would apply a change nobody reviewed. And a **cross-room** diff raises: the card
names a project in its payload, and the route only ever checked the caller's
membership of the card's room, which says nothing about the project named.

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
