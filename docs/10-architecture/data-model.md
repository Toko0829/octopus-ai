# Data Model

> The canonical relational schema, RLS policy model, and entity relationships across all modules — the one place the full data picture is reconciled so module docs stay consistent. Update this doc for **any** schema/RLS/index change (it is the owner of `packages/db/migrations/**` and `supabase/migrations/**` in `.docmeta.yml`). Sketches below are indicative, not final DDL.
>
> **Implementation status (Phase 2, in progress):** `20260813120000_workflow_dag.sql` adds `projects`, `tasks`, `task_deps`, `task_runs` and the append-only `events` log, with the per-task **state machine enforced by trigger** and the DAG's acyclicity enforced by trigger. It also finally gives `rooms.project_id` the foreign key it has been missing since `20260728120000`, when there was no table to point at. `20260813130000_harden_workflow_functions.sql` follows it, for the reason recorded below. **Applied and verified against the live database: `supabase/tests/rls_workflow.sql`, 33/33.** See "Workflow schema" below.
>
> **Implementation status (Phase 1), kept as the record of what landed then:** ten migrations. `20260812120000_action_embeds.sql` adds the interactive-card table (first component: `plan`) and `20260812120100_revoke_default_privileges.sql` closes the default grants described below. `20260724000000_init.sql` creates `profiles` + the `user_role` enum with RLS (own-row read/update) and a new-user trigger. `20260728120000_chat.sql` adds `rooms` / `channels` / `room_members` / `messages` — membership RLS, unique `idempotency_key`, identity `seq`, the `realtime.broadcast_changes()` insert trigger, and the Realtime subscribe policy on `realtime.messages`. `20260728160000_harden_security_definer.sql` relocates the policy helper to the `private` schema. `20260728170000_grant_table_privileges.sql` adds the table-level grants both earlier migrations omitted. `20260728190000_profile_co_member_visibility.sql` lets room members read each other's profile basics (own-row-only made the member list impossible). `20260728200000_realtime_presence_policy.sql` adds the `realtime.messages` INSERT policy that `channel.track()` needs. `20260728210000_rag_schema.sql` creates the RAG corpus (`knowledge_sources`, `documents`, `doc_chunks`, `eval_golden_set`) with `halfvec(1024)` + HNSW + generated `tsvector`, and `20260728220000_hybrid_search.sql` adds the RRF fusion function. Everything below that these two blocks do not name was still design-only at that point; **31 migrations are applied now**, and `supabase/README.md` carries the audit that catches a recorded version drifting from its filename.
>
> **`20260812140000_enable_pgtap.sql` was reconstructed from the database rather than written.** pgTAP had been installed ad hoc through a tool instead of through a file, so the extension existed and the repository had no record of it. Every suite in `supabase/tests/` calls `extensions.plan()`, so an environment built from these migrations alone would have failed all four on a missing function, and the symptom would have read as a broken test rather than a missing install. The body is byte-for-byte what was applied, recovered from `schema_migrations.statements`; only the header is new, and its version places it where it actually ran.
>
> **The same ad-hoc applies left the recorded versions drifted from the filenames**, which `supabase/README.md` warned about and which nothing checked. Six rows carried tool-generated timestamps, so `supabase db push` would have replayed five migrations that had already run. Corrected by matching on the `name` column, never on timing, and by `UPDATE` rather than delete-and-insert so `statements`, `created_by` and `idempotency_key` survive: the version was wrong, the record of what ran was not. The README now carries the two-command audit that detects it, because both halves look healthy in isolation and only the comparison shows the gap.

### The marketing domain gets its first writer (`20260829130000`, `20260829140000`)

Four marketing tables landed with their guards and **no writer at all**, which was
deliberate and is now resolved for the first of them. `embed_component` gains
`campaign`, in its own migration so the value is never used in the transaction
that adds it (the rule `20260828130000` records), and `public.materialise_campaign(uuid)`
turns an approved campaign card into exactly one `campaigns` row at state `ready`.

