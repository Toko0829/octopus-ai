# supabase/ — database & platform config (future)

> **No code yet.** Reserved for the Supabase project: migrations, RLS policies, seed data, and edge functions.

| Path          | Purpose                                             | Owner doc                                                                                                |
| ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `migrations/` | Schema + RLS migrations (Supabase CLI)              | [data-model](../docs/10-architecture/data-model.md)                                                      |
| `functions/`  | Edge functions (crawlers, webhooks, ingestion jobs) | [integrations](../docs/30-modules/integrations.md), [rag-knowledge](../docs/30-modules/rag-knowledge.md) |
| `seed/`       | Seed data (jurisdiction packs v1, dev fixtures)     | [rag-knowledge](../docs/30-modules/rag-knowledge.md)                                                     |

Key platform features used: Postgres 16 + **RLS**, **pgvector** ([ADR-0002](../docs/40-adr/0002-stay-in-postgres-pgvector.md)), GoTrue asymmetric JWT/JWKS, Storage, **Realtime Broadcast + Presence** ([ADR-0003](../docs/40-adr/0003-realtime-broadcast-not-postgres-changes.md)), `pg_cron`, Supavisor pooling. Every migration lands with its RLS policy + pgTAP test and updates [data-model](../docs/10-architecture/data-model.md).
