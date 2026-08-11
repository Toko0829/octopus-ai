# apps/ — application code

> `web` and `api` are built and running; `matcher` and `agent` are not created yet and arrive with their roadmap phase ([roadmap.md](../docs/10-architecture/roadmap.md)). Local setup and commands are in [DEVELOPMENT.md](../DEVELOPMENT.md).

See [infra-devops.md](../docs/30-modules/infra-devops.md) for the full intended monorepo layout.

| App       | Status     | Stack                                                                   | Doc                                                                                                                        |
| --------- | ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `web`     | ✅ built   | Next.js 15 frontend + thin BFF (Discord-style chat UI)                  | [design-system-frontend](../docs/30-modules/design-system-frontend.md), [chat-discord](../docs/30-modules/chat-discord.md) |
| `api`     | ✅ built   | Fastify 5 authoritative REST API, JWT verify, chat write path, webhooks | [architecture](../docs/10-architecture/architecture.md), [auth-identity](../docs/30-modules/auth-identity.md)              |
| `matcher` | ❌ Phase 2 | Fastify marketplace/node-matching + waitpoint completion                | [human-nodes-marketplace](../docs/30-modules/human-nodes-marketplace.md)                                                   |
| `agent`   | ❌ Phase 2 | Durable agent runtime executed as Trigger.dev v3 tasks                  | [ai-orchestrator](../docs/30-modules/ai-orchestrator.md)                                                                   |

> The Python reasoning core lives outside this folder, in `services/ai` ([ADR-0006](../docs/40-adr/0006-python-ai-service-node-backend.md)). Agent runs are currently started in-process by `apps/api`; `apps/agent` lands when durable orchestration does.

Any code added here must follow [AGENTS.md](../AGENTS.md) and update its owning module doc (`.docmeta.yml` enforces this in CI).
