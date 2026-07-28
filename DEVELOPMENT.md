# Development

How to run the Octopus monorepo locally. Product docs live in [README.md](README.md) and [`docs/`](docs/); this file is the engineering quick-start. Keep it in sync with the scaffold ([infra-devops.md](docs/30-modules/infra-devops.md)).

## Prerequisites

- **Node** ≥ 20 (repo targets 22 LTS — see [.nvmrc](.nvmrc); it also runs on 24)
- **pnpm** 10.x (`corepack enable` will provide it)

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

**Both must be running.** `apps/web` reads and writes through `apps/api`; with the API down, `/app` renders a "Cannot reach the API" card naming the URL it tried.

### If a port is already taken

The defaults are web `:3000` and api `:3001`, and unrelated dev servers commonly squat them. To move the API, set **both** halves or the web app will keep calling the old address:

| Where                 | Variable   | Example                 |
| --------------------- | ---------- | ----------------------- |
| `apps/api/.env`       | `API_PORT` | `3011`                  |
| `apps/web/.env.local` | `API_URL`  | `http://localhost:3011` |
| `apps/api/.env`       | `WEB_URL`  | web's origin, for CORS  |

Next reloads `.env.local` on change; the Fastify service needs a restart.

## Workspaces

| Path                 | Package              | What                                                        |
| -------------------- | -------------------- | ----------------------------------------------------------- |
| `apps/web`           | `@octopus/web`       | Next.js 15 frontend + thin BFF (Phase 0: editorial landing) |
| `apps/api`           | `@octopus/api`       | Fastify 5 API (Phase 0: `/api/health` + JWKS auth util)     |
| `packages/config`    | `@octopus/config`    | Zod-validated env + shared constants                        |
| `packages/contracts` | `@octopus/contracts` | ts-rest + Zod API contract (shared client/server)           |

Future apps/packages are created when their roadmap phase arrives — see [infra-devops.md](docs/30-modules/infra-devops.md) for the full intended layout.

## The doc-drift check (why CI may fail your PR)

`pnpm check:docs` reads [.docmeta.yml](.docmeta.yml) and **fails if you changed a mapped code path without updating its owning doc** — the machine-enforced half of the doc-maintenance rule ([AGENTS.md](AGENTS.md)). It runs on every PR (see [.github/workflows/ci.yml](.github/workflows/ci.yml)). Fix a failure by updating the owning doc in the same PR. The check compares against `origin/main` by default (`BASE_REF` to override).

## Supabase (local)

`supabase/` holds `config.toml`, the initial migration ([20260724000000_init.sql](supabase/migrations/20260724000000_init.sql), profiles + RLS), and `seed.sql`. Bring up a local stack with the Supabase CLI (`supabase start`) once you're ready to wire auth in Phase 1.

## Notes

- Phase 0 `build`/`typecheck` for services is `tsc --noEmit`; real per-service bundling lands in Phase 1+.
- `service_role` is **server-only** — never put it in a `NEXT_PUBLIC_*` var or client code.
