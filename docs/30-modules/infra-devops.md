# Module: Infrastructure & DevOps

> The **foundation module**: monorepo layout, deployment topology, region co-location, connection pooling, CI/CD, migrations, secrets, and observability wiring. Everything else is built on it, so it is the **first module implemented**.
>
> **Owner paths:** `.github/workflows/**`, `packages/config/**`, `packages/observability/**`, root tooling, `supabase/` config · **Depends on:** foundation for all; provisions auth-identity's Supabase; wires observability.
>
> Update on any change to the monorepo layout, deployment, CI/CD, secrets, or the doc-drift check.
>
> **Implementation status (Phase 2, in progress):** Turborepo + pnpm workspaces, `.github/workflows/ci.yml`, and the working `scripts/check-docs.mjs` doc-drift check, all from Phase 0. Since then: a `test` step (vitest in `packages/core` and `apps/api`) alongside the Python `ai` job, the retrieval `eval` job sharded five ways behind a scope check, an `ai-image` job publishing the reasoning core to GHCR, Dockerfiles for all three services and a root `docker-compose.yml`. Not built: review apps per PR, OpenAPI + ts-rest client regeneration, and the Ragas/DeepEval generation gate. See [DEVELOPMENT.md](../../DEVELOPMENT.md).

## Monorepo layout

**Turborepo + pnpm workspaces** with remote caching.

```
apps/
  web       Next.js frontend + thin BFF (Discord-style chat UI)
  api       Fastify authoritative REST API, JWT verify, chat write path, webhooks
  matcher   Fastify marketplace/node-matching + waitpoint completion
  agent     agent runtime (AI SDK loop); not built, the executor runs in api (ADR-0010)
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
- Durable runs → our own Postgres, in `apps/api` ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)). Trigger.dev Cloud stays a documented escape hatch and is not provisioned.
- Supabase → managed cloud.
- **Region co-location** near the launch cohort to minimize Postgres/Realtime latency.

### All three services run under one compose file

`docker-compose.yml` at the repo root stands up `web`, `api` and `ai` on one
network: `docker compose up`, then <http://localhost:3000>. Postgres is
absent on purpose, since Supabase is managed and every service reaches it over
the internet, so there is nothing local to stand up.

**Every service sets `pull_policy: build`, because the default let a healthy
stack serve old code.** Compose defaults to `missing`, which builds only when no
image with the tag exists; each service here names its image (`octopus-web:latest`
and siblings), so after the first build every plain `docker compose up` started
that image and compiled nothing. Measured rather than reasoned about: on
2026-08-28 the three running images were six commits behind `main`, `web` was
serving the previous landing page, and all three healthchecks were green while
`git status` was clean. **A healthcheck answers whether the process is up, never
whether it is the code you wrote**, so nothing in the stack could have reported
this. `build` rebuilds on every `up`; the layer cache absorbs it, and
`services/ai`'s ~4.6 GB of weights are their own layer keyed on the model ids, so
they are not re-fetched. `--build` is now a no-op that still works, and
`--no-build` is the deliberate escape hatch for starting what is already on disk.
The cost is a few seconds of cache evaluation per `up`, taken knowingly against a
failure mode that names nothing and looks like an application bug.

**The two Node images build from the repo root and the Python one does not**,
which looks inconsistent and is the same rule applied twice. `apps/web` and
`apps/api` depend on workspace packages through `workspace:*`, and pnpm resolves
those through the root lockfile, so a narrower context cannot install them.
`services/ai` is outside the pnpm graph by [ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)
and needs nothing from it, so its context is its own directory and a root context
would ship `node_modules` to the daemon for no reason. A root `.dockerignore`
keeps the Node context from carrying `node_modules`, `.git` and the AI service's
2.5 GB virtualenv.

**Both Node images copy workspace manifests one line at a time, and forgetting a
line is silent, so `apps/api/Dockerfile` asserts the list instead of trusting
it.** Manifests are copied before the source so `pnpm install` re-runs when a
dependency moves rather than when a file changes, which means every
`workspace:*` the app declares needs its own `COPY`. The campaign-card slice
added `@octopus/marketing` to `apps/api` and did not add the line. **The image
built green and the container crashed on boot**, which is the ordering that makes
this worth writing down rather than just fixing.

The comment that used to sit above those COPY lines claimed a missing manifest
"fails as an unresolvable `workspace:*`". It does not. `pnpm install
--frozen-lockfile` completed normally, verified by building the image with the
line removed on purpose: pnpm links a workspace dependency **by path**, a symlink
to a directory that does not yet exist is still a legal symlink, and
`COPY packages/ packages/` afterwards creates the directory. The link then
resolves, tsx loads the real TypeScript, and the first symptom is:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
  imported from /app/packages/marketing/src/adapter.ts
```