**It is the third sibling of `materialise_plan` and `apply_plan_diff`**, sharing
all four of their properties: one transaction, the payload read from the card
rather than taken as arguments, idempotent by its own provenance
(`campaigns.source_embed_id`, unique, declared for this at `20260829120000:87`),
and unknown values raise. Same attributes too: `security invoker` in `public` with
`EXECUTE` granted to `service_role` alone, `search_path` pinned, which is what
keeps it clear of lints 0011, 0028 and 0029.

**What is new is a spend check, and it exists twice on purpose.** The approval
route runs `checkSpendCap` before recording the verdict, which is the readable
refusal; this function runs the same arithmetic again under
`select budget_ceiling ... for update`. Two cards approved in the same instant
both pass a check made in the API, because each reads the committed total before
either writes, and the result would be a sum of authorised caps exceeding the
ceiling **inside the table whose whole purpose is recording what was authorised**.
The duplication, its mitigation and the alternatives are argued in
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md). This does not contradict
"the spend cap is enforced in tool code, not by a constraint" below: that forbids
a CHECK constraint, and this is the transactional arm of the tool.

**The insert audits itself, because the trigger cannot.** `campaigns_guard_transition`
fires `before update ... when (old.state is distinct from new.state)`, so a row
created at `ready` writes no `campaign.transitioned` event. Without an explicit
one, the authorisation of money would be the only act in this domain with no
event, and `campaign.transitioned` would first appear when a campaign left a state
nothing recorded it entering. `campaign.materialised` carries the embed, the room,
the task, the channel, the cap, the currency, the committed total and ceiling at
the time, and what the originating task's state was.

**Closing the step is conditional and never raises.** The campaign is the step's
deliverable, so the function moves the task `needs_user -> approved`, the arc
`20260815220000` added for the answered-question path. If the step already moved,
because the owner answered its question card or a replan cancelled it, the
campaign is still created and the skip is recorded in the event. Raising there
would strand the approval permanently: the card already reads `approved`, so every
retry meets the same state and the campaign the owner authorised would never
exist.

**One defect shipped and the suite caught it.** The budget guard was written as
`jsonb_typeof(payload->'budgetCap') <> 'number'`. For an absent key that is
`NULL <> 'number'`, which is NULL and not true, so the guard did not fire, every
later comparison inherited the NULL, and the insert wrote `budget_cap = NULL` at
state `ready`: a campaign that authorised nothing while reporting itself
authorised. It is `is distinct from` now, fixed at source and re-applied rather
than patched by a follow-up so the migration replays from scratch. This is the
NULL twin of the `NaN` case `spend.ts` guards on the TypeScript side, and both
have the same shape, which is the one this repository keeps meeting: not an error,
not a type mismatch, a wrong answer wearing the shape of a right one.

**Applied and verified against the live database: `supabase/tests/materialise_campaign.sql`,
41/41**, including both directions of the ceiling boundary (exactly on it is
authorised, one cent past it is refused), that a terminal sibling holds none of
the ceiling and a null-cap sibling contributes nothing, cross-room tenancy raising
`42501`, and that every refusal leaves no campaign behind. Advisors clean with no
new lints.

`private.campaign_state_is_terminal` also gains `EXECUTE` for `service_role`. It
was revoked from `public` when created and never granted to anybody, which was
correct while only a definer trigger called it; a `security invoker` function
needs it in its own right, and without the grant every commit would have failed
with `permission denied for function` at the spend check. The same pairing
`20260813130000` had to correct after `20260813120000`.

### Artifacts can be files now (`20260829124000`)

`artifacts.storage_path` has existed since `20260813160000` and travelled the whole way: the column, `Artifact.storagePath` in `packages/contracts`, the read in `apps/api/src/routes/projects.ts`, and an arm in the project panel that said "This one is a file rather than text." **Nothing could ever put anything there.** There was no bucket, no policy on `storage.objects`, no route that could hand a file back, and no writer, so that UI arm was reachable only by a row nobody could create.

