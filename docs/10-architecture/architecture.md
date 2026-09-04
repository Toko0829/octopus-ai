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
           │ task row changes state                      │ INSERT rows (AI as member)
           ▼                                             │
   ┌───────────────────────────────┐          ┌──────────┴───────────────┐
   │ ticker + lease (in apps/api)  │─────────▶│ executor (Node)           │
   │ one claim · reclaim · retries │◀─────────│ durable steps · TOOLS     │
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

`Task` carries **`blockedBy`**: the step's unfinished `hard` dependencies,
resolved to `{ taskId, title, state }` rather than shipped as raw ids.
`buildProjectDetail` reads `task_deps` as the caller, scoped by the ids the task
read just returned, because that table carries no `project_id` of its own. The
filtering rule is `DONE_STATES`, the TypeScript copy of
`private.task_deps_satisfied`, applied once on the server: sending ids instead
would put a second copy of that predicate in a React component, where it would
drift silently. See
[business-projects-workflow.md](../30-modules/business-projects-workflow.md).

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
to answer used to be a chat message, and a question card claimed _every_ message
the owner wrote until it was dealt with, so a new request typed while steps were
waiting was silently filed as an answer to those steps. Two such cards had been
holding rooms for nearly two days. Answering a task by id removed the ambiguity
at the source, and the card followed: it now carries one field per step and
answers through the embed action route by task id too, so nothing anywhere has
to guess what a sentence was for. Both paths complete the step through
`completeTaskWithAnswer`, so the arc is written once.

**Owner only, checked here.** Resolving a step either records the owner's own work
as a deliverable or spends compute retrying, and a human node in the room must do
neither. The check reads the room through the project's plan card as the caller,
so a room the caller cannot see yields no owner and it fails closed; a null owner
means nobody, never anybody, matching what `rooms.owner_id` already does for
approvals.

**The completion is a conditional update** on the state that was read, so two
clicks racing cannot both complete one step, and a step that moved underneath the
person is reported as exactly that rather than as an error.

**Two more verbs since slice 6: `approve_work` and `reject_work`**, the owner's
verdict on what an expert handed over. They are on this route rather than on an
action embed because this is where an owner writes `tasks.state`, and they share
its owner check and its conditional update.

They are the only action here that **walks two arcs**:
`proof_submitted → in_review → approved | rejected`, as two conditional updates
in one request. That is `accept_offer`'s idiom, and it keeps `in_review`
transit-only: a submission sits at `proof_submitted`, which honestly reads
"waiting on you", rather than at a state whose name claims somebody is currently
looking at it.

**A rejection must carry a note and an approval need not.** The node reads that
note and works from it, and their fee sits in escrow while they guess without
one. Both halves of that rule are in `resolveTask`, so the refusal is a sentence
rather than a 23514.

**Approving revokes the node's thread access and does not end the engagement.**
The first discharges an obligation `accept_offer` booked by name. The second is
deliberate: the panel reads live engagements only, so ending it would erase "who
did this" at the moment the owner is about to pay them, and
`private.engaged_counterparty` is time-boxed on `ended_at is null`, so it would
close the owner's read of the node's name before the payout.

### `POST /api/node/engagements/:engagementId/{start,proof}`

The node's half of the same loop, and the one place in this API that reads bytes.

**The authorisation is a caller-scoped read of their own `engagements` row**
through `engagements_select_node`, and everything after it uses the service key.
That is forced rather than chosen: a thread-scoped member is not a project member
(`20260901122000`), so they read zero rows from `tasks`, `projects` and
`artifacts` and zero objects from the artifacts bucket. **The projection is the
access control**, as it is for offers and engagements, and slice 6 adds no policy
to `artifacts` or to `storage.objects`.

**These routes carry an `:engagementId` where the rest of `/api/node` carries no
id at all.** The rule that convention states is "no request can name somebody
else's record", and the caller-scoped read enforces it: an engagement belonging
to another node is simply not there, and the API does not confirm the existence
of something it will not show. `/api/node/offers/:offerId/decline` set the
precedent.

**`/proof` is multipart**, because the note and the files are one act; the
two-phase alternative (submit JSON, then upload to a signed URL) reintroduces the
object-with-no-row orphan `writeFileArtifact` exists to prevent. The BFF proxy
was changed in the same push: it hardcoded `Content-Type: application/json`,
which was right while every payload was JSON and silently corrupts a multipart
boundary, since the boundary travels in that header.

**The floor check runs before anything is written and before the task moves**, so
a bounced submission leaves the step exactly where it was. That is what made
`proof_submitted → in_progress` unnecessary ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md)).

### The BFF decides "has a body" from the payload, not from the verb

Two defects, one shape, found by clicking a button on a real page rather than by
any test.