which names a third-party module and a source file that are both innocent. The
actual fault is that `packages/marketing/node_modules` was never installed, and
nothing in that message points at it. **A comment asserting a safety property the
build does not have is worse than no comment**, because it is the reason nobody
checks.

A `RUN node -e` step after the install now reads the API's own manifest, filters
its `workspace:*` dependencies, and fails the build naming any whose
`node_modules` entry did not arrive. It is four lines of the build rather than
another check on every push ([no new CI](../../AGENTS.md) is a standing
preference), it costs 0.3s, and it was verified in both directions: green listing
all four packages, and red naming `@octopus/marketing` when the COPY line is
taken away. `apps/web` grew a third workspace dependency in the very next slice, so it
carries the same guard now. The connect flow's fake consent screen imports
`@octopus/marketing/fake-consent-code`, a subpath export that exists precisely
because the rest of that package reaches for `node:crypto` and a browser bundle
must not. **The sentence that used to end this paragraph said "if it grows a
third, the same guard belongs there", and it grew one within the hour**, which is
a better argument for adding a guard when you notice the gap than for writing
down that somebody should.

**One variable has no default and is not allowed one.** `OAUTH_STATE_SECRET`
signs the OAuth `state` parameter, which is the only thing standing between a
workspace and somebody else's ad account: without it, anybody can send a
signed-in person's browser to our callback carrying a code for an account they
never chose. It is **optional in the env schema and required at the point of
use**, which is a deliberate pair. Requiring it would stop every deployment from
booting for a feature most of them do not use; defaulting it would be worse than
either, because a signing key checked into a repository signs a state anyone can
forge. So a missing secret refuses to connect an account, naming the variable,
and breaks nothing else. Generate one per deployment with `openssl rand -hex 32`.
`OAUTH_STATE_TTL_SECONDS` (default 600) bounds how long a half-finished
authorisation stays valid, and it is short because the signature is the whole
control: there is no server-side record to revoke.

**Credentials come from `apps/api/.env`, read rather than copied**, so there is
no second file holding a service key. The `ai` service is deliberately given that
file and **not** `services/ai/.env`: the API file holds credentials, which is all
the container lacks, while the AI file holds `EMBED_LOCAL_PATH` and
`RERANK_LOCAL_PATH` pointing at a developer's Hugging Face cache, and passing
those in would override the image's own baked paths with directories that do not
exist inside it. Same identity-versus-location split [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)
draws, reaching a different surface.

**The API image carries `scripts/`, and a healthy stack is the argument for it.**
Compose brings up three services that pass every healthcheck and still cannot be
used to test the product, for two reasons that both read as application defects.
An empty corpus makes the agent refuse every goal, which is correct behaviour and
looks from the room exactly like a planner that does not work. And a
`node_profiles` row cannot be created by any route, policy or client grant:
`public.invite_node` is granted to `service_role` alone and `scripts/invite-node.mjs`
is its only caller ([human-nodes-marketplace.md](human-nodes-marketplace.md)), so
with no invited expert the matcher sweep, the offer, the acceptance and the
escrow hold behind it are all unreachable. **The stack could serve those features
and could not be made to hold the one row that exercises them.**

