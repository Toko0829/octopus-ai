# supabase/ — database & platform config

> Live. `config.toml`, `seed.sql`, and **8 applied migrations** in `migrations/` covering identity, chat, security-definer hardening, table grants, profile co-member visibility, the Realtime presence policy, the RAG schema, and hybrid search. Bring up a local stack with `supabase start` (see [DEVELOPMENT.md](../DEVELOPMENT.md)).

| Path          | Status       | Purpose                                             | Owner doc                                                                                                |
| ------------- | ------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `migrations/` | ✅ 8 applied | Schema + RLS migrations (Supabase CLI)              | [data-model](../docs/10-architecture/data-model.md)                                                      |
| `seed.sql`    | ✅ present   | Dev fixtures                                        | [rag-knowledge](../docs/30-modules/rag-knowledge.md)                                                     |
| `functions/`  | ❌ pending   | Edge functions (crawlers, webhooks, ingestion jobs) | [integrations](../docs/30-modules/integrations.md), [rag-knowledge](../docs/30-modules/rag-knowledge.md) |

> The RAG corpus is **not** seeded from here. It is ingested by the Python service from `services/ai/corpus/` via `uv run --directory services/ai python -m octopus_ai.seed` ([rag-knowledge](../docs/30-modules/rag-knowledge.md)).
>
> Migration versions must match their filenames; if a tool stamps its own timestamp, correct `supabase_migrations.schema_migrations` afterwards or `supabase db push` will replay it.

Key platform features used: Postgres 16 + **RLS**, **pgvector** ([ADR-0002](../docs/40-adr/0002-stay-in-postgres-pgvector.md)), GoTrue asymmetric JWT/JWKS, Storage, **Realtime Broadcast + Presence** ([ADR-0003](../docs/40-adr/0003-realtime-broadcast-not-postgres-changes.md)), `pg_cron`, Supavisor pooling. Every migration lands with its RLS policy + pgTAP test and updates [data-model](../docs/10-architecture/data-model.md).
