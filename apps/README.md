# apps/ — application code (future)

> **No code yet.** This documentation pass establishes the source of truth first. This folder is where the runnable applications will live once Phase 0 begins ([roadmap.md](../docs/10-architecture/roadmap.md)).

Planned apps (see [infra-devops.md](../docs/30-modules/infra-devops.md) for the full monorepo layout):

| App | Stack | Doc |
|---|---|---|
| `web` | Next.js 15 frontend + thin BFF (Discord-style chat UI) | [design-system-frontend](../docs/30-modules/design-system-frontend.md), [chat-discord](../docs/30-modules/chat-discord.md) |
| `api` | Fastify 5 authoritative REST API, JWT verify, chat write path, webhooks | [architecture](../docs/10-architecture/architecture.md), [auth-identity](../docs/30-modules/auth-identity.md) |
| `matcher` | Fastify marketplace/node-matching + waitpoint completion | [human-nodes-marketplace](../docs/30-modules/human-nodes-marketplace.md) |
| `agent` | Agent runtime (AI SDK loop) executed as Trigger.dev v3 tasks | [ai-orchestrator](../docs/30-modules/ai-orchestrator.md) |

Any code added here must follow [AGENTS.md](../AGENTS.md) and update its owning module doc (`.docmeta.yml` enforces this in CI).
