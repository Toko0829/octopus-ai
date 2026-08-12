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

## RLS tests (pgTAP)

`tests/rls_membership.sql` covers the surface [security-compliance.md](../docs/10-architecture/security-compliance.md) calls the hardest: a room shared by an owner, an unexpired node, an expired node, and an outsider.

```bash
DATABASE_URL="postgresql://..." ./scripts/test-rls.sh
```

Everything runs inside a transaction that `ROLLBACK`s, so it is safe against a live database and leaves no fixtures behind. Verified 22/22.

Two things it asserts that are easy to lose:

- **An expired node sees nothing at all.** Not the room, not the messages, not the plan card. Time-boxed access is the mechanism the whole marketplace depends on, and until this file existed the only evidence it worked was that nothing had visibly leaked.
- **Privileges, not only policies.** RLS filters rows a grant already permits, so a missing policy and a missing grant fail very differently. `TRUNCATE` is asserted explicitly because it **bypasses RLS entirely**, which is what made the default-privilege grant closed in `20260812120100` worth closing.

Tests run as `authenticated` with `request.jwt.claims` set, exactly as PostgREST would. Running them as `postgres` would prove nothing: that role bypasses RLS, which is precisely how a policy bug survives review.