Seeding was always available inside the `ai` image, which ships `corpus/`. The
invite was not, so the only way to run it was on the host, and the documented host
form takes `SUPABASE_SECRET_KEY=...` on the command line. That is the part worth
fixing rather than the inconvenience: **a testing step should not put the service
key in a shell history**, and compose already reads `apps/api/.env` for this
service, so through the container the script inherits exactly the credentials the
API runs on and nothing is retyped.

```bash
docker compose run --rm --no-deps ai python -m octopus_ai.seed
docker compose run --rm --no-deps api node scripts/invite-node.mjs --email them@example.com --jurisdictions US-TX,US --languages en --confirm
```

One `COPY scripts/ scripts/` of ~13 KB, placed last so it invalidates nothing
above it, and it adds no dependency: the scripts are zero-dep by design, plain
`fetch` against PostgREST and GoTrue, so there is nothing to install or build.
`--no-deps` is for a stack already up; without it compose waits on the reasoning
core's healthcheck again before running a script that never calls it. This is not
the beginning of an ops console, which stays Phase 3
([admin-ops.md](admin-ops.md)); it makes an existing script reachable from the
network its credentials already describe.

**`api` waits on the reasoning core's healthcheck, not on its process.** That
service warms its embedder before it serves, so "started" and "ready" are minutes
apart, and an agent run into that gap fails in a way that reads as a broken
service rather than a cold one.

**Memory is the constraint that decides whether this works at all.** Measured on
the running stack: `ai` peaks at **5.3 GiB** with both models resident, `api` and
`web` take about 130 MiB each, so the three together sit near **5.6 GiB** and run
on a 7.6 GB Docker VM with headroom. That is below the 8 GB deployment floor
recorded for the service on its own, which is not a contradiction: the floor is
sized for a production instance rather than for the smallest VM that will boot
it. Below roughly 6.5 GB the container is killed while warming the embedder,
before it ever serves, with no error of its own. The reranker loads lazily, so
the container sits near 3.7 GiB until the first goal is planned and then jumps,
which means a stack that looks fine at startup can still be too tight for work. Two things worth knowing at build time:
`next build` needs `apps/web/.env.local` present, because `NEXT_PUBLIC_*` values
are inlined into the browser bundle then rather than read at run time, which is
the exact opposite of what CI wants and both are correct for what they test; and
both Node images copy `tsconfig.base.json` alongside the manifests, since both
apps' tsconfigs extend it and its absence fails as `TS5083` during `next build`.

### `services/ai` has a container, and it is sized by measurement rather than guess

`services/ai/Dockerfile` builds the reasoning core CPU-only, with **both model snapshots baked in**. Build it from the service directory, not the repo root: the service sits outside the pnpm workspace ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) and needs nothing from it, so `docker build -t octopus-ai services/ai` ships a 1.1 MB context instead of `node_modules`.

Weights are baked rather than fetched on boot because a cold start otherwise takes minutes and needs the network healthy at the worst moment, and because it would undo [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)'s startup warm-up: a missing or corrupt model is supposed to fail at boot with a named error, not on someone's first question.

**Both models are warmed at startup now, not just the embedder.** The reranker was lazy, so the first plan on every fresh container paid its load inside the request: measured on this machine, a cold first rerank is **18.4s** against roughly 2s warm, on top of a pass that is already the dominant cost of a planning turn. That is the defect ADR-0008 fixed for the embedder, surviving in the other model. The warm-up is a real forward pass rather than a bare load, because the first pass initialises kernels that loading does not touch. The cost is that peak RSS is reached BEFORE the container serves rather than on the first goal, so an instance below the floor now fails while warming instead of mid-request; the 180s healthcheck `start-period` already covers the extra boot time, and `DEVELOPMENT.md` says so for the local stack.

**Measured on the built image, not estimated:**