The narrative below still says that migration was "deliberately not Storage yet", and the reasoning it gives was right at the time: the only thing the AI produced was text, and putting a paragraph of positioning copy in object storage means a fetch to read it plus a bucket policy to get right. What changed is not the reasoning. The creative side of the module produces files and needs somewhere to put them, so this closes the four gaps and nothing else.

**The path convention is the tenancy scheme**, which is why it is stated in the migration header, in `artifactObjectPath`, and here:

```
<project_id>/<artifact_id>/<filename>
```

The first segment is the tenant, and `storage.objects`'s select policy reads it. A file stored anywhere else in this bucket is visible to nobody, which is the safe direction for a convention to fail in. `writeFileArtifact` builds the path through one function that strips separators and traversal out of the filename, because that name arrives from an artifact title or a provider response and a `../` in it would move the object out of its tenant folder.

**The policy and the read path agree by construction.** Both terminate in `private.is_project_member`. `20260827110000` is the reason this is written down as a rule rather than left as a habit: a read path and a policy answering the same question differently is a defect waiting for somebody to fix only one of them.

**The tenant is parsed by a `private` function rather than by an inline cast, and that is a real failure mode rather than tidiness.** `((storage.foldername(name))[1])::uuid` raises `invalid_text_representation` for any object whose first segment is not a UUID, and Postgres does not promise to evaluate the `bucket_id` test first. One stray object anywhere in Storage could therefore turn every member's listing into an error rather than a shorter list. `private.artifact_object_project` returns null instead, and null is nobody. Asserted directly in `supabase/tests/storage_artifacts.sql`, with a junk-path object sitting in the bucket while the member counts rows.

**No client insert, update or delete policy**, matching every artifact row: a client that could write here could fabricate the evidence its own task is judged on, and do it without the `artifacts` row that makes the file discoverable at all.

**The object and the row are written together, and the object is removed if the row fails.** Postgres has no transaction spanning object storage, so the compensation is explicit. The other order was considered and is worse: a row written first would satisfy `artifacts_have_content` while pointing at nothing, and the panel would list a delivered artifact that 404s on download. A missing file that is visible lies to a person; a stored file that is invisible only costs money.

**Uploads are Node-initiated only**, and that is a decision rather than a scheduling accident. The Python service has no storage keys by design ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) and never handles bytes. `WriteArtifactProposal` and `ArtifactEmbedPayload` are unchanged and there is no file-producing proposal kind: a wire shape designed before its first producer is a guess, and unknown kinds already fail loudly. `generate_creative` stays a structured brief arriving as an ordinary text artifact until a byte-producer exists.

**Applied and verified against the live database: `supabase/tests/storage_artifacts.sql`, 11/11.** Advisors after the migration: no new lints.

**One thing found while writing this and deliberately not changed here.** `anon`, `authenticated` and `service_role` all hold the full set of table privileges on `storage.objects`, `TRUNCATE` included, from Supabase's own defaults. That is the same class of finding `20260812120100` closed for `public`, and `TRUNCATE` matters for the same reason: it is not row-level and it ignores RLS entirely. It is not remotely exploitable, since PostgREST does not expose the `storage` schema and the Storage service reaches Postgres by its own path. It is untouched because `storage.objects` is owned by `supabase_storage_admin` rather than by `postgres`, and revoking `INSERT`/`UPDATE`/`DELETE` from `authenticated` there would break user-scoped uploads across every future bucket: narrowing another service's grants is a decision with its own blast radius and does not belong inside this slice. Recorded in [security-compliance.md](security-compliance.md) so it is a decision rather than an oversight.

### The marketing domain (`20260829120000` … `20260829123000`)

The module doc for the first vertical specifies nine entities and this file
contained none of them. Four now exist: `campaigns`, `channel_connections`,
`ad_entities` and `campaign_outcomes`. The other five stay design-only and are
marked as such in [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md),
so "see data-model.md for tables" is finally a true pointer rather than a
forward reference.

