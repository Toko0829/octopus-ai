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

**Credentials come from `apps/api/.env`, read rather than copied**, so there is
no second file holding a service key. The `ai` service is deliberately given that
file and **not** `services/ai/.env`: the API file holds credentials, which is all
the container lacks, while the AI file holds `EMBED_LOCAL_PATH` and
`RERANK_LOCAL_PATH` pointing at a developer's Hugging Face cache, and passing
those in would override the image's own baked paths with directories that do not
exist inside it. Same identity-versus-location split [ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)
draws, reaching a different surface.

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

**Measured on the built image, not estimated:**

|                                |                                             |
| ------------------------------ | ------------------------------------------- |
| Image layers                   | **6.44 GB** (4.59 GB weights, 1.71 GB venv) |
| Peak RSS, both models resident | **5.15 GB** (embedder 4.22, reranker +0.93) |
| Cold start to `/health`        | ~17s, embedder warmed                       |
| Reranker first load            | ~22s, lazy on first use                     |

So the deployment floor is an **8 GB instance**, and that answers the sizing question [roadmap.md](../10-architecture/roadmap.md) defers to Phase 2. One uvicorn worker, deliberately: each worker holds its own copy of both models, so a second doubles memory to buy concurrency on a service whose bottleneck is per-request CPU. Scale with instances.

**CPU-only torch is pinned in `uv.lock`, not in the Dockerfile.** The CUDA build was 2,480 MB of the 3,179 MB of Linux wheels, 78% of the payload, and no environment here has a GPU. Pinning it in the image alone would have left CI scoring the golden set on one torch build while production ran another, which [ADR-0009](../40-adr/0009-local-reranker.md) records as the kind of change that moves model scores. One torch everywhere, and `uv.lock` is already in the eval's trigger paths so the gate re-measures it.

Two things the build gets right only because running it proved them wrong first. **Model paths are stable symlinks (`/opt/models/embed`) set as plain `ENV`**, not resolved into a shell wrapper: the first version put them in the CMD's shell only, so `docker run <image> python -m octopus_ai.evaluation --shard ...` — exactly how a CI shard would invoke it — saw an empty path and failed with a repo-id error. That is now a smoke test in the workflow rather than a thing to remember. And the container takes **secrets from the environment but never model location**; passing a developer's `services/ai/.env` straight in drags a host-specific `EMBED_LOCAL_PATH` along with it and breaks the image's own layout.

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
