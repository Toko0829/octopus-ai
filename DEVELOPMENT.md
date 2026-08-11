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

**Switching provider re-embeds the whole corpus, by design.** The ingestion content hash covers the active embedding model, so the next seed run supersedes every document rather than skipping it as unchanged. That is what stops one corpus holding two incompatible vector spaces. Re-seed with the same command as above; at four documents it takes seconds.

## Notes

- Phase 0 `build`/`typecheck` for services is `tsc --noEmit`; real per-service bundling lands in Phase 1+.
- `service_role` is **server-only** — never put it in a `NEXT_PUBLIC_*` var or client code.