**Nothing here is new capability.** There is no executor, no adapter call and no
OAuth route in this slice. The enforcement spine that already works (risk clamp →
`tasks.risk_tier` → `routeTask` rule 1 → the transition guard) has until now been
guarding prose, because prose is the only thing an AI task can produce. These are
the rows it will be guarding, and they land **before** their writers on purpose:
the recorded defect class in this repository is the opposite order, with
`risk_tier` unreachable for its whole life and `task_deps` holding no row for two
weeks.

Three stances are deliberate and each one is a decision somebody could reasonably
reverse, so each is written down rather than left in the DDL.

**`channel_connections` has no client policy of any kind and no client grant.**
That is the `events` precedent for a stronger reason. `events` has no reader yet;
this table has a reader that must never be a client, because a row holds an
access token and a refresh token, and **RLS filters rows, not columns**. A select
policy that returned the row would return the secrets with it. The absence of the
grant is the control, and it fails the right way: a client gets `permission
denied` rather than zero rows, which is the distinction `20260827110000` cost 47
tasks and 28 artifacts to learn. `marketing_rls.sql` asserts the error code, not
a count, and asserts it for the owner of the very room as well as for an
outsider. What a member legitimately needs to see, "Meta account connected,
scopes X", is a later API projection that never selects the token columns.

The table is **room-scoped rather than project-scoped**, on the `room_sources`
reasoning: a connection to somebody's ad account arrives before any single
campaign project exists, and one room carries many projects. Project scoping
would mean re-authorising the same account for every goal posted in the same
workspace.

**`campaign_outcomes` is append-only by grant, including for `service_role`.** An
outcome row is flywheel training evidence, and a training signal that can be
rewritten after the fact is not evidence of anything. A correction is a new row
with `source = 'manual'`, so both the number we pulled and the number a person
says is right survive, and anyone reading them can see that they differed. Worth
noting precisely: `feedback_events` states this intent in a comment and enforces
it only against clients, since it grants `all` to `service_role` and revokes
nothing. `events` is the stronger half of the pattern and this table follows
`events`, `TRUNCATE` included.

**`publishing` is a state distinct from `live`.** Recording a campaign as live
before the platform confirmed it would put an untrue sentence in the audit trail,
which is exactly the argument that gave `action_embeds` its `answered` state
rather than reusing `approved`. Between the request and the confirmation the
honest answer is "we asked". The legal arcs are `draft→ready|cancelled`,
`ready→publishing|cancelled`, `publishing→live|failed`, `live→paused|completed`,
`paused→live|cancelled|completed`. **`live→cancelled` is absent on purpose**: a
spending campaign is paused first, so stopping the money and closing the record
stay two acts with two events.

Two guards land with their tables. `private.guard_campaign_transition` mirrors
`guard_task_transition` exactly, validating the arc and writing the
`campaign.transitioned` event in one trigger, `SECURITY DEFINER` per the
`20260815200000` lesson. `private.guard_ad_entity_hierarchy` keeps the ad tree
well-formed: an `ad_set` hangs off a `campaign`, an `ad` off an `ad_set`, and a
parent belongs to the same campaign. That last clause is the cross-project-edge
argument from `task_deps` applied here, and it matters for a concrete reason: a
campaign you pause that does not stop all of its spend is worse than one you
cannot pause at all.

`ad_entities.state` carries `rejected` at the **entity** level because platforms
disapprove an ad rather than a campaign, and the module rule "ad-policy rejection
leads to revise, never silently keep spending" is unstateable if disapproval can
only be recorded against the whole campaign while its siblings keep running.
`ad_entities.spec` holds the approved brief and the publisher reads it rather
than regenerating: a second generation is a different artifact from the one a
person said yes to, and the difference would reach the world before anyone saw
it.

Two idempotency keys are declared now and written later, so their writers arrive
to a column instead of to a migration: `campaigns.source_embed_id` (one approved
card, one campaign) and the unique
`(campaign_id, period_start, period_end, source)` on `campaign_outcomes` (the
same period pulled twice is one row). `ad_entities.idempotency_key` is the DB
half of rules 9 and 12 for the publish side effect.

