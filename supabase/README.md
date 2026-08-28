# supabase/ — database & platform config

> Live. `config.toml`, `seed.sql`, and **31 applied migrations** in `migrations/` covering identity, chat, security-definer hardening, table grants, profile co-member visibility, the Realtime presence policy, the RAG schema, hybrid search, action embeds, the default-privilege cleanup, room ownership + the flywheel table, the pgTAP install reconstructed from the database, the workflow DAG, the workflow-function hardening, plan materialisation, the scheduler's selection query, artifacts, the question card, run leases, the ticker claim, the two that unlocked the scheduler (schema usage for `service_role`, and making the guards run as owner), the artifact card, the arc that lets an answered step finish, the `answer` artifact kind, the per-step risk tier + acceptance criteria, room sources, the two that let the corpus hold crawled pages (a per-document `source_url`, and the in-force narrowing of `documents_source_hash_idx`), the one that lets a room hold more than one visible project, and the two arcs that let an owner unstick an escalated step. Bring up a local stack with `supabase start` (see [DEVELOPMENT.md](../DEVELOPMENT.md)).
>
> **`20260827110000_project_membership_via_card.sql` is the one to read if you only read one.** `private.is_project_member` resolved a project to its room through `rooms.project_id`, a column `materialise_plan` writes once, so the first plan approved in a room claimed it and **every project after that was invisible to every client, including its owner**. Measured before the fix: 6 projects with 3 reachable, 47 tasks and 28 of 58 artifacts unreachable. It failed as zero rows and never as an error, which through PostgREST is indistinguishable from an empty project, so nothing caught it. The same wrong question had already been fixed in the delivery path two weeks earlier and was left standing in the policy.
>
> **`20260815120000_question_embeds.sql` is worth reading for how it failed before it was applied**, because the symptom appeared nowhere near the cause. It adds the `question` component and the `answered` state that intake needs. Without them intake did not merely lose its card, it **did not run at all**: the agent run's first act is to read any open question card, that read filters on `component = 'question'`, and Postgres rejects a comparison against an enum value that does not exist. The run caught it, logged `intake state unreadable, planning anyway`, and planned on the raw message. The degradation is deliberate, since an optional clarification step must not break a working path, but it means the only visible evidence was a planner refusal with no sign intake had been involved. Observed live: "Hello" came back as `refusing-ungrounded-v1`.
>
> `alter type ... add value` is **not reversible**: a Postgres enum value cannot be dropped.

| Path          | Status        | Purpose                                             | Owner doc                                                                                                |
| ------------- | ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `migrations/` | ✅ 31 applied | Schema + RLS migrations (Supabase CLI)              | [data-model](../docs/10-architecture/data-model.md)                                                      |
| `seed.sql`    | ✅ present    | Dev fixtures                                        | [rag-knowledge](../docs/30-modules/rag-knowledge.md)                                                     |
| `functions/`  | ❌ pending    | Edge functions (crawlers, webhooks, ingestion jobs) | [integrations](../docs/30-modules/integrations.md), [rag-knowledge](../docs/30-modules/rag-knowledge.md) |

> The RAG corpus is **not** seeded from here. It is ingested by the Python service from `services/ai/corpus/` via `uv run --directory services/ai python -m octopus_ai.seed` ([rag-knowledge](../docs/30-modules/rag-knowledge.md)).
>
> Migration versions must match their filenames; if a tool stamps its own timestamp, correct `supabase_migrations.schema_migrations` afterwards or `supabase db push` will replay it.
>
> **This warning was not enough, and the audit that catches it is two commands.** Six recorded versions had drifted from their filenames, so `supabase db push` would have replayed five migrations that had already run. The drift is invisible until you compare the two lists, because both halves look healthy on their own: every migration had in fact been applied, and every file was in fact in the repository. Compare them, matching on the `name` column rather than on timing:
>
> ```bash
> psql "$DATABASE_URL" -tAc "select version from supabase_migrations.schema_migrations order by version" | tr -d '\r' > /tmp/db.txt
> ls supabase/migrations/*.sql | sed -E 's#.*/([0-9]+)_.*#\1#' | sort > /tmp/repo.txt
> comm -3 /tmp/repo.txt /tmp/db.txt
> ```
>
> Anything printed is drift. Left column: in the repo, not recorded, so `db push` will try to replay it. Right column: recorded under a version no file has, which is what a tool-stamped apply leaves behind. Run it after applying anything through the MCP tool or the dashboard.

Key platform features used: Postgres 16 + **RLS**, **pgvector** ([ADR-0002](../docs/40-adr/0002-stay-in-postgres-pgvector.md)), GoTrue asymmetric JWT/JWKS, Storage, **Realtime Broadcast + Presence** ([ADR-0003](../docs/40-adr/0003-realtime-broadcast-not-postgres-changes.md)), `pg_cron`, Supavisor pooling. Every migration lands with its RLS policy + pgTAP test and updates [data-model](../docs/10-architecture/data-model.md).