|                               |                                              |
| ----------------------------- | -------------------------------------------- |
| Image layers                  | **6.44 GB** (4.59 GB weights, 1.71 GB venv)  |
| RSS at rest, both models warm | **4.0 GiB**, before it serves anything       |
| Peak RSS, planning turn       | **5.9 GiB** at `RERANK_FANOUT=2` (5.3 at 1)  |
| Cold start to `/health`       | **37s**, both models warmed first            |
| Reranker first load           | 18.4s cold against ~2s warm, paid at startup |

**The fan-out moved the peak, and that is the one cost of it.** Two concurrent
rerank passes hold two passes' activations, so a planning turn peaks at 5.9 GiB
against 5.3 at `RERANK_FANOUT=1`. The weights are unchanged and dominate; what
grew is the part that scales with concurrency. It stays inside the floor below,
and it is the reason to lower the fan-out rather than the thread count on a small
instance.

So the deployment floor is an **8 GB instance**, and that answers the sizing question [roadmap.md](../10-architecture/roadmap.md) defers to Phase 2. One uvicorn worker, deliberately: each worker holds its own copy of both models, so a second doubles memory to buy concurrency on a service whose bottleneck is per-request CPU. Scale with instances.

**CPU-only torch is pinned in `uv.lock`, not in the Dockerfile.** The CUDA build was 2,480 MB of the 3,179 MB of Linux wheels, 78% of the payload, and no environment here has a GPU. Pinning it in the image alone would have left CI scoring the golden set on one torch build while production ran another, which [ADR-0009](../40-adr/0009-local-reranker.md) records as the kind of change that moves model scores. One torch everywhere, and `uv.lock` is already in the eval's trigger paths so the gate re-measures it.

Two things the build gets right only because running it proved them wrong first. **Model paths are stable symlinks (`/opt/models/embed`) set as plain `ENV`**, not resolved into a shell wrapper: the first version put them in the CMD's shell only, so `docker run <image> python -m octopus_ai.evaluation --shard ...` — exactly how a CI shard would invoke it — saw an empty path and failed with a repo-id error. That is now a smoke test in the workflow rather than a thing to remember. And the container takes **secrets from the environment but never model location**; passing a developer's `services/ai/.env` straight in drags a host-specific `EMBED_LOCAL_PATH` along with it and breaks the image's own layout.

**The container is given a thread budget, because torch's default gave it half the box.** `torch.set_num_threads` defaults to the **physical** core count while a container is scheduled on the **logical** one, so in-process embedding and reranking ran on 8 threads of a 16-thread host on a number nobody had chosen. Reranking is the dominant cost in a planning turn and it is pure CPU, so the halving was paid directly by whoever was waiting. Isolated in-container, one rerank pass over 25 candidates: **69.7s at the default 8, 36.8s at 16**; end to end on a six-sub-query goal, **498s before and 267s after**. `TORCH_NUM_THREADS: '16'` on the `ai` service carries it, and the setting defaults to `0` meaning "leave torch alone" so nothing changes for a deployment that does not own its box. A fixed number rather than a share of the host, because compose cannot express "all of them" and guessing high makes it slower rather than merely unbalanced: past saturation the threads contend. **Lower it on a smaller box.** `RERANK_FANOUT` divides it per concurrent pass rather than multiplying demand for it, so leave `TORCH_NUM_THREADS` at the box and set the fan-out from `python -m octopus_ai.bench`; the two settings compose rather than competing, and the measured rows live in [ai-orchestrator.md](ai-orchestrator.md).

The `ai-image` CI job builds it on any PR touching `services/ai/`, and publishes to **GHCR** from `main` as `:${{ github.sha }}` and `:latest`. Layer cache lives in the registry rather than the Actions cache, because the weights layer alone is 4.6 GB against a 10 GB per-repository cache limit that the uv and HF caches already share.

