# packages/ — shared libraries

> `config` and `contracts` exist; the rest are created when their roadmap phase arrives. Full intended layout in [infra-devops.md](../docs/30-modules/infra-devops.md).

| Package         | Status     | Purpose                                                                  | Owner doc                                                                                                     |
| --------------- | ---------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `config`        | ✅ built   | eslint, tsconfig, env schema (Zod), constants                            | [infra-devops](../docs/30-modules/infra-devops.md)                                                            |
| `contracts`     | ✅ built   | Zod schemas + ts-rest/OpenAPI contract                                   | [architecture](../docs/10-architecture/architecture.md) ([ADR-0004](../docs/40-adr/0004-tsrest-over-trpc.md)) |
| `db`            | ❌ pending | Supabase migrations, RLS policies, generated types, query layer, pg-boss | [data-model](../docs/10-architecture/data-model.md)                                                           |
| `core`          | ✅ built   | Domain logic: the scheduler and router (escrow, membership to follow)    | [business-projects-workflow](../docs/30-modules/business-projects-workflow.md)                                |
| `agent-tools`   | ❌ pending | Zod-typed agent tools                                                    | [ai-orchestrator](../docs/30-modules/ai-orchestrator.md)                                                      |
| `realtime`      | ❌ pending | Chat transport abstraction (Broadcast now, WS later)                     | [chat-discord](../docs/30-modules/chat-discord.md)                                                            |
| `ui`            | ❌ pending | Shared React components / design system                                  | [design-system-frontend](../docs/30-modules/design-system-frontend.md)                                        |
| `observability` | ❌ pending | OpenTelemetry, Sentry, LLM-trace wiring                                  | [observability](../docs/10-architecture/observability.md)                                                     |

> **`core` holds decisions, not IO.** The router is pure and the scheduler takes its database access as an injected port, so both are testable without a running system. That is not stylistic: the router decides whether a task runs unsupervised, and a component like that should be readable in one screen and provable without credentials. The adapter that gives it a real database lives in `apps/api/src/lib/scheduler.ts`.
>
> It also carries the repo's **first Node-side tests** (vitest, 19). `services/ai` has had pytest since it existed; the TypeScript half had nothing, which `README.md` recorded as a gap rather than a decision. `pnpm test` runs them and CI gates on it.

> **There is no `packages/rag`.** Retrieval lives in the Python service at `services/ai` ([ADR-0006](../docs/40-adr/0006-python-ai-service-node-backend.md)); the package was superseded before it was ever created, and `.docmeta.yml` drops the mapping for the same reason.
>
> Migrations currently live in `supabase/migrations/` and are applied with the Supabase CLI. `packages/db` is where the authored migrations and generated types are intended to land.
