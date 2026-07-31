# Data Model

> The canonical relational schema, RLS policy model, and entity relationships across all modules — the one place the full data picture is reconciled so module docs stay consistent. Update this doc for **any** schema/RLS/index change (it is the owner of `packages/db/migrations/**` and `supabase/migrations/**` in `.docmeta.yml`). Sketches below are indicative, not final DDL.
>
> **Implementation status (Phase 1):** three migrations applied. `20260724000000_init.sql` creates `profiles` + the `user_role` enum with RLS (own-row read/update) and a new-user trigger. `20260728120000_chat.sql` adds `rooms` / `channels` / `room_members` / `messages` — membership RLS, unique `idempotency_key`, identity `seq`, the `realtime.broadcast_changes()` insert trigger, and the Realtime subscribe policy on `realtime.messages`. `20260728160000_harden_security_definer.sql` relocates the policy helper to the `private` schema. `20260728170000_grant_table_privileges.sql` adds the table-level grants both earlier migrations omitted. `20260728190000_profile_co_member_visibility.sql` lets room members read each other's profile basics (own-row-only made the member list impossible). `20260728200000_realtime_presence_policy.sql` adds the `realtime.messages` INSERT policy that `channel.track()` needs. `20260728210000_rag_schema.sql` creates the RAG corpus (`knowledge_sources`, `documents`, `doc_chunks`, `eval_golden_set`) with `halfvec(1024)` + HNSW + generated `tsvector`, and `20260728220000_hybrid_search.sql` adds the RRF fusion function. Everything else below is still design-only.

## ERD overview (domains)

```
Identity      users ─1:1─ profiles ─*─ node_profiles ─*─ node_skills/credentials
Chat          rooms ─*─ channels ─*─ threads ─*─ messages ─*─ reactions
              rooms ─*─ room_members (user_id, role)          messages ─*─ action_embeds
Workflow      projects ─*─ tasks ─*─ task_deps (DAG)   tasks ─*─ task_runs ─*─ agent_steps
              tasks ─*─ artifacts   tasks ─*─ escalations   projects ─*─ playbook_versions
Marketplace   node_profiles ─*─ offers ─*─ engagements ─*─ proof_artifacts ─*─ ratings/disputes
Payments      escrow_holds ─*─ ledger_entries (double-entry) ─*─ payouts   users ─*─ subscriptions
Knowledge     documents ─*─ doc_chunks (halfvec + tsvector)   knowledge_sources   suppliers   cost_benchmarks
Audit         events (append-only, event-sourced)   notifications   delivery_log   ops_actions
```

## Identity & tenancy

- `users` (Supabase `auth.users`) → `profiles(user_id PK/FK, display_name, role, jurisdiction, languages[], created_at)`.
- **Roles:** `user` | `human_node` | `verified_pro` | `admin` | `ops` — carried as a JWT claim **and** in `profiles.role` (the DB backstop).
- Tenancy scoping is **project- and room-membership based** (not a single `org_id` column) so a user, the AI, and multiple nodes can share a room with different privileges.

## Chat schema