**`campaigns.budget_cap` is nullable and NULL means nothing authorised, never
unlimited**, verbatim the stance `projects.budget_ceiling` takes. The two compose
in `checkSpendCap` in `packages/marketing`, enforced in tool code per rule 7.

**Applied and verified against the live database: `supabase/tests/marketing_rls.sql`, 39/39.**
**Advisors after every migration, and they caught something the suite could not.**
`campaign_transition_allowed` and `campaign_state_is_terminal` were written
without a pinned `search_path`, passed all 39 assertions, and raised lint 0011 on
both the moment the migration applied. That is the same pairing `20260813130000`
had to correct after `20260813120000`, and it is the same lesson: a suite asserts
what somebody thought to assert. Fixed at source and re-applied rather than
patched by a follow-up migration, because the file has to be replayable from
scratch. **One INFO lint remains and it is the intended shape:**
`channel_connections` has RLS enabled with no policy, exactly like `events` and
`plan_diffs`, recorded here rather than described as clean so nobody has to
re-decide it. Three `unindexed_foreign_keys` INFO lints
(`campaigns.task_id`, `ad_entities.channel_connection_id`,
`channel_connections.connected_by`) are the same class already accepted on
`artifacts.task_run_id` and `action_embeds.acted_by`, and are left alone rather
than answered with three indexes that the `unused_index` lint would then flag.

### Applying a plan diff (`20260828130000`, `20260828140000`)

`embed_component` gains `replan`, in its own migration so the value is never used
in the transaction that adds it, which PostgreSQL forbids. No new `embed_state`:
a diff is a proposal with a verdict, so the four existing states already mean what
they need to.

`public.plan_diffs` is the provenance table, keyed on the embed. A table rather
than a column on `projects`, because a project legitimately has many diffs over
its life while `source_embed_id` is one card, once. Append-only by grant, like
`events`, and with no client select policy for the same reason: what a member
needs to see is the card, which is already readable through room membership.

`public.apply_plan_diff(embed_id)` is `materialise_plan`'s sibling and shares its
four properties: one transaction, payload read from the card, idempotent by its
own provenance, and unknown values raise. Two passes again, so an op may depend on
a step added after it in the list.

Three guards worth naming.

**Stale ops raise.** An op naming a task at `approved` or later, or in a terminal
state, fails the whole diff. The card was written against a project that has since
moved, and skipping the impossible ops would apply a change nobody reviewed. The
pgTAP suite asserts the atomicity directly: the stale card's _first_ op is an add
that succeeds, and after the failure that step is not in the table.

**Cross-room diffs raise.** The card names a project in its payload, and the
function checks that project resolves, through its own plan card, to the room the
diff was posted in. Nothing else on the path does: the action route checks the
caller's membership of the card's room, which says nothing about the project the
payload names.

**`modify_task` writes three columns and no others.** State, owner and risk tier
are absent from the update statement rather than filtered out of a payload, so
there is no flag to widen. A diff that could move a step from `user` to `ai`, or
lower its tier, would be an authorisation decision travelling through the field
that looks least like one.

**Applied and verified against the live database: `supabase/tests/apply_plan_diff.sql`, 27/27**,
including that a modify carrying `owner`, `riskTier` and `state` changes none of
them, that a cancelled step's dependents stay blocked, and that no failed diff is
recorded as applied, so a retry is still possible.

### The task DAG finally has edges (`20260828120000`)

`task_deps` was created by `20260813120000` and **no row was ever written to it**
until this migration. `materialise_plan` said why and the reason held: the planner
emitted stages and steps, so the only edges available would have been inferred
from stage order, which states a constraint nobody made.

`PlanStep` now carries an `id` and a `dependsOn` on the card payload, and
`materialise_plan` resolves them in a **second pass** over the stages, after every
task exists. One pass would have been enough only if a dependency always appeared
before the step that names it, and nothing requires that: the plan is ordered for
a reader, so a one-pass version would fail a legal plan on presentation order.

