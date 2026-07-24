# packages/ — shared libraries (future)

> **No code yet.** Reserved for the shared workspace packages. Full layout in [infra-devops.md](../docs/30-modules/infra-devops.md).

| Package | Purpose | Owner doc |
|---|---|---|
| `db` | Supabase migrations, RLS policies, generated types, query layer, pg-boss | [data-model](../docs/10-architecture/data-model.md) |
| `contracts` | Zod schemas + ts-rest/OpenAPI contract | [architecture](../docs/10-architecture/architecture.md) ([ADR-0004](../docs/40-adr/0004-tsrest-over-trpc.md)) |
| `core` | Domain logic (projects, tasks, escrow, room membership) | [business-projects-workflow](../docs/30-modules/business-projects-workflow.md) |
| `rag` | Chunking, embedding, hybrid pgvector retrieval, ingestion | [rag-knowledge](../docs/30-modules/rag-knowledge.md) |
| `agent-tools` | Zod-typed agent tools | [ai-orchestrator](../docs/30-modules/ai-orchestrator.md) |
| `realtime` | Chat transport abstraction (Broadcast now, WS later) | [chat-discord](../docs/30-modules/chat-discord.md) |
| `ui` | Shared React components / design system | [design-system-frontend](../docs/30-modules/design-system-frontend.md) |
| `observability` | OpenTelemetry, Sentry, LLM-trace wiring | [observability](../docs/10-architecture/observability.md) |
| `config` | eslint, tsconfig, env schema (Zod), constants | [infra-devops](../docs/30-modules/infra-devops.md) |