**`bff()` set `Content-Type: application/json` on every request**, including the
ones that send nothing. Fastify refuses that combination **before the handler
runs** (`FST_ERR_CTP_EMPTY_JSON_BODY`, "Body cannot be empty when content-type is
set to 'application/json'"), so every bodyless POST in the browser client was
unusable. `acceptOffer` has carried this **since slice 5**: accepting an offer
from a browser has never worked once.

**And the proxy decided whether to forward a body from the HTTP verb**, so a POST
with nothing in it forwarded a zero-length body plus a content-type and
reproduced the same error one layer down. It now decides from `byteLength`: an
empty POST forwards neither a body nor a content-type, the parser is skipped, and
the several routes written to take no body finally see the `undefined` they check
for.

**Why no test caught a bug in shipped code, which is the part worth keeping.**
`app.inject` sends no `content-type` unless a payload is given, so the route
suites were exercising a request shape the real client never produces. They were
not wrong — `app.inject` with no payload is exactly what the _fixed_ BFF sends —
they were simply blind to the header the client was adding. A route test cannot
see a defect that lives between the browser and the route, and `apps/web` has no
test harness (it is on the "not built" list in `README.md`). Until it does, a
bodyless mutation is only proved by clicking it.

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

| Service         | Tech                                                                                                                                                            | Responsibility                                                                                                                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`      | Next.js 15 App Router (Vercel), `@supabase/ssr`, RSC, ts-rest client                                                                                            | Discord-style UI; holds the session cookie; light read-aggregation; **proxies all mutations/long work to Fastify**; streams assistant tokens from Realtime. Never runs agent loops.                                                                                           |
| `apps/api`      | Node 22 + Fastify 5 (Fly.io), jose/JWKS, `fastify-type-provider-zod`, `@fastify/swagger`                                                                        | Authoritative REST API. Verifies JWTs; owns the chat **write** path; project/task CRUD; triggers agent runs; **holds the durable backbone** (the ticker, the run lease and every sweep, [ADR-0010](../40-adr/0010-postgres-durable-runner.md)); hosts webhooks (Stripe, IDV). |
| `apps/matcher`  | Fastify (may start as a module of `api`), `service_role`, geo + skill/rating filters                                                                            | Finds eligible nodes for a human task, notifies, manages accept/decline, adds the accepted node to the room (RLS membership), and **completes the agent's waitpoint** on verification.                                                                                        |
| `apps/agent`    | **Not built.** Node 22, Zod-typed tools; today this is the executor and the sweeps inside `apps/api`                                                            | Drives the run: calls `services/ai` for each reasoning step, then **executes the side effects** it proposes — persists plan/tasks/artifacts, posts to chat. Authz and spend caps live here, in tool code. It earns its own deployment when the ticker outgrows one process.   |
| `services/ai`   | **Python** (FastAPI + Pydantic, LlamaIndex), OpenAPI-typed seam, stateless                                                                                      | The reasoning core and RAG: retrieval, planning, drafting, tool **selection**, eval gates, provider calls. **Proposes only** — it never writes rows or moves money. ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))                                            |
| Postgres runner | `task_runs.lease_until`, a reclaim sweep, a heal sweep for steps a dead worker approved and did not finish, and a single advisory tick claim, all in `apps/api` | Durable orchestration on the database that already holds the state ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)). A human waitpoint is a task row, not a token. **No step-level replay UI**, which the ADR names as the real cost; the `events` log replaces it.    |
| pg-boss         | On Supabase Postgres                                                                                                                                            | Utility jobs (email, thumbnails, RAG re-index, reconciliation) — no Redis at MVP.                                                                                                                                                                                             |
| Supabase        | Postgres 17 + RLS, GoTrue (JWKS), Storage, Realtime                                                                                                             | Single source of truth + auth + storage + chat transport.                                                                                                                                                                                                                     |

## The two-layer brain

1. **Durable execution backbone** (Postgres, [ADR-0010](../40-adr/0010-postgres-durable-runner.md)) — survives crashes/deploys, retries steps, and _sleeps for days_ on human waitpoints at zero compute cost, because a waiting task is a row rather than a suspended continuation. It owns _when_ work runs and guarantees replay-safety.
2. **Supervisor / orchestrator reasoning core** (`services/ai`, Python) — decides _what_ to do: plans the task DAG, routes tasks (AI/HUMAN/USER), selects tools, and runs a maker-checker critic. Read-only sub-agents are spawned as tools; they never write the DAG. It **proposes**; `apps/agent` (Node) commits the result and performs every side effect.

Separation matters: the reasoning core can be non-deterministic and fallible; the backbone makes the _system_ deterministic, resumable, and auditable around it. The language split reinforces it — a jailbroken prompt in the Python core still cannot move money, because money only exists behind Node tool code and Postgres.

## Language split — Python AI service ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The AI/RAG layer is a **separate Python service** (`services/ai`, FastAPI); the rest of the backend stays Node/Fastify.

- **Python (`services/ai`)** owns RAG (ingestion + retrieval + rerank), the agent **reasoning core** (planning, drafting, tool selection), evaluation (Ragas/DeepEval), provider calls (OpenAI for generation + embeddings, Cohere for rerank — [ADR-0007](../40-adr/0007-openai-generation-embeddings-cohere-rerank.md)), and future self-hosted/trained models. Stateless behind an OpenAPI-typed HTTP seam; ingestion/eval run as jobs; shares the same Supabase Postgres (`service_role`, server-side only).
- **Node/Fastify** owns chat, realtime, auth, projects/tasks, marketplace, payments, notifications, the **durable backbone** (the Postgres lease and ticker, [ADR-0010](../40-adr/0010-postgres-durable-runner.md)) that drives the Python core, and **all side-effecting tools** (`post_message`, escrow, `request_human_node`) — which must run in the Postgres/RLS/Stripe world with authz in tool code.
- **Rule: Python proposes, Node executes.** The Python core decides _what_ to do; Node performs the side effects with guardrails. A jailbroken prompt in Python still cannot move money. This maps directly onto the two-layer brain (reasoning core = Python, durable backbone + execution = Node).

## Postgres as the single source of truth

- Chat, projects, tasks, ledger, escrow, and embeddings all live in one Postgres. There is no second store to keep in sync.
- **The AI participates by `INSERT`ing rows** (messages, tasks, artifacts) exactly like a human member — there is no privileged side channel. This keeps RLS and audit uniform.
- **The project list says which steps are in the executor's hands.** `ProjectSummary.working` carries the stage and title of every task in `ai_running` or `ai_self_check`, computed by `summariseProjects`, so the members panel can name the busy voice without a second read or a presence table. The client maps stage to persona through the same registry it renders names from; the wire deliberately carries the stage, because a persona on the wire would be a second copy of `personaForStage` and the stale one.
- **A mention routes to the replan path and nowhere else.** `startRun` parses `@Strategist`/`@Content`/`@Ads`/`@Analyst` before anything else it does, so a mention never closes the room's open intake cards and never reaches the classifier. From the owner, with a project live, it posts one acknowledgement and calls `produceDiff`; from anybody else, or with nothing running, it falls through to the ordinary run with the token stripped. **Nothing is applied**: the card crosses the same owner-gated boundary a plan does ([ADR-0031](../40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)).
- **It signs what it writes.** `messages.persona` (`20260912120000`) names which of four voices wrote an agent message — Strategist, Content, Ads, Analyst — and `events.payload.persona` records the same on `task.reviewed` and `task.executed`. The value is chosen in `apps/api` by `personaForStage` from the step's own `tasks.stage`; **no model picks it, and it grants nothing.** There is still one writer to the task DAG, one router, and one spend cap ([ADR-0031](../40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)). A client cannot set it: the route never sends the column and `messages_insert_own` carries `persona is null`, the same defense in depth `author_kind` has.
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

**A goal is a chat message, and an answer is an embed action.** They used to be the same event on the wire, both a chat message starting a run, with only the room's state telling them apart, and `decideIntakeTurn` made that call. It was right almost always and it had no way out: to know which message was an answer, a pending card had to claim every message the owner wrote until it was dealt with. Two cards were found holding rooms for nearly two days, one having swallowed a request its author meant as a new goal, and a two-hour `expires_at` was the patch. The ambiguity is gone at the source now. An answer arrives as `POST /api/rooms/:roomId/embeds/:embedId/actions` with `action: 'answer'` and a slot or a task, or `action: 'finish'`, and a chat message is always a goal. Nothing expires, because nothing claims.

**The question card is where the intake's state lives, and where its answers land.** The AI service is stateless by design (ADR-0006), so something on this side has to carry the slots between rounds, and an `action_embeds` row is already written, already RLS-scoped to the room, and already visible to the person whose answers it holds. A new table would have been a second place for the same facts. It also means the state and the questions it produced cannot disagree, because they are one row.

Four properties this path depends on:

- **Only the room's owner answers**, and it is the route that says so. Intake answers describe the person's own budget, customers and timeline, and a human node sitting in the room must not be able to state them. `required_role` on the embed used to be a hint the UI read, because an answer never reached the route where it is checked; it is the whole control now, checked before anything is written, and a refusal writes nothing.
- **Each answer is one statement.** `answer_question_slot` and `answer_question_task` (`20260910120000`) replace-or-append the one value they were given with `jsonb_set`, `where state = 'pending'` in the same statement, so two chips clicked in the same second cannot lose one another. A miss returns null, which the route reports as "already acted on" rather than as a fault. Executable by `service_role` only: `action_embeds` has no client UPDATE policy, so the grant is the control.
- **The card closes itself, conditionally.** When the last required slot the card asked about lands, or on `finish`, the route moves it `pending -> answered` with the same conditional update the verdict path uses, and only the writer that won continues the run. `remainingRequiredSlots` in `@octopus/core` decides "last" from the card alone, so closing needs no model call. A task card closes when every step it named has an answer, and continues nothing: its plan is already running.
- **Intake failing plans anyway.** Any error falls through to planning on the goal with whatever slots the card holds, which is the behaviour that existed before intake. It improves a query; it is not a precondition for answering. Nothing is granted by passing through, because the groundedness gate still runs inside `/plan`.

**The response carries the payload.** Realtime broadcasts `messages` inserts only, so a card on screen kept rendering the payload it was first fetched with: a campaign approved at 2000 read "approved at 0", and a question card would never have shown the answer just saved. `EmbedActionResponse.payload` travels back whenever the action changed it, and `remaining` names the required slots still open, so the client patches the one card in place.

**The card does not gate the plan, and finishing it continues the run that asked.** On `needs_detail` the run posts the card, then a `:started` system notice, then plans from the refined goal and whatever slots are known, so the card and the plan share a `runId` in their payloads. A finished card (`finish`, or the last required slot) runs `continueFromCard` under the deterministic run id `${runId}:r${round + 1}`, which is what makes the race harmless: the action side and the run side can both reach it, and every insert below collides on its idempotency key rather than doubling. The continuation looks up the plan the base run produced by `payload->>'runId'`. If a project exists with that card as `source_embed_id` and is still running, the answers become a replan diff through `produceDiff` in `lib/replan-diff.ts`, the same producer the panel uses, with `replanReason(slots)` as the templated reason; nothing is applied without the card. Otherwise, if the continuation's own plan already exists this is a replay and only the old card is retired. Otherwise intake runs again with the merged slots, a new plan is requested, and only then is the pending plan moved to `expired` with `expires_at = now()` (its window closed; a verdict would be a label) and the new plan posted carrying `supersedes`. Requesting before retiring is deliberate: expiring first and then failing would leave the person with no plan at all.

**The workspace's facts seed round 0.** `room_profiles` holds audience, offer, budget band and timeline for the room, read as `service_role` in the run and handed to `/intake` as `stated` slots, so a room that has answered before is `ready` without a card. It has three writers, all through `writeProfileFields`, which writes only the keys it is given: the question card as each slot lands, the run when intake finishes with something the owner stated, and `PATCH /api/rooms/:roomId/profile` from the panel's "About your business" block. Only the owner's goal writes it, because a member's message is a goal too and is not the workspace's word about itself. It is read by `GET /api/rooms/:roomId/profile` as the caller, and the policy is the first owner-only one in the database: a member reads nulls, which the route does not distinguish from "no row", because the API does not say whether a row exists for a room it will not show.

**An owner's new goal closes the intake cards about the previous one.** Read as `service_role` in the run, decided per card from the parsed payload by `dismissableQuestion` rather than by a filter string on the jsonb, and written `dismissed` conditionally on `pending`. A task card is never closed this way. A member's message is still a goal and touches no card, because the cards are about the owner's business.

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

## Connecting a model provider

The Models block's server half ([ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md)). Four routes, all authenticated, registered beside the channel connections because it is the same shape of decision one table along: a customer-held credential, an owner-only write, and a projection carrying no secret.

`GET /api/rooms/:roomId/models` is the member view and returns three things in one document: the connections projection, the per-role routes, and what Auto currently means. `POST …/models/connections` connects a provider with the workspace's own key, owner-only. `DELETE …/models/connections/:id` revokes it. `PATCH …/models/routes` sets or clears up to six roles, owner-only; PATCH rather than PUT because the BFF exports GET, POST, PATCH and DELETE and no PUT, which is the room-profile precedent.

**One response, two postures, and reading how it is assembled is the fastest way to understand this pair.** `model_connections` holds a customer's paid API key and has no client grant, so it is read as the service role behind the ownership check, exactly as the group above reads `channel_connections`. `model_routes` holds no secret and has a member select policy, so it is read **as the caller** and Postgres decides. The same handler uses two clients on purpose.

**`resolveRoom` moved to `lib/resolve-room.ts`** when this became its second caller. It reads the room as the caller and answers 404 rather than 403 for a room RLS hides, and that rule is now stated in one place rather than copied into a second closure that could drift from it.

**The key is checked with the provider before anything is stored.** `verifyKey` calls the vendor's own list-models endpoint, which is the one request every vendor answers for free: it authenticates, needs no model id and bills nothing. A refused key is 400 and an unreachable provider is 502, and **nothing is written on either path**, because a key stored unchecked would make the block say "connected" for something that may never work. Without that check the failure would land four minutes into an agent run, in a system notice, where a person cannot tell a typo from an outage.

**This is the one place in the system where a stored credential is decrypted.** `openSecretForProvider` in `lib/model-connections.ts` is the only function that opens a sealed key, and it is named so that "where does decryption happen" has an answer somebody can grep for. That is the property [ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md) decision 7 buys by rejecting Supabase Vault, which would have decrypted inside Postgres for `service_role` and therefore for `services/ai`. `apps/api/src/lib/envelope.ts` is AES-256-GCM over `node:crypto` with the additional authenticated data bound to the row; nothing else in the repository seals or opens anything.

**Revoking a key also deletes the routes that pointed at it**, which is the part with no precedent in the group above. A route naming a provider with no key would be a role that resolves to nothing, and the resolver would then have to choose between failing the run and silently using the house key. Neither is a good answer, so the state is made unreachable: those roles fall back to Auto, which the surface already explains.

`ModelConnection` in `packages/contracts` **has no key field**, so a projection that started returning one would fail to typecheck before it reached a browser, which is the property `ChannelConnection` relies on above. `MODEL_PROVIDERS` is the checked-in registry: providers, their dialects and their model lists as data, with `carriesRealCredentials` reading exactly as it does in `packages/marketing` and `packages/payments`, and every lookup failing closed on an unregistered name.

**The seam to `services/ai` now carries a target.** `lib/model-routing.ts` is the one consumer: `resolveGeneration(admin, roomId, role, secret, log)` reads the room's route for the role, opens the sealed key through `openSecretForProvider`, and returns a `GenerationTarget`, which `toWire` renames onto the request body. Every planning, executing, campaign and replan call goes through it; which role each one takes is the table in [ai-orchestrator.md](../30-modules/ai-orchestrator.md)'s Current shape. **`generation` is spread into a request body only when there is one**, so a workspace with no connectors sends the body it sent before ADR-0032 existed, byte for byte, and a test asserts that rather than a comment claiming it.

**The key travels over the compose private network in a JSON body and is stored nowhere on the far side.** `services/ai` holds it as a `SecretStr` for one request. Nothing in `lib/ai.ts` logs a request body, and there is no logger in that module at all, which is the cheapest way to keep that true. The `ai` container's `MODEL_KEY_SECRET` is blanked in `docker-compose.yml` so the master key never reaches it, and `docker compose exec ai printenv MODEL_KEY_SECRET` is empty.

**Failing loud rather than quietly falling back is the rule.** `ModelRoutingError` has two kinds: `not_configured` when a route exists and the server holds no master key, and `unreadable` when a stored ciphertext will not open. Both stop the run with a system notice naming `MODEL_KEY_SECRET`. The tempting alternative is to shrug and use the house key, and it is wrong twice over: the workspace chose a provider and would be silently billed to us, and the message would be stamped with a model the owner did not pick. A route pointing at a provider with no live connection is different and warns rather than stopping, because revoking a key deletes its routes and that state is stale bookkeeping rather than a decision anybody is making.

**The response is checked, and the check is narrower than it first looks.** `PlanResponse.provider` and `model` are optional so an older service still parses during a rolling deploy; a **grounded** answer to a routed call that names no model is refused as a contract break, because that is exactly what an old service silently running on the house key looks like. A refusal is `grounded: false` and legitimately names nothing, and demanding attribution of one turned a correct "I cannot ground this" into a failed run on every routed room. Found by driving the compose stack, not by any test.

### Drawing what a brief describes

`apps/api/src/lib/image-gen.ts`, the first outbound call in this system that produces bytes rather than sentences ([ADR-0033](../40-adr/0033-the-first-byte-producer-is-the-workspace-image-connector.md)).

**It sits here rather than in `services/ai` for the reason the seam was drawn.** That service holds no storage key and no Supabase write path, so bytes arriving there would have nowhere to go except back across an HTTP hop built for prose, and a live customer credential would reach a second process that has no use for it. The core emits a `generate_image` proposal carrying a prompt, a count and an aspect; `executeTask` performs it with the key it already holds and writes the files through `writeFileArtifact`. That is the shape of every act in this system: the core describes one, and the side allowed to act performs it.

**One request per image**, sequentially, on `x-goog-api-key` with the prompt in the body and never in a URL. `ImageGenError` carries a small closed `kind` (`auth`, `rate_limited`, `policy`, `unsupported`, `provider`) because the person's next move differs across it and nothing else about the failure does, and it never carries the target, since that struct holds a customer's key and the message reaches a log line and a room.

**Three conditions decide whether the capability is offered at all, and all three are checked before the request leaves**: `IMAGE_GEN_ENABLED`, a `creative` route on the room, and `images: true` on the routed model's registry entry. Withheld rather than ignored on the way back, because the brief's opening sentence is written from that capability, and a deployment that promised pictures and drew none would have put a false statement into the deliverable itself.

**Every failure ends with the brief delivered.** The images are written after the review passes, so a brief that failed its own check costs nobody an image call, and before `postArtifact`, so the card can name how many came with it. A refused key, a rate limit, a content refusal, an unreachable vendor and a storage failure each append one sentence to the same delivery message rather than posting a second one, because a delivery and the reason it is thinner than expected are one event and two rows would notify twice. **A retry does not draw twice**: existing `asset` rows on the task are the idempotency key, exactly as the artifact id is the delivery message's.

**The card carries ids and content types, never a URL.** A signed link is a ten-minute bearer credential and `action_embeds` rows are stored and re-broadcast on every room update, so a link there would be a credential written to a table and handed to the room for as long as the row lives. The panel mints one per click.

### Rating what a model wrote

`POST /api/rooms/:roomId/messages/:messageId/feedback`, owner only, in `routes/messages.ts` beside the write path it labels.

**A second subject for a table that has only ever had one.** Every path into `feedback_events` since `20260812130000` went through a card, because every AI output a person could judge was one. The labelled ungrounded tier ([ADR-0021](../40-adr/0021-a-labelled-ungrounded-tier.md)) is not: it answers in prose, carries no card by construction, and is the single output whose quality rests on the model rather than on the corpus. `20260913124000` gives the table `message_id` beside `embed_id` and the verdicts `helpful` / `not_helpful` beside the two card words. Joined to `messages.model` these become a per-provider approval rate, which is a query rather than a stored number precisely because the fact already exists in two tables and a third copy would drift.

**Two questions, two clients, two status codes**, which is the pattern `resolveRoom` was extracted for. The message is read **as the caller** with the pinned `MESSAGE_COLUMNS`, so RLS decides what exists and an invisible message is 404 rather than 403, matching how a non-member gets 404 on a room. Ownership is asked separately and answers 403, which is a different sentence about a different fact. The insert is service-role, because `feedback_events` grants no client INSERT: a label is the server's record of a decision it saw, and a client that could file its own could file one under somebody else's name.

**Three 409s, each protecting the rate from a different kind of nonsense**: a message no model wrote (`model` null, so a run notice or a waiting digest would be a label on a sentence composed in TypeScript), a person's or a node's message, and a message carrying a card whose own verdict already covers it. **The card check reads the raw join rather than the parsed embed**, and that distinction was a real defect rather than a nicety: `toEmbed` returns null for a payload it cannot parse, deliberately, so a corrupt row degrades to a plain message instead of breaking the stream, and reading that null as "no card here" let a message whose card failed to parse take a second verdict. Presence is a fact about the join; parseability is a fact about the payload. Caught by the route's own suite and pinned with an unparseable payload.

**Nothing follows from a label**, which is why the response is three fields and there is no state to reconcile. Labels append rather than update, so a changed mind is a second row and the latest wins, which is what an append-only table buys.

## A node reading and editing their own record

`GET | PATCH /api/node`, `POST | DELETE /api/node/skills[/:tag]`,
`POST /api/node/credentials`, `POST /api/node/credentials/:id/revoke`,
`POST /api/node/verification`, and since slice 5 `GET /api/node/engagements` and
`POST /api/node/offers/:offerId/accept`. Every path is **`/node`, singular, with
no id segment**, which removes a class of bug before it can be written: there is no
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

`requestPlan` in `apps/api/src/lib/ai.ts` bounds a full grounded turn: decompose, embed, hybrid search, cross-encoder rerank, the **groundedness gate**, then generation. It defaults to **300s**, having been 30s, then 90s when [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md) moved embedding in-process (a CPU embed is work rather than an API call), then 300s when [ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md) made the model a connector.

The gate is one cheap-tier model call per goal and adds roughly a second to a turn dominated by tens of seconds of cross-encoder CPU, so the budget is unchanged. It is worth stating rather than assuming, because it is the one step in the turn that can only ever be added to: it is a safety check, so it cannot be dropped to save time, and the correct response to it not fitting is a larger instance rather than a shorter check.

It is configurable via `AI_REQUEST_TIMEOUT_MS`, because reranking moved in-process ([ADR-0009](../40-adr/0009-local-reranker.md)) and the cost scales with the cores the AI service has: roughly **71s per goal on 12 threads, 230s on one**.

**The paragraph that used to sit here argued the default should not be raised to cover the slowest case, and connectors overturned it.** The argument was that agent runs are asynchronous (`202 + runId`), so a slow instance is a longer wait rather than a failure, while a long default only delays reporting a hung service. That held while every generation went to the house OpenAI key, which answers in seconds and does no thinking. A connected reasoning model breaks the premise: it can legitimately spend minutes, and `services/ai` now allows 240s for one provider call, so a 90s outer budget would hang up on Python mid-answer and report a healthy service as unresponsive.

**The two timeouts are ordered, and that ordering is the invariant.** Node's budget must stay comfortably above `request_timeout_s` in the AI service, so the outer one only ever fires when the inner one has already failed to. The accepted cost is that a genuinely hung service now takes five minutes to report rather than ninety seconds, which is a longer wait on a rare fault against every connector plan failing on a common one.

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

## The matcher (marketplace slice 4)

**A sweep on the existing ticker, not a service.** `.docmeta.yml` forward-registered
`apps/matcher/**` from Phase 0, and [ADR-0010](../40-adr/0010-postgres-durable-runner.md)
overtook it: durable work runs on the Postgres we already have, in `apps/api`, and
a fifth sweep beside publish, metrics, optimize and crawl needs no new deployment,
no new secret and no new failure mode. The mapping was updated to match.

- **Pure half:** `packages/marketplace/src/{stage-skills,jurisdiction,matching}.ts`
  — the stage-to-skill map, ADR-0015's containment and specificity operations, and
  ranking plus offer settlement. No clock, no client, exactly as
  `packages/marketing` splits.
- **IO half:** `apps/api/src/lib/match.ts`, three passes per tick: withdraw offers
  whose task left the market, settle and cascade the offered, offer the matching.
  `MATCHER_MAX_PER_TICK` bounds offers **created**, so a backlog of cascades cannot
  starve the one offer ready to go out.
- **Position:** after optimize, before crawl. The ordering rule on this pass is who
  is waiting: an owner who clicked and a node with nothing to do are both people,
  so it outranks re-reading a stranger's page; it moves no money, so it yields to
  the three sweeps that do.

**The sweep is the clock's side of this domain, and `accept_offer` is the
person's side.** This section used to say the sweep was the single writer of
`tasks.state` here, which was true while a node could only decline: the decline
route settles an offer row and never touches the task, and the next tick moves it.
Slice 5 changed it, because accepting and funding are inseparable, so
`public.accept_offer` moves the task itself, twice, in one transaction.

**What keeps them apart is not a single writer, it is that every move on both
sides is a conditional UPDATE on the row it read**, so a loser performs nothing.
Sweep first: the accept's `status = 'open'` conditional matches zero rows, it
raises, and the whole transaction unwinds. Accept first: `settleOffered` reads
only tasks at `offered`, `offerMatching` only tasks at `matching`, and
`withdrawOrphans` only `open` offers, so all three miss the accepted pair. They
cannot interleave past each other, because the cascade only moves a task whose
latest offer is already settled. Walked through in `match.ts`'s header and
asserted in `match.test.ts`.

The same idiom covers the owner resolving a step themselves while the sweep
dispatches it: the loser gets zero rows and answers 409, as `reclaimLostRuns`
already does. The visible cost of the decline half is unchanged: for up to one
tick a node has declined and the owner still reads "Offered to an expert".

### New routes

| Route                                         | Who      | Notes                                                                                                                      |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/:id/tasks/:taskId/resolution` | owner    | Gains `find_expert` beside `answer` and `retry`. Refuses on an unmappable stage or an empty pool **before** the task moves |
| `GET /api/node/offers`                        | the node | Own offers only. The projection carries three task fields and nothing identifying the owner                                |
| `POST /api/node/offers/:offerId/decline`      | the node | One conditional UPDATE carrying every precondition, including the deadline judged by Postgres                              |

## Acceptance (marketplace slice 5)

**One database function, and the reason is atomicity rather than tidiness.**
`public.accept_offer(p_offer_id, p_charge_id)` settles the offer, walks the task
`offered → claimed → escrow_funded`, writes the engagement, the escrow hold and a
balanced ledger pair, creates the task's thread and admits the node to it. Written
in Node it would be nine statements that can half-happen, and the half that matters
is "the offer says accepted and no hold exists": a node holding work nobody funded,
which is exactly the boundary the slice was drawn to close.

- **Pure half:** `packages/payments` — the chart of accounts, the balanced pair
  constructors, the derived idempotency keys, the provider seam and its registry.
  No clock, no client, no `fetch`, exactly as `packages/marketing` splits.
- **IO half:** `apps/api/src/lib/engagements.ts` (readable pre-checks, the fake
  charge, the rpc, the projections) and `apps/api/src/lib/escrow-reconcile.ts`
  (the ticker phase that gives escrow back).
- **Position of the new sweep:** after optimize, before the matcher. It touches
  modelled money, so it outranks making a new offer; it yields to optimize, which
  stops spend that is actually happening.

**The pre-checks are duplicated in SQL on purpose**, which is
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md) applied to acceptance. The
route exists so a person is told _which_ thing stopped them, in a sentence, before
anything is written. The function exists because two nodes accepting two steps on
one project at the same instant both pass a check made in Node, since each reads
the committed total before either writes; the row lock is what actually holds the
ceiling. When the raise wins anyway, the route surfaces **its message verbatim**,
because every `check_violation` in that function names what it found, including
the state it read back when a conditional update matched nothing.

**Nothing is charged.** The only registered payment provider is a deterministic
in-repo fake, and `carriesRealMoney` refuses any other before the rpc, which is
the enforced half of the counsel gate in
[payments-billing.md](../30-modules/payments-billing.md). That is the third flag
of its shape, beside `carriesRealCredentials` and `carriesRealPii`.

| Route                                   | Who      | Notes                                                                                                                                                    |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/node/offers/:offerId/accept` | the node | **No body**, and one sent anyway is a 400: the price is their own rate and the step is the one offered. Offer read as the caller, so not-theirs is a 404 |
| `GET /api/node/engagements`             | the node | Accepted work. **Exposes `roomId` and `threadId`**, which the offer projection hides: after acceptance those two ids are the admission                   |
| `POST /api/rooms/:roomId/messages`      | either   | Gains an optional `threadId`. The channel is **derived** from the thread, and `author_kind` from the caller's own membership row                         |
| `GET /api/projects/:id`                 | owner    | Task projection gains the engagement line; `committedBudget` gains held escrow and `escrowHeld` is broken out beside it                                  |

### New environment flags

`ESCROW_RECONCILE_ENABLED` (on by default, a kill switch) and
`ESCROW_RECONCILE_MAX_PER_TICK` (default 3). Of the five sweep flags this one has
the strongest claim to on-by-default: the others are switches over things a
deployment might reasonably not do, and this is the only sweep whose absence
actively takes something away. A step cancelled after its escrow was funded leaves
the hold at `held`, a held hold commits the ceiling
([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)), and
**nothing else in the product can release it**.

### New environment flags

`MATCHER_ENABLED` (on by default, a kill switch) and `MATCHER_MAX_PER_TICK`
(default 3). On-by-default sits with publish, metrics and optimize rather than
with crawl: the polarity rule is that a sweep opts in only when there is a
stranger to protect, and the matcher reaches nobody. It is doubly inert until an
owner clicks, and off by default would leave the panel's "Find an expert" button
moving a step to `matching` where it waits forever.

## Telling somebody (notifications slice 1)

The fourth route group in `apps/api`, and the only one whose authorisation is
entirely the database's.

### The derivation runs in Postgres, not in Node

`private.notify_from_event()` is an `AFTER INSERT` trigger on `public.events` and
the only writer of `public.notifications`
([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)). This is
a deliberate exception to "Python proposes, Node executes with guardrails": the
guardrail here is not a side effect to be gated, it is a **completeness property**,
and Node cannot hold it. Six of the eleven moments worth telling somebody about
are written by SQL functions inside their own transactions (`accept_offer`,
`reassign_engagement`, `settle_payout`, `raise_dispute`, and the guard triggers
behind dispute resolution and the KYC verdict). A helper called from a route
reaches none of them without re-implementing those transactions in TypeScript,
which is the two-writers-over-one-truth shape this system keeps paying for.

`events` is the one ledger every writer already reaches, in the same transaction
as the fact. Hanging the derivation off it means a moment cannot be recorded
without the person it concerns being told, **including by a writer that does not
exist yet** — which is the only version of this property that survives the next
slice.

The consequence runs the other way too and is written down rather than
discovered: this trigger executes inside `settle_payout`, so a defect in it
aborts a payout. Three things bound that. Enrichment is `left join` throughout,
so a missing step title or a deleted room can never be the fault. The verb list is
a closed `case`, so an unknown verb returns before touching anything. And
`supabase/tests/notifications.sql` derives a row for every verb in the map, so a
payload rename fails a suite rather than a transfer.

### The routes are thin because the table is not

`apps/api/src/routes/notifications.ts` holds three endpoints and **every query in
it runs as the caller**. `public.notifications` carries two own-row policies, a
`select` grant, and an `update` grant narrowed to the single column `read_at`, so
the database already answers "whose rows are these" and "which column may they
touch". There is no `.eq('user_id', userId)` anywhere in the file and its absence
is the design: adding one would look like defence and would in fact be a second
place for the answer to live.

This is the inverse of `routes/ops.ts`, which must use the service client because
its authorisation is `profiles.role` and RLS cannot read that without a
`SECURITY DEFINER` helper in `public` — a shape `security-compliance.md` records
being reintroduced once by somebody who had read the migration that removed it.
The two route groups sit at opposite ends of the same rule.

`routes/notifications.test.ts` asserts the service client is never constructed,
because that swap would keep every functional assertion green while removing the
backstop.

### Delivery reuses the Realtime transport, on a per-person topic

A trigger on `notifications` broadcasts each row to `notify:user:<uid>`, a third
topic namespace beside `chat:room:` and `chat:thread:` (ADR-0003's transport,
unchanged). The client half in `apps/web/components/inbox/useInbox.ts` is the
shell's own subscription sequence: `getSession()`, `realtime.setAuth`, a private
channel, `broadcast` on `INSERT`, and a since-cursor catch-up on `SUBSCRIBED`
because a live subscription is not durable catch-up.

**Scoping to a person rather than a room is the point.** The chat topics are
joined by membership in a place, so they structurally cannot reach an owner about
their second business, or a node whose thread access was revoked when the work was
approved. Both are people this system pays.

### Contract

`listNotifications`, `markNotificationRead` and `markAllNotificationsRead` are in
the ts-rest router, unlike the node and ops groups, and
`packages/contracts/src/index.ts` records why: what kept those out was an
undecided question about a surface whose subject is always the caller, and
notifications have that property with no such question, because the answer is
uniform and total. They are also the one group called from both browser surfaces,
so leaving them out would mean two pages sharing an untyped boundary.

No new environment flags. There is nothing to disable: a deployment without this
is one where an offer, a handover and a dispute are all discovered by looking.