## RLS tests (pgTAP)

`tests/rls_membership.sql` covers the surface [security-compliance.md](../docs/10-architecture/security-compliance.md) calls the hardest: a room shared by an owner, an unexpired node, an expired node, and an outsider.

`tests/rls_workflow.sql` covers the workflow DAG: the same four actors against `projects` / `tasks` / `task_deps` / `task_runs`, plus the two triggers. It runs the state-machine and acyclicity assertions **as `postgres` on purpose**, which is the opposite of the rule for the RLS assertions and for the same underlying reason. RLS must be tested as a client because `postgres` bypasses it; these guards must be tested as `postgres` because they are supposed to bind trusted code too. If they ever start passing merely because the caller was privileged, the guard has been lost.

```bash
DATABASE_URL="postgresql://..." ./scripts/test-rls.sh
```

The script runs **every** `.sql` in `tests/`, rather than a hardcoded list, and does not stop at the first failing suite: a new suite that must be registered in two places is one that eventually runs in neither, and knowing whether a break is narrow or broad is most of the diagnosis.

`tests/materialise_plan.sql` covers turning an approved card into a project and its tasks. Its most useful assertions are the failure ones: every path that raises is also checked for **leaving nothing behind**, because atomicity is the reason that logic is one database function rather than a sequence of supabase-js calls.

`tests/artifacts.sql` covers the execution path. It asserts that the state machine **accepts the exact route the executor walks** (`ROUTING → AI_RUNNING → AI_SELF_CHECK → APPROVED`, plus the bounded re-do back to `AI_RUNNING`), which is much cheaper to discover here than at `ai_running` on a live project. Also that an artifact with neither body nor file is refused, and that a retry cannot overwrite the attempt it is retrying.

`tests/project_membership.sql` covers the one that was actually broken: a room's **second** project. It asserts both directions deliberately, because the predicate it guards failed by returning nothing, and a version rewritten to return everything would pass any suite that only checks what the owner can see.

Everything runs inside a transaction that `ROLLBACK`s, so it is safe against a live database and leaves no fixtures behind. Verified green against the live database: `rls_membership.sql` 22/22, `rls_workflow.sql` 33/33, `materialise_plan.sql` 19/19, `artifacts.sql` 12/12, `room_sources.sql` 14/14, `document_supersession.sql` 9/9, `project_membership.sql` 13/13.

> **A fixture can fail an assertion that the code passes, and this suite did.** Its first draft pointed one room's `project_id` at the first project and then asserted that a third, card-less project was visible through that same column. A room has one `project_id`; it cannot point at two projects. Two assertions failed and briefly looked like a defect in the migration. Give each legacy-link case its own room.

> **A trap worth knowing when writing these.** Calling a function that inserts, from inside the `WHERE` clause of a select against the table it inserts into, returns NULL: the statement's snapshot is taken before it runs, so the new row is invisible to that same scan. It reads as the function returning nothing. Materialise into a temporary table first, then assert against it.

> **Run the advisors after any migration, not just the tests.** `20260813120000` passed all 33 assertions and still introduced six security lints, because the suite asserts the properties someone thought to assert and the advisor checks the ones everybody forgets. The worst of them was `task_deps_satisfied` being created in `public` as `SECURITY DEFINER` with EXECUTE granted to `authenticated`, which published the scheduler's READY predicate at `/rest/v1/rpc/`. That is lint 0028/0029, **the same one `20260728160000_harden_security_definer.sql` exists to clear**, reintroduced by someone who had read that migration. It looks like ordinary least privilege, and in Supabase `public` is the API schema. `20260813130000` moved the function to `private`, dropped it to `SECURITY INVOKER` (it is not used in a policy, so it never needed to bypass RLS), and pinned `search_path` on the four workflow functions that lacked it.

Two things it asserts that are easy to lose:

- **An expired node sees nothing at all.** Not the room, not the messages, not the plan card. Time-boxed access is the mechanism the whole marketplace depends on, and until this file existed the only evidence it worked was that nothing had visibly leaked.
- **Privileges, not only policies.** RLS filters rows a grant already permits, so a missing policy and a missing grant fail very differently. `TRUNCATE` is asserted explicitly because it **bypasses RLS entirely**, which is what made the default-privilege grant closed in `20260812120100` worth closing.

Tests run as `authenticated` with `request.jwt.claims` set, exactly as PostgREST would. Running them as `postgres` would prove nothing: that role bypasses RLS, which is precisely how a policy bug survives review.