**The eval shards deliberately do not run inside the image, and that is a measurement rather than an oversight.** Rerouting them was the original motivation: setup is ~90s per shard, and at five shards that is the floor which stopped further splitting from helping. But most of that 90s was `uv sync` pulling the CUDA torch stack, and the lockfile pin already removed it from every install including CI's. What remains is restoring ~4.6 GB of weights from the Actions cache, and a registry pull of an image containing those same weights moves the same bytes. That trade might win and might not. Claiming it without measuring would be the same unmeasured "obvious fix" the three-shard split already taught this workflow to distrust, where per-shard call counts turned out even and per-call time did not.

## Connection pooling

Fastify → Postgres via **Supavisor / PgBouncer transaction pooling** to survive connection storms (serverless + many workers).

## CI/CD

**GitHub Actions** + Turborepo remote cache; review apps per PR; the **`.docmeta.yml` doc-drift check** (fails a PR that touches mapped code without touching its owning doc); RAG **eval gates**; **pgTAP** RLS tests; OpenAPI + ts-rest client regeneration.

**`apps/api` now has a runner too, and what forced it is worth recording.** The note below says to add vitest per package as each grows tests. `apps/api` grew four in one session, and **every one of them was silent**: an error message that told a person the reasoning service had not responded when it had, an intake branch that fell through to planning without saying so, a token limit that turned the plan card into prose, and a search query polluted with the person's own audience. None raised, none failed a type check, and each was found only by driving the product by hand and reading what appeared in the room. Manual checking is what made that session slow, not the defects themselves.

**`pnpm test` is now a CI step, and it is new.** `services/ai` has had pytest since it existed while the TypeScript half had nothing, which `README.md` recorded as a gap rather than a decision. `packages/core` is what made that untenable: it decides whether a task runs unsupervised, and "read it carefully" is not a control. **vitest**, deliberately scoped to `packages/core` rather than installed across the monorepo, because a test runner in a package with no tests is a dependency with no purpose. Add it per package as each grows tests. `turbo run test` picks up any package declaring the script.

## Migrations

Supabase CLI; one concern per migration; RLS policy + pgTAP test land **with** the table. Owned by [data-model.md](../10-architecture/data-model.md).

## Secrets & env

Doppler/Infisical; **Zod-validated env schema** (`packages/config`); no secrets in the repo or client bundle; `service_role` server-only.

`packages/config/**` finally has a `.docmeta.yml` mapping, owned by this doc. The
file's own rule at the top says every path under `packages/**` must match an
entry, and this one never did, so the env schema could change with no doc
obliged to notice. That matters more than a tidy-up: a new key there is usually a
deployment decision, and `CRAWL_ENABLED` is the case that proved it.

### Publishing is on unless it is switched off

`PUBLISH_ENABLED` (default **on**) and `PUBLISH_MAX_PER_TICK` (default 3) control
the publish sweep the ticker runs
([ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)). The default
inverts `CRAWL_ENABLED` below on purpose, and the pair is worth reading together
because they look alike and the reasoning is opposite.

Crawling is off by default to protect somebody else's servers from every
developer's laptop. Publishing has no stranger to protect: the sweep does nothing
until a workspace connects an account **and** an owner approves a campaign with a
budget typed on it, and the only registered provider makes no network call at
all. Off by default would also make the product lie, because approving a campaign
now says publishing starts shortly, and on an unconfigured deployment that
sentence would be false while the campaign sat at `ready` in silence.

So this key is a **kill switch, not an enablement**: set it to `false` to stop a
deployment publishing. The authorisation is the two human gates, not the flag.
The cap is small for the same reason the crawl's is: the sweep shares the
ticker's claim with the DAG walk and holds it while each platform call is in
flight.

### Optimizing is the strongest on-by-default of the family

