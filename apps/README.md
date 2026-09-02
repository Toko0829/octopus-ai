# apps/ — application code

> `web` and `api` are built and running; `matcher` and `agent` are not created as separate apps, because the work each was planned for runs inside `apps/api` today (see below) and they split out when the ticker outgrows one process ([roadmap.md](../docs/10-architecture/roadmap.md)). Local setup and commands are in [DEVELOPMENT.md](../DEVELOPMENT.md).

See [infra-devops.md](../docs/30-modules/infra-devops.md) for the full intended monorepo layout.

| App       | Status           | Stack                                                                                                                                 | Doc                                                                                                                        |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `web`     | ✅ built         | Next.js 15 frontend + thin BFF (Discord-style chat UI)                                                                                | [design-system-frontend](../docs/30-modules/design-system-frontend.md), [chat-discord](../docs/30-modules/chat-discord.md) |
| `api`     | ✅ built         | Fastify 5 authoritative REST API, JWT verify, chat write path, webhooks                                                               | [architecture](../docs/10-architecture/architecture.md), [auth-identity](../docs/30-modules/auth-identity.md)              |
| `matcher` | ❌ not split out | Marketplace matching, the offer cascade, escrow reconcile and payouts all run as sweeps on the `apps/api` ticker today                | [human-nodes-marketplace](../docs/30-modules/human-nodes-marketplace.md)                                                   |
| `agent`   | ❌ not split out | The executor and the run lease live in `apps/api` on the Postgres runner ([ADR-0010](../docs/40-adr/0010-postgres-durable-runner.md)) | [ai-orchestrator](../docs/30-modules/ai-orchestrator.md)                                                                   |

> The Python reasoning core lives outside this folder, in `services/ai` ([ADR-0006](../docs/40-adr/0006-python-ai-service-node-backend.md)). Agent runs, the matcher and every sweep are started in-process by `apps/api`, which holds the durable backbone ([ADR-0010](../docs/40-adr/0010-postgres-durable-runner.md)); `apps/agent` and `apps/matcher` earn their own deployment when that ticker outgrows one process, not before.

Any code added here must follow [AGENTS.md](../AGENTS.md) and update its owning module doc (`.docmeta.yml` enforces this in CI).
