# Development

How to run the Octopus monorepo locally. Product docs live in [README.md](README.md) and [`docs/`](docs/); this file is the engineering quick-start. Keep it in sync with the scaffold ([infra-devops.md](docs/30-modules/infra-devops.md)).

## Prerequisites

- **Node** ≥ 20 (repo targets 22 LTS — see [.nvmrc](.nvmrc); it also runs on 24)
- **pnpm** 10.x (`corepack enable` will provide it)
- **Python** ≥ 3.12 and **uv**, for `services/ai` ([ADR-0006](docs/40-adr/0006-python-ai-service-node-backend.md)). Only needed to run the agent; the rest of the stack works without it.

## Setup

```bash
pnpm install
cp .env.example .env.local   # optional in Phase 0 — services boot with defaults
```

## Commands (run from the repo root)

```bash
pnpm dev         # run all apps (web on :3000, api on :3001) via Turborepo
pnpm build       # build all workspaces
pnpm typecheck   # tsc --noEmit across the monorepo
pnpm lint        # prettier --check + per-package lint
pnpm format      # prettier --write
pnpm check:docs  # doc-drift check against .docmeta.yml (see below)
```

Run a single app: `pnpm --filter @octopus/web dev` or `pnpm --filter @octopus/api dev`.

### The Python AI service