| Table                                 | Key columns                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rooms`                               | `id`, `project_id`, `kind` (guild/dm), `created_at`                                                                                                                       |
| `room_members`                        | `room_id`, `user_id`, `role`, `scope` (room/thread), `joined_at`, `expires_at` (time-boxed node access)                                                                   |
| `channels`                            | `id`, `room_id`, `name`, `kind` (text/topic), `position`                                                                                                                  |
| `threads`                             | `id`, `channel_id`, `title`, `task_id?`                                                                                                                                   |
| `messages`                            | `id`, `room_id`, `channel_id`, `thread_id?`, `author_id`, `author_kind` (user/agent/node/system), `body`, `idempotency_key` UNIQUE, `seq` (ordering cursor), `created_at` |
| `reactions`, `pins`, `saved_messages` | —                                                                                                                                                                         |
| `action_embeds`                       | `id`, `message_id`, `component` (approve/pay/sign/assign/accept), `payload` JSONB, `required_role`, `state`, `expires_at`                                                 |
| `presence`                            | ephemeral (Realtime Presence), not authoritative in Postgres                                                                                                              |

- **Write path:** Fastify inserts the message (with `idempotency_key`, `seq`); a trigger broadcasts it. The AI is `author_kind='agent'`.

## Workflow schema

| Table               | Key columns                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`          | `id`, `owner_id`, `goal`, `status` (DRAFT/PLANNING/ACTIVE/PAUSED/COMPLETED/CANCELLED), `budget_ceiling`, `jurisdiction`, `archetype`, `created_at`                                                          |
| `playbook_versions` | `id`, `project_id`, `archetype`, `jurisdiction_pack`, `compiled_dag` JSONB, `version`                                                                                                                       |
| `tasks`             | `id`, `project_id`, `title`, `owner_type` (AI/HUMAN/USER), `state` (see state model), `acceptance_criteria` JSONB, `risk_tier`, `inputs` JSONB, `expected_artifact`, `cost_estimate`, `jurisdiction_refs[]` |
| `task_deps`         | `task_id`, `depends_on_task_id`, `dep_kind` (hard/soft/resource)                                                                                                                                            |
| `task_runs`         | `id`, `task_id`, `agent_run_id`, `status`, `attempt`, `started_at`, `ended_at`                                                                                                                              |
| `agent_steps`       | `id`, `task_run_id`, `kind`, `input`, `output`, `confidence`, `created_at` (event-sourced)                                                                                                                  |
| `tool_invocations`  | `id`, `agent_step_id`, `tool`, `args`, `idempotency_key` UNIQUE, `result`, `risk_tier`                                                                                                                      |
| `escalations`       | `id`, `task_id`, `trigger`, `target` (HUMAN/USER), `created_at`, `resolved_at`                                                                                                                              |
| `artifacts`         | `id`, `task_id`, `storage_path`, `kind`, `checksum`, `created_by`                                                                                                                                           |

## Marketplace schema

| Table                 | Key columns                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `node_profiles`       | `user_id`, `kyc_status`, `trust_score`, `service_geo` (PostGIS), `rate`, `availability`, `languages[]` |
| `node_skills`         | `node_id`, `skill_tag`, `verified`                                                                     |
| `credentials`         | `node_id`, `type` (lawyer/accountant/notary), `verified`, `evidence_path`, `expires_at`                |
| `offers`              | `id`, `task_id`, `node_id`, `scope`, `escrow_price`, `deadline`, `status`, `expires_at`                |
| `engagements`         | `id`, `task_id`, `node_id`, `state` (CLAIMED→…→PAID), `nda_signed_at`                                  |
| `proof_artifacts`     | `id`, `engagement_id`, `storage_path`, `exif` JSONB, `verified`                                        |
| `ratings`, `disputes` | two-sided ratings; dispute state + audit link                                                          |

## Payments schema

| Table                       | Key columns                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `escrow_holds`              | `id`, `task_id`, `charge_id`, `amount`, `currency`, `state` (HELD/RELEASED/REFUNDED), `idempotency_key` UNIQUE   |
| `ledger_entries`            | `id`, `account`, `debit`, `credit`, `currency`, `ref_type`, `ref_id`, `created_at` — **double-entry, immutable** |
| `payouts`                   | `id`, `node_id`, `transfer_id`, `amount`, `platform_fee`, `state`, `idempotency_key` UNIQUE                      |
| `subscriptions`             | `id`, `user_id`, `tier`, `status`, `current_period_end`                                                          |
| `platform_fees`, `invoices` | —                                                                                                                |

- Money movements are **idempotent** (unique `idempotency_key`) and **event-sourced**; the ledger is append-only.

## RAG schema