Every edge is written `hard`, which is the only kind `private.task_deps_satisfied`
consults. The failure stances match the ones already in the function: an
unresolvable reference and a duplicate step id both **raise**
(`invalid_parameter_value`), exactly as an unknown owner or an unreadable risk
tier does, and a cycle is refused by `task_deps_guard_acyclic` rather than
re-checked here, so the DAG's shape has one definition. All of them raise inside
the transaction that created the project, so a card that fails on its edges leaves
nothing behind even though its tasks were already inserted.

A card written before this migration carries no step ids, so nothing resolves and
it materialises flat: identical to what it did before. The
`project.materialised` event payload gains an `edges` count, because a plan with
no edges and a plan that ran everything at once are the same picture afterwards
without it.

**Applied and verified against the live database: `supabase/tests/materialise_plan.sql`, 42/42**,
including edge direction (an edge inserted backwards satisfies every count while
inverting the schedule), that a dependent is genuinely blocked by
`task_deps_satisfied`, and that `private.tasks_ready` now returns one step from a
three-step plan where it would have returned three.

### An escalated step can be resolved by its owner (`20260827120000`)

`private.task_transition_allowed` let `ESCALATED` go only to `MATCHING`, which is
the marketplace's first state and has no code behind it. So a step the router
escalated could never move: **17 of them on the live database**, twelve routed
there because the plan gave the work to a human and five escalated by the executor
refusing to produce ungrounded output.

Two arcs added, mirroring the ones `20260815220000` gave `NEEDS_USER`, and for the
same reason: `ESCALATED -> APPROVED` (the owner did the work, so the step is done
and its dependents may move) and `ESCALATED -> ROUTING` (another attempt). The
whole function is restated rather than patched, as that migration established,
because `create or replace` rewrites the body and the diagram in
[business-projects-workflow.md](../30-modules/business-projects-workflow.md)
remains the specification it is derived from.

`MATCHING` is untouched. This gives an owner a way to unstick their own project;
it does not anticipate the matcher.

### Project membership resolved through the plan card (`20260827110000`)

`private.is_project_member` asked whether a room the caller belongs to points at
the project. `materialise_plan` writes `rooms.project_id` under `where ... and
project_id is null`, so the **first** plan approved in a room claims that column
permanently and every project after it has no room pointing at it. The predicate
therefore returned false for all of them, for everybody, including the person who
approved the plan and owns the work.

**Measured on the live database before the fix: 6 projects of which 3 were
reachable by any client, with 47 tasks and 28 of 58 artifacts unreachable.** One
workspace had produced four projects and could see one.

It is the same wrong question as the delivery defect in
[architecture.md](architecture.md), where 8 approved tasks and 8 stored artifacts
never reached the chat. That path was corrected in `apps/api/src/lib/room-for-project.ts`
by resolving through `projects.source_embed_id`; the RLS predicate was not, so the
security layer kept asking it for another two weeks. **A read path and a policy
that answer the same question in different ways is a defect waiting for somebody
to fix only one of them.**

The predicate now accepts either link: the room the project's plan card was posted
in (`projects.source_embed_id`, unique, set at creation, never changed), or
`rooms.project_id` for projects that predate that column. Neither widens tenancy,
because both terminate in a `room_members` row for `auth.uid()` with the same
time-box check, so an expired node still sees nothing at all.

**Why it survived: it failed as zero rows, never as an error.** Through PostgREST
an invisible project and an empty one are the same response. Nothing raised,
nothing logged, and no advisor lints a predicate for asking the wrong question.

Covered by `supabase/tests/project_membership.sql`, **13 assertions against the
live database**, asserting both directions: the second project in a room is
visible to its members, and an outsider, an expired node and a member of a
different room still see none of it.

### Crawled sources, and a citation you can open (`20260827100000`, `20260827101000`)

Two migrations, one concern each, both in service of the corpus finally holding
documents somebody other than us wrote.

