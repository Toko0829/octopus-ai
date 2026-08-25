# Data Model

> The canonical relational schema, RLS policy model, and entity relationships across all modules — the one place the full data picture is reconciled so module docs stay consistent. Update this doc for **any** schema/RLS/index change (it is the owner of `packages/db/migrations/**` and `supabase/migrations/**` in `.docmeta.yml`). Sketches below are indicative, not final DDL.
>
> **Implementation status (Phase 2, in progress):** `20260813120000_workflow_dag.sql` adds `projects`, `tasks`, `task_deps`, `task_runs` and the append-only `events` log, with the per-task **state machine enforced by trigger** and the DAG's acyclicity enforced by trigger. It also finally gives `rooms.project_id` the foreign key it has been missing since `20260728120000`, when there was no table to point at. `20260813130000_harden_workflow_functions.sql` follows it, for the reason recorded below. **Applied and verified against the live database: `supabase/tests/rls_workflow.sql`, 33/33.** See "Workflow schema" below.
>
> **Implementation status (Phase 1):** ten migrations applied. `20260812120000_action_embeds.sql` adds the interactive-card table (first component: `plan`) and `20260812120100_revoke_default_privileges.sql` closes the default grants described below. `20260724000000_init.sql` creates `profiles` + the `user_role` enum with RLS (own-row read/update) and a new-user trigger. `20260728120000_chat.sql` adds `rooms` / `channels` / `room_members` / `messages` — membership RLS, unique `idempotency_key`, identity `seq`, the `realtime.broadcast_changes()` insert trigger, and the Realtime subscribe policy on `realtime.messages`. `20260728160000_harden_security_definer.sql` relocates the policy helper to the `private` schema. `20260728170000_grant_table_privileges.sql` adds the table-level grants both earlier migrations omitted. `20260728190000_profile_co_member_visibility.sql` lets room members read each other's profile basics (own-row-only made the member list impossible). `20260728200000_realtime_presence_policy.sql` adds the `realtime.messages` INSERT policy that `channel.track()` needs. `20260728210000_rag_schema.sql` creates the RAG corpus (`knowledge_sources`, `documents`, `doc_chunks`, `eval_golden_set`) with `halfvec(1024)` + HNSW + generated `tsvector`, and `20260728220000_hybrid_search.sql` adds the RRF fusion function. Everything else below is still design-only.
>
> **`20260812140000_enable_pgtap.sql` was reconstructed from the database rather than written.** pgTAP had been installed ad hoc through a tool instead of through a file, so the extension existed and the repository had no record of it. Every suite in `supabase/tests/` calls `extensions.plan()`, so an environment built from these migrations alone would have failed all four on a missing function, and the symptom would have read as a broken test rather than a missing install. The body is byte-for-byte what was applied, recovered from `schema_migrations.statements`; only the header is new, and its version places it where it actually ran.
>
> **The same ad-hoc applies left the recorded versions drifted from the filenames**, which `supabase/README.md` warned about and which nothing checked. Six rows carried tool-generated timestamps, so `supabase db push` would have replayed five migrations that had already run. Corrected by matching on the `name` column, never on timing, and by `UPDATE` rather than delete-and-insert so `statements`, `created_by` and `idempotency_key` survive: the version was wrong, the record of what ran was not. The README now carries the two-command audit that detects it, because both halves look healthy in isolation and only the comparison shows the gap.

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