`OPTIMIZE_ENABLED` (default **on**) and `OPTIMIZE_MAX_PER_TICK` (default 3)
control the optimize sweep the ticker runs directly after the metrics sweep
([ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)). It is the
fourth key in the family and sits furthest onto the publish side of the split:
the sweep is **doubly inert** until somebody opts in, selecting only live
campaigns whose owner typed a CPA ceiling on the panel, and nothing else writes
that column. Off by default would make a figure a person typed an unenforced
promise, which on a money surface is a false statement rather than a missing
feature. A kill switch exactly like its siblings: `false` stops a deployment
pausing, and campaigns are still measured and shown. The cap bounds pauses
**attempted** rather than campaigns judged, since judging is a cheap read plus a
pure function.

### The no-show sweep, and the one it is placed next to

`NO_SHOW_ENABLED` (default **on**) and `NO_SHOW_MAX_PER_TICK` (default 3) control
the sweep that returns a step to the marketplace when the expert who took it
missed the agreed date ([ADR-0023](../40-adr/0023-a-breached-deadline-reassigns.md)).
Same polarity as every key here except the crawler's, for the same reason: off by
default is for the sweep that reaches a stranger's server, and this one reaches
nobody outside the system. **What turning it off costs is stated rather than
implied:** an abandoned step then sits at `escrow_funded` forever with its hold
committing the owner's ceiling, which is the dead end slice 6 exists to close.

**Doubly inert** in its siblings' sense: it selects only live engagements past
`deadline_at` whose task is still `escrow_funded` or `in_progress`, so on a
deployment where nobody has missed a deadline it does one indexed read and stops.

**Its position on the pass is the point.** It runs immediately after the escrow
reconcile and immediately **before** the matcher, the way optimize runs directly
after metrics: it _produces_ tasks at `matching`, and the matcher picks them up in
the same pass rather than a tick later, so a person waiting on a replacement
expert waits one interval less for no extra work. It sits after the reconcile
because both give money back and that one is unwinding work the owner has already
cancelled, which is the less ambiguous case.

The cap bounds reassignments **performed** rather than engagements examined, and
the warnings the sweep sends are deliberately not counted against it, so a batch
of nodes approaching their deadline cannot starve the one who passed it. It is
small for a second reason its siblings do not have: each reassignment produces an
offer on the next matcher pass, so a large number here would push a burst at a
cold-start pool.

### The heal sweep is recovery, and sits with the other recovery