**`documents.source_url` (`20260827101000`).** The whole wire for this existed
and every value on it was null. `hybrid_search` already returned `source_url`,
`retrieval.py` already carried it onto each chunk, `Citation` already had a `url`
field and `packages/contracts` already shipped it to the browser; the only writer
of `knowledge_sources.url` was a code path that hardcoded `None`. The column goes
on the **document** rather than being fixed only upstream because one source row
can legitimately hold many documents: the room path keeps one row per workspace
by design, since document identity is `(source_id, title)` and per-URL rows there
would let two workspaces supersede each other. So a workspace's source row cannot
carry a URL that means anything and each of its documents can. `hybrid_search`
reads `coalesce(d.source_url, ks.url)`, so a crawled page uses its own address, a
document with none shows none, and nothing borrows a sibling's.

**`documents_source_hash_idx` narrowed to in-force rows (`20260827100000`).** The
original index was unique on `(source_id, content_hash)` across all history, which
is right for a document ingested once from a file somebody edits forward and wrong
for anything re-read on a schedule. Supersession keeps the old row, so every
version a source ever had stays in the index, and the constraint therefore meant
"this source has never had a document with this body". A page that is edited and
then reverted, which happens constantly on policy pages, produces a body an older
superseded version already had, and the insert failed with a unique violation:
the document froze at whatever version we happened to hold, and the only way out
would have been deleting audit history. Scoped to `valid_to is null` it now says
what it always meant, that one source cannot hold two **current** documents with
the same body, and a genuine double-ingest is still refused.

Covered by `supabase/tests/document_supersession.sql`, **9 assertions against the
live database**, asserting both directions: the revert now succeeds, and the
duplicate still fails. It also exercises `knowledge_sources.crawl_cadence`,
`last_crawled` and `content_hash`, which have existed unwritten since
`20260728210000` and whose first writer is the crawl sweep in `apps/api`.

### A workspace can hold its own knowledge (`20260817120000_room_sources.sql`)

Every deliverable the executor wrote ended by naming what it could not include, because the corpus is ten documents of marketing principles and knows nothing about the user's product. `documents` and `doc_chunks` gain `owner_room_id`, the owner-sync trigger copies it down alongside `owner_project_id`, and `hybrid_search` gains `p_room_id` with the predicate `owner_room_id is null or owner_room_id = p_room_id`.

**Room rather than project, and that is not arbitrary.** A project does not exist until a plan is approved, business knowledge arrives before that, and one room now carries many projects. `owner_project_id` is untouched and remains the right scope for what a single project produces, which is what the flywheel will write back.

**The read policies had to change too**, and this is the part that would have leaked. They admitted a row when `owner_project_id is null`, which was complete while that was the only owner column: a room-scoped document has a null project owner and satisfied it. Both owners must now be null for a row to be shared.

**The old eleven-argument `hybrid_search` is dropped rather than left beside the new one.** Adding a parameter creates a new function, and two functions of one name is how a scoping fix silently fails to apply to a caller that kept binding to the old signature.

Verified by `supabase/tests/room_sources.sql`, **14 assertions against the live database**: the trigger syncs, room A retrieves its own and the shared corpus and never room B's, an unknown room gets shared only, a client sees neither room's rows, and exactly one `hybrid_search` exists. Asserted through the function rather than through RLS on purpose, because the AI service calls it with the secret key, which bypasses RLS entirely: that predicate is the only isolation there is.

The same migration adds `dismissed` to `embed_state`, for a question card somebody walked away from. Not `expired`, which means nobody acted in time, and not `rejected`, which is a verdict on something they were shown.

## ERD overview (domains)