| Table                          | Key columns                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_sources`            | `id`, `url`, `authority`, `crawl_cadence`, `last_crawled`, `content_hash`                                                                                |
| `documents`                    | `id`, `source_id`, `jurisdiction`, `business_type`, `doc_type`, `effective_date`, `valid_from`, `valid_to`, `content_hash`, `version`, `lang`            |
| `doc_chunks`                   | `id`, `document_id`, `parent_id`, `chunk_text`, `context_prefix`, `embedding halfvec(1024)`, `fts tsvector` (generated), `metadata` JSONB, `embed_model` |
| `suppliers`, `cost_benchmarks` | **typed rows**, not prose chunks (structured retrieval)                                                                                                  |
| `eval_golden_set`              | `id`, `query`, `expected`, `jurisdiction`                                                                                                                |

**Indexes:** HNSW on `doc_chunks.embedding` (`halfvec_cosine_ops`, `m=16`, `ef_construction=200`), GIN on `fts`, partial btree on filter columns (`market`, `business_type`, `doc_type`) and on `(valid_from, valid_to)`.

Details worth knowing before touching this schema:

- **`fts` is a generated column with a per-row language.** `to_tsvector(regconfig, text)` is `IMMUTABLE` (unlike the single-argument form), which is what allows the config to come from the row's own `lang` column. That keeps sparse retrieval multilingual with no trigger to maintain.
- **`doc_chunks.owner_project_id` is denormalised** from `documents` by a trigger. It exists so the tenant predicate on the hot retrieval path is a plain column test rather than a join or a per-row function call. Never write it from application code.
- **Tenant-scoped rows are denied to clients, not guessed at.** `owner_project_id is null` (the shared reference corpus) is all `authenticated` may read. There is no projects/membership table yet, so there is nothing to check ownership against, and defaulting to visible would be a leak waiting for the flywheel to populate that column. Widen the policy in the same migration that adds projects.
- **`hnsw.ef_search` and `hnsw.iterative_scan` are set at runtime** inside `hybrid_search` via `set_config(..., is_local => true)`, not in the function's `SET` clause. Postgres validates that clause at `CREATE` time and `postgres` is not superuser on Supabase, so the clause form fails with "permission denied to set parameter". `iterative_scan` matters specifically because retrieval applies hard filters: without it the HNSW scan returns its k nearest and the `WHERE` then discards most of them, silently under-filling the candidate list.

## RLS policy model

- **Every table is RLS-on.** Access is derived from **membership**, not a bare `user_id = auth.uid()`:
  - Chat: a row in `room_members` (respecting `scope` and `expires_at`) gates `messages`/`channels`/`threads`.
  - Workflow/marketplace/payments: membership/ownership of the parent `project` (owner, assigned node for the task, ops).
- **`service_role`** is used only by trusted server code (`matcher`, payments, agent system-writes) and **never reaches the client**.
- Fastify forwards the user token or sets `request.jwt.claims` via `set_config()` so `auth.uid()`/`auth.jwt()` work inside policies.
- **RLS is not a grant — every migration must issue both.** A policy only filters rows the role already has table-level permission to touch. `init` and `chat` both shipped correct policies with **no** `GRANT`, which made every table return `permission denied` to PostgREST rather than an empty result; `20260728170000_grant_table_privileges.sql` repaired it. Supabase's default-privilege grants did **not** fire for migrations applied this way, so do not rely on them. Grant least-privilege verbs that mirror the policies (`authenticated` gets `select, insert` on `messages` and no `update`/`delete`, so a client cannot rewrite the audit trail), and `all` to `service_role` for trusted server writes.
- **Policy helpers live in the `private` schema, never `public`.** A membership helper has to be `SECURITY DEFINER` (otherwise checking `room_members` from a policy _on_ `room_members` recurses) **and** has to keep its `EXECUTE` grant, because policy expressions are evaluated as the _querying_ role — revoking it breaks every policy that calls it. In `public` that combination publishes the helper at `/rest/v1/rpc/`; a schema PostgREST does not expose does not. `private.is_room_member(uuid)` is the reference case.
- **`ensure_rls` event trigger (environment, not repo):** the Supabase project carries a pre-existing event trigger backed by `public.rls_auto_enable()` that auto-enables RLS on any new `public` table. Treat it as a backstop only — always declare `enable row level security` in the migration itself, because the event trigger lives in no migration and is **not** recreated by a local `supabase db reset`.
- **Hardest surface:** dynamic group-chat membership (user + AI + multiple nodes, different roles, time-boxed). Covered by **pgTAP** tests — see [security-compliance.md](security-compliance.md).

## Audit & event-sourcing

- `events` is an append-only table: `(id, actor_id, actor_kind, verb, subject_type, subject_id, payload JSONB, created_at)`.
- Task transitions, tool calls, escalations, approvals, and money movements all emit events. Immutability is enforced (no `UPDATE`/`DELETE` grants; append-only).

## Migration conventions

- Migrations live in `packages/db/migrations/**` (authored) and are applied via the Supabase CLI (`supabase/migrations/**`).
- One concern per migration; RLS policy + pgTAP test land **with** the table.
- Any change here requires updating this doc (owner in `.docmeta.yml`) and, if it changes tenant isolation, [security-compliance.md](security-compliance.md).