`HEAL_ENABLED` (default **on**) and `HEAL_MAX_PER_TICK` (default 3) control the
sweep that finishes an AI step the executor approved and did not get to finish,
because the process died between its `approved` write and its `done` write, and
delivers the artifact it never announced
([business-projects-workflow.md](business-projects-workflow.md) § "The heal
sweep"). Same polarity as every key here except the crawler's, for the family's
reason: it reaches nobody outside the system. **What turning it off costs is
stated rather than implied:** a finished step stays at `approved`, which is not
terminal, so any later replan may cancel work that passed its check, and the
cited artifact it produced sits in a table nobody but a developer can read.

**Doubly inert** in its siblings' sense: it selects only AI-owned steps at
`approved` for longer than five minutes, never a human step (that state is the
payout authorisation there) and never a campaign step, so on a deployment where
no worker has died in that window it does one indexed read and stops.

It runs directly after `reclaimLostRuns` and before the graph is walked, which
is the one position on the pass that is not about who is waiting: both act on
what a dead worker left behind, and finishing a step before the scheduler runs
means a dependent waiting on nothing but that second write moves in the same
pass. The cap bounds steps **finished**, and is small because each one is a
delivery into a room and the live database holds a backlog from before the
executor walked on at all.

### Measuring shares publishing's polarity, not crawling's

`METRICS_ENABLED` (default **on**) and `METRICS_MAX_PER_TICK` (default 3) control
the metrics sweep the ticker runs between publishing and crawling. It is the third
key in this family and it sits on the publish side of the split, which is worth
stating because the three look alike and the reasoning divides two-to-one.

Crawling is off by default to protect **somebody else's servers** from every
developer's laptop. Publishing and measuring have no stranger to protect: this
sweep reads only the accounts a workspace connected, about campaigns it approved,
and the only registered provider makes no network call at all. It is inert until
something is live.

Off by default would also repeat the defect the publish flag was inverted to
avoid. The project panel now shows a spend figure per campaign, and on an
unconfigured deployment that block would sit permanently at "No numbers yet" while
the campaign really was spending, which is a false surface rather than an absent
one. So this is a **kill switch, not an enablement**: set it to `false` to stop a
deployment measuring, and nothing else changes.

The per-tick cap matches publishing's and is bounded the same way, since the sweep
shares the ticker's claim with the DAG walk. Each campaign is separately capped at
seven days per pass by `MAX_PERIODS_PER_PULL`, so a campaign that has been dark for
a month drains in order over a few passes rather than holding the lease.

### Only one deployment crawls

`CRAWL_ENABLED` (default **off**) and `CRAWL_MAX_PER_TICK` (default 2) control the
external-source sweep the ticker runs. Off by default because the registry names
real public pages at regulators and ad platforms: a dozen developers each running
the API locally would otherwise fetch them on boot and again on every interval,
which is a burst of pointless traffic aimed at somebody else's servers from
addresses that have no reason to be asking. One deployment crawls; everything
else reads what it ingested. The cap is small because the sweep shares the
ticker's claim with the DAG walk, and sources come due on a cadence measured in
days, so two per pass drains a backlog within minutes without ever making this
the slow part of a tick.

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

**Implemented (Phase 1):** `services/ai` exists with `pyproject.toml` + `uv.lock`, ruff, and pytest. CI runs it as a **parallel `ai` job** (`uv sync --frozen`, `ruff check`, `pytest`) alongside the Node job. Locally: `uv run --directory services/ai uvicorn octopus_ai.main:app --reload --port 8000` (see [DEVELOPMENT.md](../../DEVELOPMENT.md)).

A third **`eval` job** runs the retrieval golden set ([rag-knowledge.md](rag-knowledge.md)). It is **unarmed** until the repository carries `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `OPENAI_API_KEY`; until then it emits a GitHub warning saying it measured nothing rather than reporting a green check that proves nothing. **No rerank credential is needed** — reranking runs in-process ([ADR-0009](../40-adr/0009-local-reranker.md)) — and OpenAI is required only for decomposition and generation.

> **The job must run the same models production runs, on both sides.** It pins `EMBED_PROVIDER=local` / `RERANK_PROVIDER=local`, installs the `local-embed` extra, and caches both sets of weights (~4.6GB). Left at the `openai` embedding default it would embed queries into a different vector space from the stored vectors and score near zero, presenting as a retrieval regression rather than a misconfigured job. Pointed at Cohere for rerank it would measure a pipeline nobody runs. **The cache key names both models**, so changing either invalidates it instead of silently scoring with the previous one.

> **The job's cost changed character with [ADR-0009](../40-adr/0009-local-reranker.md).** It used to be ~10 minutes of a rate limiter holding against a trial key's 10 calls/minute; it is now minutes of real CPU on a small runner, with no quota at all. `timeout-minutes` is 60 so a pathology (an unbatched loop, a cache miss re-downloading weights) surfaces as a timeout rather than burning an hour.
>
> Two CI properties keep the cost down without weakening the gate:
>
> - **Scoped to the files that can actually move a retrieval number**, not to all of `services/ai/**`. The wide filter meant a change to `main.py` or `schemas.py` spent tens of minutes of CPU proving something it could not have affected. The list errs wide on purpose — it includes `providers.py` (rerank adapter), `config.py` (threshold and candidate depth), `db.py` (issues `hybrid_search`), `pyproject.toml` / `uv.lock` (a torch or transformers bump moves model scores) and `supabase/migrations/` (the fusion SQL **is** retrieval). Scope is computed by one `git diff` in a tiny preceding job rather than a filter action (rule 20), and **falls open** when the base commit cannot be resolved (first push, force-push): skipping on an unknown diff would drop the gate exactly when history is unusual.
>
> - **Sharded across five runners**, cutting ~22 minutes to roughly 6 by buying more cores for CPU-bound work. The count was measured rather than picked: at three, the shards finished at 5.2 / 10.0 / 10.4 minutes, which looked like an uneven split and was not — call counts were 16 / 15 / 13 while **per-call time differed two-fold** (31.7s against 15.7s), which is runner-hardware variance. Redistributing cases cannot fix that; owning less of the set per runner can. Setup is ~90s per shard and fixed, so it becomes the floor and going much higher spends runners to shave seconds. **Those numbers aged, and the per-shard `timeout-minutes` had to follow them (20 → 40, measured 2026-08-28):** on the 35-case set over the grown corpus, the two shards that finished took 13m54s and 19m14s and the 20-minute bound killed the other three at 20m16s each, failing the merge on missing cases. The slowdown is the corpus growth plus `measurement` joining `COVERED_STAGES` — a sixth sub-query per broad goal, each one another cross-encoder pass — the same cost [rag-knowledge.md](rag-knowledge.md) records arriving on a developer machine. **The safety of this rests on one rule: a shard never reports a verdict.** Recall over five cases is a different statistic from recall over fifteen, so shards write raw per-case results and a separate `eval-report` job applies the thresholds once over the merged whole. That job **refuses to report at all unless every golden case is present** — the dangerous failure is not a shard that errors but a shard that never reports, which would shrink the denominator and return green over a set nobody measured in full. `fail-fast: false` keeps the surviving shards, and the merge names the missing cases. Fifteen unit tests cover the partition and the refusal.
>
> Credentials are also checked in `eval-scope` rather than in the shards. An unarmed shard exiting 0 without writing results would make the merge fail on missing cases, turning "not configured" into a red gate.
>
> The repository-wide concurrency group has been **removed** along with the quota it protected. It existed because a PR run and its own merge-to-`main` run were separate ref-scoped groups, ran together, and the second was rejected on its first call against a quota the first had spent. With no shared quota there is nothing left to serialise, and queueing would only add wall clock.
>
> The Ragas/DeepEval **generation** gate (faithfulness, answer relevancy) is still absent, and deliberately so: it needs an LLM judge, which bills per run and returns a different number each time. It belongs in a credentialed pass rather than in a deterministic gate.

## Scaling escape hatches (with triggers)

| Escape hatch                                   | Trigger                                                                                                                           |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Fastify uWebSockets WS gateway + Redis/Upstash | past ~500 concurrent / need server-authoritative ordering ([ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)) |
| Self-host / Temporal orchestration             | Trigger.dev cost/limits outgrown ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md))                        |
| pgvectorscale / dedicated vector DB            | tens of millions of chunks or high QPS ([ADR-0002](../40-adr/0002-stay-in-postgres-pgvector.md))                                  |

## Key entities / artifacts

`packages/config` (env schema) · `packages/db` (migrations, RLS) · `.docmeta.yml` · CI pipelines · deployment configs · secrets.

### Matcher sweep flags (slice 4)

| Variable               | Default | Notes                                                                                                 |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `MATCHER_ENABLED`      | on      | Kill switch. Off still lets a step be dispatched and shows "Finding an expert"; no offer is ever made |
| `MATCHER_MAX_PER_TICK` | 3       | Bounds offers **created**, not tasks read, so cascades cannot starve a ready offer                    |

On by default sits with `PUBLISH_ENABLED` / `METRICS_ENABLED` / `OPTIMIZE_ENABLED`
rather than with `CRAWL_ENABLED`. The polarity rule this file has followed since
publish is that a sweep opts in only when there is a stranger to protect; crawling
reaches regulators' servers and the matcher reaches nobody. It is also doubly inert:
nothing enters `matching` except an owner's explicit click.