`services/ai` is Python and sits outside the pnpm workspace ([ADR-0006](docs/40-adr/0006-python-ai-service-node-backend.md)). It needs [uv](https://docs.astral.sh/uv/) on your PATH, because `pnpm ai:dev` and the other `ai:*` scripts invoke `uv` by name. If `uv --version` fails after `pip install uv`, the executable is in a per-user scripts directory; add it once:

```powershell
$dir = python -c "import uv, os; print(os.path.dirname(uv.find_uv_bin()))"
$user = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($user -notlike "*$dir*") { [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ';' + $dir), 'User') }
```

Two details this snippet is careful about, both of which bite silently:

- **Ask the package where its binary is, rather than assuming the layout.** The directory varies by Python version and install mode: on Python 3.13 here it is `…\Roaming\Python\Python313\Scripts`, not the `…\Roaming\Python\Scripts` that `site.USER_BASE + '\Scripts'` predicts. Guessing yields a real directory that contains no `uv`, so PATH looks configured and the command still fails.
- **Read the User path, not `$env:Path`.** `$env:Path` is the machine and user paths already merged, so writing it back into the `User` scope copies every system entry into your personal PATH permanently. The variable then grows on each run and the duplication outlives the shell.

Open a new terminal afterwards; the current one keeps the old PATH. To fix only the current session instead, `$env:Path += ";$dir"`.

Then, from the repo root:

```bash
pnpm ai:install
```

```bash
pnpm ai:dev
```

Its checks are separate from the Node ones and run as their own CI job:

```bash
pnpm ai:lint
```

```bash
pnpm ai:test
```

`apps/api` finds it via `AI_SERVICE_URL` (default `http://localhost:8000`). With the service down, an agent run posts a system message into the room saying so, rather than failing silently.

## Running the whole thing

Two ways. Compose if you want it running; three terminals if you want to edit it.

### All three in Docker

```bash
docker compose up
```

Then <http://localhost:3000>. The API is published on `:3011` and the reasoning
core on `:8000`, so both can be probed directly while testing. Credentials are
read from `apps/api/.env`, which is the file that already holds them, so there is
nothing extra to create.

**Every `up` rebuilds, and it did not always.** Each service sets
`pull_policy: build`. Compose's default is `missing`, which builds only when no
image with the tag exists, so after the first successful build every plain
`docker compose up` restarted the image already on disk and compiled nothing. The
stack came up healthy on all three healthchecks while serving code from whenever
the image happened to be built, which presents as the app ignoring your edits
rather than as a stale image. `--build` still works and is now the same thing, so
the flag is optional rather than the difference between current and not. If you
ever want the old behaviour for one run, `docker compose up --no-build` starts
what is on disk.

**Memory is the one setting that decides whether this works.** Measured on the
running stack rather than inherited from the service's own 8 GB deployment floor:
`ai` peaks at **5.3 GiB** once the reranker has loaded on first use, `api` and
`web` take about 130 MiB each, so the whole stack sits near **5.6 GiB**. It runs
comfortably on a 7.6 GB Docker VM. Below roughly 6.5 GB it will not, and the
failure is worth recognising because it names nothing: the container is killed
while warming the embedder, before it ever serves, so it looks like a crash with
no error of its own. On Docker Desktop the setting is Settings, Resources, Memory.

Note the reranker is **lazy**, so the AI container sits around 3.7 GiB until the
first goal is planned and then jumps. A stack that looked fine at startup can
still be too tight for real work.

**The first `up` is slow and then it is not.** The reasoning core's image bakes
~4.6 GB of model weights, and the web image runs a full `next build`. Afterwards
the weights layer is cached and only source layers rebuild.

Two things compose does that three terminals do not, both deliberate. `api` waits
on the reasoning core's **healthcheck** rather than on its process, because that
service warms its embedder before it serves and "started" and "ready" are minutes
apart. And `AI_SERVICE_URL` is overridden to `http://ai:8000`, since a service
name is a fact about that network rather than about your machine.

Compose is for running the thing. It does not hot-reload, so editing is still the
three-terminal path below.

### Three terminals

Three processes, one per terminal, all from the repo root:

| Terminal | Command                          | Serves                                    |
| -------- | -------------------------------- | ----------------------------------------- |
| 1        | `pnpm --filter @octopus/api dev` | Fastify API (`API_PORT`, default `:3001`) |
| 2        | `pnpm ai:dev`                    | Python reasoning service (`:8000`)        |
| 3        | `pnpm --filter @octopus/web dev` | Next.js app (`:3000`)                     |

`pnpm dev` alone starts only the Node apps; the Python service is outside Turborepo and needs its own terminal.

Then open the web app, sign in, create a workspace if you have none, and post a goal. The agent replies inline. If the reply never arrives, check terminal 1 for `agent run failed`, and confirm terminal 2 answers on `/health`.

All three matter, and each fails visibly rather than silently:

- **API down** → `/app` renders a "Cannot reach the API" card naming the URL it tried.
- **Python service down** → the run posts a system message into the room saying the reasoning service did not respond.
- **Realtime not connected** → a banner says live updates are off. Messages still load on reload.

> **If the app 500s or behaves oddly after a long editing session,** restart the dev server. Next's dev cache can go stale after many file changes (especially to `package.json` or `.env.local`), and the symptom looks like a code bug that a fresh start clears.

### If a port is already taken

The defaults are web `:3000` and api `:3001`, and unrelated dev servers commonly squat them. To move the API, set **both** halves or the web app will keep calling the old address:

| Where                 | Variable   | Example                 |
| --------------------- | ---------- | ----------------------- |
| `apps/api/.env`       | `API_PORT` | `3011`                  |
| `apps/web/.env.local` | `API_URL`  | `http://localhost:3011` |
| `apps/api/.env`       | `WEB_URL`  | web's origin, for CORS  |

Next reloads `.env.local` on change; the Fastify service needs a restart.

## Workspaces

| Path                 | Package              | What                                                      |
| -------------------- | -------------------- | --------------------------------------------------------- |
| `apps/web`           | `@octopus/web`       | Next.js 15 frontend + thin BFF; chat shell at `/app`      |
| `apps/api`           | `@octopus/api`       | Fastify 5 API: chat write path, rooms, agent runs         |
| `packages/config`    | `@octopus/config`    | Zod-validated env + shared constants                      |
| `packages/contracts` | `@octopus/contracts` | ts-rest + Zod API contract (shared client/server)         |
| `services/ai`        | `octopus-ai` (uv)    | **Python.** RAG + reasoning core. Outside the pnpm graph. |

Future apps/packages are created when their roadmap phase arrives — see [infra-devops.md](docs/30-modules/infra-devops.md) for the full intended layout.

## The doc-drift check (why CI may fail your PR)

`pnpm check:docs` reads [.docmeta.yml](.docmeta.yml) and **fails if you changed a mapped code path without updating its owning doc** — the machine-enforced half of the doc-maintenance rule ([AGENTS.md](AGENTS.md)). It runs on every PR (see [.github/workflows/ci.yml](.github/workflows/ci.yml)). Fix a failure by updating the owning doc in the same PR. The check compares against `origin/main` by default (`BASE_REF` to override).

## Supabase (local)

`supabase/` holds `config.toml`, `seed.sql`, and the migrations in `supabase/migrations/` (identity, chat, grants, RAG schema, hybrid search). Bring up a local stack with the Supabase CLI (`supabase start`).

Migration versions must match their filenames. If you apply one through a tool that stamps its own timestamp, correct the `version` in `supabase_migrations.schema_migrations` afterwards, or `supabase db push` will try to replay it.

## Seeding the knowledge base

Retrieval needs a corpus. The seed documents live in `services/ai/corpus/` as markdown with front matter:

```bash
uv run --directory services/ai python -m octopus_ai.seed
```

Pass a query to ingest and then probe retrieval in one go:

```bash
uv run --directory services/ai python -m octopus_ai.seed "how do I lower CPA"
```

Re-running is safe and cheap: a document whose content hash is unchanged is skipped without re-embedding. Changing a document supersedes the previous version rather than duplicating it. The hash covers `CHUNKER_VERSION` too, so changing how documents split forces a re-ingest.

With an empty corpus the agent will refuse every goal, which is correct behaviour rather than a bug.

### Embedding locally with BGE-M3 (optional)

Embeddings default to OpenAI. To run **BAAI/bge-m3** in-process instead, so no corpus text leaves the machine ([ADR-0008](docs/40-adr/0008-local-bge-m3-embeddings.md)), install the extra and fetch the weights:

```bash
uv sync --extra dev --extra local-embed
```

```bash
uv run --directory services/ai python -c "from huggingface_hub import snapshot_download; print(snapshot_download('BAAI/bge-m3', ignore_patterns=['onnx/*']))"
```

That prints the snapshot path and downloads ~2.2 GB. `onnx/*` is excluded because the repo ships a full ONNX duplicate of the weights that nothing here loads. Then set, in `services/ai/.env`:

```
EMBED_PROVIDER=local
EMBED_LOCAL_MODEL=BAAI/bge-m3
EMBED_LOCAL_PATH=<the snapshot path printed above>
```

> **Identity and location are two different settings, deliberately.** `EMBED_LOCAL_MODEL` is what gets written to `doc_chunks.embed_model` and folded into the ingestion hash, so it must stay stable across machines. `EMBED_LOCAL_PATH` is just where the weights happen to sit on this host. Collapsing them would mean a server with a different directory layout rewrites every row's provenance and triggers a full re-embed of an identical model.
>
> **Set the path if you intend to run offline.** FlagEmbedding re-resolves a repo id through `snapshot_download` without our exclusions, so under `HF_HUB_OFFLINE=1` it declares the cache incomplete and refuses to load over the missing ONNX files the model never needed. A filesystem path skips that check. Leaving `EMBED_LOCAL_PATH` empty is fine when the machine is online.

The extra pulls torch and transformers, roughly 2.5 GB of wheels, which is why it is not a base dependency: CI and OpenAI-backed deployments never install it.

## Reranking, which also runs locally ([ADR-0009](docs/40-adr/0009-local-reranker.md))

**The reranker is in-process by default**, on `BAAI/bge-reranker-v2-m3`. There is no rerank API key and no quota. It needs the same `local-embed` extra as the embedder, plus its weights:

```bash
uv run --directory services/ai python -c "from huggingface_hub import snapshot_download; print(snapshot_download('BAAI/bge-reranker-v2-m3', ignore_patterns=['onnx/*','*.onnx']))"
```

Then in `services/ai/.env`, following the same identity/location split as the embedder:

```
RERANK_LOCAL_MODEL=BAAI/bge-reranker-v2-m3
RERANK_LOCAL_PATH=<the snapshot path printed above>
```

> **It is CPU work, and the cost scales with cores.** Measured on the current pipeline: ~21s per rerank of 25 candidates on 12 threads, so a goal costs about **71s on a 16-core machine and ~230s on a single vCPU**. A smaller container is slower than your laptop, not faster. Agent runs are asynchronous (`202 + runId`), so this decides how long a plan takes rather than whether it works, but size the instance deliberately.
>
> If a local turn trips Node's 90s step budget, raise it in `apps/api/.env` rather than lowering quality:
>
> ```
> AI_REQUEST_TIMEOUT_MS=300000
> ```
>
> **The threshold is per provider and they are not interchangeable.** `RERANK_MIN_SCORE` (0.05) belongs to Cohere, where relevant chunks score 0.127–0.637. bge's separation sits at `RERANK_LOCAL_MIN_SCORE` (0.0013). Applying one to the other is not a tuning nit: Cohere's threshold against bge's scores measured **recall 0.45** before the two were separated.
>
> **That 0.0013 has a 1.76x margin** between the broadest legitimate goal and the strongest negative, against roughly 9x on Cohere. It is the tightest safety property in retrieval, and the golden set's **negative half is what defends it**. When you add a document, add a negative too, not just a positive.

To compare against the hosted reranker, set `RERANK_PROVIDER=cohere` and supply `COHERE_API_KEY`. It is kept working as the reference the local path is measured against; the key is required only when it is selected.

**Switching provider re-embeds the whole corpus, by design.** The ingestion content hash covers the active embedding model, so the next seed run supersedes every document rather than skipping it as unchanged. That is what stops one corpus holding two incompatible vector spaces. Re-seed with the same command as above; at four documents it takes seconds.

## Evaluating retrieval

The golden set lives in `services/ai/eval/golden.json` and is run against the live corpus with:

```bash
uv run --directory services/ai python -m octopus_ai.evaluation
```

It exits non-zero on a regression, so it works as a gate.

CI splits the same run across five runners, which is worth knowing if you ever reproduce a CI result locally:

```bash
uv run --directory services/ai python -m octopus_ai.evaluation --shard 1/5 --out shard-1.json
uv run --directory services/ai python -m octopus_ai.evaluation --merge shard-*.json
```

**A shard deliberately refuses to print a verdict**, and `--shard i/n` with `n > 1` requires `--out` for that reason: recall over three cases is a different statistic from recall over fifteen. Only `--merge` applies the thresholds, and it fails if any golden case is missing rather than scoring what it happens to have. Two halves are scored differently on purpose: positives must surface the expected document (recall ≥ 0.80), and negatives must return **nothing at all** (zero tolerance). A miss is unhelpful; a leak lets the agent ground an answer in text that does not support it.

Run it after any change to chunking, the embedder, the rerank threshold, or the corpus. Add a case whenever you add a document, and add a negative whenever you find a question the agent should refuse.

### The groundedness gate has its own set, and its own run

The rerank threshold **ranks chunks within the corpus. It cannot tell you the corpus does not cover a question**, and those are different questions. Measured: "how do I set up conversion tracking in GA4" scores 0.0211 against a 0.0013 threshold, while the legitimate goal "launch my app and get me to my first 100 customers" tops out at 0.0018. No threshold separates them.

So `scope_negatives` in `golden.json` holds marketing questions, in marketing words, that the corpus does not answer, and they are scored separately:

```bash
uv run --directory services/ai python -m octopus_ai.evaluation --gate
```

**Do not move these into `cases`.** Retrieval leaks on them by design, so filing them as ordinary negatives fails the retrieval gate permanently for something retrieval cannot be asked to do.

The pass scores both halves. Scope negatives must be refused (block rate 1.00), and legitimate goals must **not** be (pass rate ≥ 0.80), because a gate measured only on what it should refuse scores perfectly by refusing everything.

> **This one is not in CI, deliberately.** It calls a model, so it bills per run and does not return the same answer every time, which is the same reason the Ragas faithfulness metrics are absent. What CI gates is the gate's _logic_: that a non-boolean `supported` is rejected rather than coerced (`bool("false")` is `True`), that every failure path blocks rather than opens, and that the check runs before generation.
>
> `GROUNDEDNESS_CHECK=false` turns it off. That is for measuring the stages separately, not for production: a service with it off answers questions its corpus does not cover, and it logs a warning at startup saying so. Add a scope negative whenever you find a marketing question the corpus cannot answer; that is now a safety task rather than a coverage one.

> **A Cohere trial key allows 10 calls a minute, and the golden set needs far more than that.** With query decomposition on, one positive case is one rerank for the goal plus one per sub-query, up to seven; at 15 cases (11 positive) a full run is up to ~81 rerank calls. Set `COHERE_RERANK_RPM=8` and the run holds itself under the limit, taking ~10 minutes. On a production key leave it unset and the whole set finishes in seconds.
>
> Do not reach for `EVAL_CASE_DELAY_S` to solve this. It pauses between **cases**, and a case is no longer one call, so it cannot express a per-call quota. That mistake is what broke CI: the harness paused politely between bursts of seven. It survives only as a coarse manual throttle and defaults to `0`.

## Notes

- Phase 0 `build`/`typecheck` for services is `tsc --noEmit`; real per-service bundling lands in Phase 1+.
- `service_role` is **server-only** — never put it in a `NEXT_PUBLIC_*` var or client code.