| Table                                 | Key columns                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rooms`                               | `id`, `project_id`, `kind` (guild/dm), `created_at`                                                                                                                                              |
| `room_members`                        | `room_id`, `user_id`, `role`, `scope` (room/thread), `joined_at`, `expires_at` (time-boxed node access)                                                                                          |
| `channels`                            | `id`, `room_id`, `name`, `kind` (text/topic), `position`                                                                                                                                         |
| `threads`                             | `id`, `channel_id`, `title`, `task_id?`                                                                                                                                                          |
| `messages`                            | `id`, `room_id`, `channel_id`, `thread_id?`, `author_id`, `author_kind` (user/agent/node/system), `body`, `idempotency_key` UNIQUE, `seq` (ordering cursor), `created_at`                        |
| `reactions`, `pins`, `saved_messages` | —                                                                                                                                                                                                |
| `action_embeds`                       | **live** (`20260812120000`) — `id`, `message_id` UNIQUE, `room_id`, `component` (plan/approval/pay/sign/assign), `payload` JSONB, `required_role`, `state`, `acted_by`, `acted_at`, `expires_at` |
| `presence`                            | ephemeral (Realtime Presence), not authoritative in Postgres                                                                                                                                     |

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

**Live as of `20260813120000`:** `projects`, `tasks`, `task_deps`, `task_runs`, and the append-only `events` log. `playbook_versions`, `agent_steps`, `tool_invocations`, `escalations` and `artifacts` remain design-only.

**`20260813160000` adds `artifacts`:** what a task produced, and the evidence the checker judges. Inline text in `body`, files in `storage_path`, and a **check constraint refusing a row with neither**, because an artifact with no content is a task that reported success and produced nothing. Deliberately not Storage-only yet: the sketch above has artifacts carrying a `storage_path`, which is right for a video edit and wrong for the only thing the AI produces today, and putting a paragraph of copy in object storage would mean a fetch to read it plus a bucket policy to get right. `task_runs` gains its purpose here too, since **each execution attempt is its own row** and a retry that overwrote the previous one would erase why the first failed.

**`20260813140000` adds `projects.source_embed_id` and `public.materialise_plan(uuid)`**, which is how rows first get written: approving a plan card creates the project and one task per step in one transaction. `source_embed_id` is unique, and that is the idempotency key rather than mere provenance: the approve route records the verdict before materialising, so without it a retry after a partial failure would build a second project from the same card. The function is `SECURITY INVOKER` in `public` (the only schema PostgREST can reach) with `EXECUTE` granted to `service_role` alone, which is what keeps it clear of lints 0028/0029 while staying callable by supabase-js. `task_deps` is deliberately left empty: the planner emits stages and steps, not dependencies, and deriving edges from stage order would invent a constraint nobody stated.

**`20260816120000` makes `risk_tier` and `acceptance_criteria` real, and the reason it had to is worth recording.** Both columns have existed since `20260813120000`, the first with a comment saying it is "carried on the task so the router can refuse to auto-run something irreversible without asking". `materialise_plan` wrote neither. So every task ever built from a plan card took the default `reversible`, and **the router's first rule, the one that overrides `owner_type` for high-risk work, has been unreachable since the day it shipped**. The rule was implemented, tested, and documented in three places; only its input was missing. That costs nothing while the only thing an AI task can do is write prose, and it stops costing nothing the moment a tool can spend or publish. `acceptance_criteria` is the same gap from the other side: the marketplace's maker-checker validates a node's proof against it.

The tier now travels on the plan card (`packages/contracts`), is proposed per step by the planner and raised in code where the step's own words commit to spending, publishing or connecting an account ([ai-orchestrator.md](../30-modules/ai-orchestrator.md)), and is written onto the row here. **Absent and unrecognised are handled differently on purpose.** A card written before the field existed has no tier, and absent means `reversible`, which is exactly what those cards already materialised as, so no old card breaks. A tier that is present and unrecognised raises `invalid_parameter_value`, mirroring the owner mapping beside it: a step whose tier we cannot read is not a step we may call safe. `acceptance_criteria` also has its default corrected from `'{}'` to `'[]'`, since every writer and reader wants a list and a shape mismatch nothing currently reads is the kind that survives until something depends on it.

Five things about that migration are load-bearing, and each is enforced in the database rather than in a caller:

- **Illegal state transitions are rejected, including for `service_role`.** `private.task_transition_allowed` encodes the machine from [business-projects-workflow.md](../30-modules/business-projects-workflow.md), applied by a `before update` trigger. A guard living only in the runner is a guard the next runner does not inherit, and [ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md) already documents changing runners. The trigger carries `when (old.state is distinct from new.state)`, without which every ordinary edit would be validated as a transition from a state to itself and rejected.
- **The DAG stays acyclic**, and edges cannot cross projects. Nothing in the word "DAG" enforces either. A cycle makes the scheduler's "are all hard deps done" question unanswerable, and the symptom is a project that never advances rather than an error anyone sees. A cross-project edge would let one tenant's graph block another's and break the project as a unit of cancellation.
- **The trigger that validates a transition also records it** into `events`. Recording from the caller instead gives an audit trail that is complete only while every caller remembers, which is not an audit trail.
- **`events` has no client read policy at all.** It gains a `project_id` the sketch above does not list, because an event with no tenant column can be exposed to nobody or to everybody and nothing in between. Today it is nobody: the audit-trail explorer is an admin-ops console (Phase 3), and what a member sees meanwhile is the human-readable projection in chat, exactly as [discord-chat-spec.md](../20-design/discord-chat-spec.md) specifies. Append-only by grant, and **`TRUNCATE` is revoked alongside `UPDATE` and `DELETE`**, because `grant all` includes it, it is not row-level, and it ignores RLS entirely. Same defect `20260812120100` closed for `anon`, arriving by a different door.
- **Every workflow table is client-readable and server-written.** No client `INSERT` or `UPDATE` anywhere. A client that could update `tasks` could mark its own task approved and unblock a payout, which is precisely the authorisation the design puts in tool code rather than in the caller.

**Membership is inherited, not re-derived.** `private.is_project_member` resolves a project through the rooms pointing at it, reusing the one membership definition rather than adding a second to keep in step. **Known narrowing, landing with threads:** [security-compliance.md](security-compliance.md) requires a node to see only its engaged task thread, time-boxed, and room-level membership is coarser than that. No node is admitted to any room today, so nothing is exposed by it now.

**A policy helper in `public` is an API endpoint, and this was learned twice.** `20260813120000` created `task_deps_satisfied` in `public` as `SECURITY DEFINER` with `EXECUTE` granted to `authenticated`, which published the scheduler's READY predicate at `/rest/v1/rpc/task_deps_satisfied`. That is advisor lint 0028/0029, **the same lint `20260728160000_harden_security_definer.sql` exists to clear**, reintroduced by someone who had read that migration. It repeats easily because it looks like ordinary least privilege: define a helper, grant it to the roles that need it. In Supabase, `public` is the API schema, so the grant is also a publication. `20260813130000` moved it to `private` and dropped it to `SECURITY INVOKER`, since unlike `is_room_member` it is never evaluated inside a policy and so never needed to bypass RLS. The same migration pinned `search_path` on the four workflow functions that lacked it (lint 0011); the two guard functions enforcing the state machine are precisely the wrong pair to leave resolvable through a caller's search path.

**And then the same migration locked the only writer out of the machine it enforces.** `20260813130000` hardened the workflow functions correctly and left `service_role` without EXECUTE on the guards' internals, so `private.guard_task_transition` fired, ran as the caller, and failed on its first line with `permission denied for function task_transition_allowed`. **Every write to `tasks.state` through the API was refused**, from the day that migration landed: plans materialised, their tasks sat `PENDING`, and each scheduler tick swept them and failed. `service_role` separately had no USAGE on `private` at all, so the public wrappers over `tasks_ready` failed too. Closed by `20260815190000` (schema USAGE) and `20260815200000`, which makes both guards **SECURITY DEFINER** rather than granting EXECUTE to the caller: a guard meant to bind trusted code must not depend on trusted code holding privileges on its private parts, and granting per-role would leave the same trap for the next writer.

**Neither was visible to anything but running the product.** `rls_workflow.sql` asserts the machine **as `postgres`**, deliberately and correctly, which is exactly why it is blind here, since `postgres` owns these functions: the suite proved the machine works and could not prove anyone could reach it. A missing grant is not a lint, so the advisor was silent too.

**The 33 assertions passed before those six lints existed.** A pgTAP suite asserts the properties somebody thought to assert; the advisor checks the ones everybody forgets. Run `get_advisors` after every migration, not just the tests.

**`task_deps_satisfied` is the scheduler's READY predicate**, and two of its choices are deliberate. Only **hard** deps block, since soft is an ordering preference and resource a shared-constraint hint, and treating either as blocking would stall a graph that is progressing perfectly well. And a dependency counts as satisfied at **`approved`**, not `done`: a dependent step can start once the work it needed is accepted, where waiting for `paid` would hold the whole graph on a bank transfer.

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
- **A grant you did not write is still a grant, and `TRUNCATE` ignores RLS.** Verifying the grants on `action_embeds` turned up Supabase's default privileges on **every** table in `public`: `REFERENCES, TRIGGER, TRUNCATE` for `anon`, and `TRUNCATE` for `authenticated`. RLS filters rows a grant already permits, but `TRUNCATE` is not row-level and bypasses policies entirely, so a role holding it can empty a table whatever the policies say. `anon` held it on `messages`, `rooms` and the whole RAG corpus, directly contradicting `20260728170000`'s stated "anon gets nothing". Not remotely exploitable, since PostgREST exposes no `TRUNCATE` verb, and closed anyway in `20260812120100` because a privilege that cannot be justified should not be held. The durable half of that fix is the `alter default privileges` at its end: without it the cleanup decays the next time anyone adds a table. Note this contradicts the earlier migration's comment that the defaults "did not fire" — they fire for tables created through other paths.

- **`20260815120000` adds the `question` card and a state for it.** `embed_component` gains `question`, which [discord-chat-spec.md](../20-design/discord-chat-spec.md) has specified since Phase 0 and which nothing produced until intake did. `embed_state` gains **`answered`**, and that is the part worth reading. The four original states describe a **verdict**: someone said yes, someone said no, or the window closed. A question has none. Recording an answered question as `approved` would put an untrue sentence in the audit trail, and `feedback_events.subject` reads embed state as a training label, so it would also manufacture a labelled example of a person approving something they were never shown. `expired` is equally wrong: it means nobody acted, which is the one outcome this is not. No policy or grant changes, because the card needs exactly what `action_embeds` already gives it, client-readable through room membership and server-written.

- **`rooms.owner_id` exists because `required_role` needed something to check.** `action_embeds` carries `required_role = 'owner'`, and nothing could evaluate it: `room_members.role` is the platform role enum (`user` / `human_node` / `admin`), not a statement of ownership, and every member carries `user`. Without the column the check would have been nominal, written down and enforced by nothing. Added in `20260812130000`, backfilled from the earliest member (which is the creator, since `POST /api/rooms` inserts the caller immediately after creating the room) and set explicitly on creation thereafter, because "earliest member" is a heuristic while the creator is a fact known at the time. Nullable on purpose: a null owner means nobody can approve, which is the safe default rather than the permissive one.

- **`feedback_events` is append-only by grant** (`20260812130000`). Flywheel v0: every approve / request-changes is a labelled example of a human accepting or rejecting AI output, and the correction rate derived from it is the metric that says whether the AI is learning the vertical ([learning-flywheel.md](learning-flywheel.md)). No client role gets `UPDATE` or `DELETE`, because a training signal that can be rewritten after the fact is not evidence. `subject` denormalises the judged payload deliberately: the embed's state changes after the verdict, and a label must describe what was actually judged rather than what the row looks like later.

- **`action_embeds` is client-readable and server-written.** Membership is inherited from the message's room via `private.is_room_member`, so an embed can never be visible to someone who cannot see the message it belongs to. There is deliberately **no client INSERT or UPDATE policy**: a client that could insert here could fabricate an approval card, and one that could update freely could approve on another member's behalf. Acting on an embed goes through an API route that re-checks `required_role`, because a rule enforced only in the UI is not enforced. `unique (message_id)` keeps it one card per message, since two cards on one utterance have no defined render order.

- **`ensure_rls` event trigger (environment, not repo):** the Supabase project carries a pre-existing event trigger backed by `public.rls_auto_enable()` that auto-enables RLS on any new `public` table. Treat it as a backstop only — always declare `enable row level security` in the migration itself, because the event trigger lives in no migration and is **not** recreated by a local `supabase db reset`.
- **Hardest surface:** dynamic group-chat membership (user + AI + multiple nodes, different roles, time-boxed). Covered by **pgTAP** tests — see [security-compliance.md](security-compliance.md).

## Audit & event-sourcing

- `events` is an append-only table: `(id, actor_id, actor_kind, verb, subject_type, subject_id, payload JSONB, created_at)`.
- Task transitions, tool calls, escalations, approvals, and money movements all emit events. Immutability is enforced (no `UPDATE`/`DELETE` grants; append-only).

## Migration conventions

- Migrations live in `packages/db/migrations/**` (authored) and are applied via the Supabase CLI (`supabase/migrations/**`).
- One concern per migration; RLS policy + pgTAP test land **with** the table.
- Any change here requires updating this doc (owner in `.docmeta.yml`) and, if it changes tenant isolation, [security-compliance.md](security-compliance.md).