```
Identity      users ─1:1─ profiles ─*─ node_profiles ─*─ node_skills/credentials
Chat          rooms ─*─ channels ─*─ threads ─*─ messages ─*─ reactions
              rooms ─*─ room_members (user_id, role)          messages ─*─ action_embeds
Workflow      projects ─*─ tasks ─*─ task_deps (DAG)   tasks ─*─ task_runs ─*─ agent_steps
              tasks ─*─ artifacts   tasks ─*─ escalations   projects ─*─ playbook_versions
Marketplace   node_profiles ─*─ offers ─*─ engagements ─*─ proof_artifacts ─*─ ratings/disputes
Payments      escrow_holds ─*─ ledger_entries (double-entry) ─*─ payouts   users ─*─ subscriptions
Marketing     campaigns ─*─ ad_entities (tree)   campaigns ─*─ campaign_outcomes
              rooms ─*─ channel_connections (OAuth, room-scoped, no client reader)
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

**Live:** `projects`, `tasks`, `task_deps`, `task_runs` and the append-only `events` log (`20260813120000`), plus `artifacts` (`20260813160000`, described below). `playbook_versions`, `agent_steps`, `tool_invocations` and `escalations` remain design-only.

**`20260813160000` adds `artifacts`:** what a task produced, and the evidence the checker judges. Inline text in `body`, files in `storage_path`, and a **check constraint refusing a row with neither**, because an artifact with no content is a task that reported success and produced nothing. Deliberately not Storage-only yet: the sketch above has artifacts carrying a `storage_path`, which is right for a video edit and wrong for the only thing the AI produces today, and putting a paragraph of copy in object storage would mean a fetch to read it plus a bucket policy to get right. **That last clause is now done and the column is finally reachable:** `20260829124000` adds the private `artifacts` bucket, the member select policy on `storage.objects`, the signed-URL route and the writer, described above. `body` is still where text goes; nothing about the inline case changed. `task_runs` gains its purpose here too, since **each execution attempt is its own row** and a retry that overwrote the previous one would erase why the first failed.

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

## Marketing schema

The first vertical's domain. All four tables are **live** (`20260829120000` …
`20260829123000`); the narrative and the three deliberate stances are at the top
of this file. `content_items`, `creative_assets`, `email_sequences`,
`landing_pages` and `creative_performance` remain design-only, tracked in
[marketing-growth-engine.md](../30-modules/marketing-growth-engine.md).

| Table                 | Key columns                                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `campaigns`           | `id`, `project_id`, `task_id?`, `name`, `objective`, `channel` (meta/google/email/organic_social), `state` (draft→ready→publishing→live→paused→completed, plus cancelled/failed), `budget_cap` (**NULL = nothing authorised**), `currency`, `pause_reason`, `source_embed_id` UNIQUE, `created_by` |
| `channel_connections` | `id`, `room_id`, `connected_by`, `provider` (registry-validated), `channel`, `external_account_id`, `granted_scopes[]`, `access_token`, `refresh_token`, `token_expires_at`, `status` (active/expired/revoked), UNIQUE `(room_id, provider, external_account_id)`                                  |
| `ad_entities`         | `id`, `campaign_id`, `project_id`, `parent_id?`, `kind` (campaign/ad_set/ad), `state` (…/rejected/archived), `external_id?`, `channel_connection_id?`, `spec` JSONB, `idempotency_key` UNIQUE                                                                                                      |
| `campaign_outcomes`   | `id`, `campaign_id`, `project_id`, `period_start`, `period_end`, `spend`, `impressions`, `clicks`, `conversions`, `revenue`, `metrics` JSONB, `source` (pull_metrics/manual), UNIQUE `(campaign_id, period_start, period_end, source)`                                                             |

- **Grants differ across the four and the differences are the design.** `campaigns`,
  `ad_entities` and `campaign_outcomes` are `select` for `authenticated` and `all`
  for `service_role`, like every workflow table. `channel_connections` grants
  nothing to any client role and carries no policy, because it holds tokens.
  `campaign_outcomes` additionally revokes `update, delete, truncate` from
  `service_role` as well as from clients.
- **Membership is the same predicate everywhere**, `private.is_project_member`, the
  `20260827110000` version. `ad_entities` and `campaign_outcomes` carry a
  denormalised `project_id` so that predicate is a plain column test, exactly as
  `artifacts` carries one beside `task_id`.
- **The spend cap is enforced in tool code, not by a constraint.** `budget_cap` and
  `projects.budget_ceiling` compose in `checkSpendCap` (`packages/marketing`),
  which is where rule 7 puts it.

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
