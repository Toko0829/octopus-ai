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

### The refusals get written down (`20260905120000_retrieval_gaps.sql`)

**One table, no new capability, and the point of it is that the corpus has been
grown blind.** `planner.py` has split a refusal three ways since the groundedness
gate landed, and the split is load-bearing: "nothing retrieved" and "retrieved but
off-target" are corpus signals that should drive what gets ingested next, while
"could not verify" is an operational signal that should page someone. All three
then went to stdout and nowhere else. So the one artefact that would say what
people actually ask and do not get has never existed, and every corpus decision
so far has been the author's intuition measured against a golden set the same
author wrote.

The measurement that argues for it is in
[rag-knowledge.md](../30-modules/rag-knowledge.md): the shared corpus is 17
documents and 99 chunks, and `--gate` reports "blocked 1.00 of scope negatives"
as a **pass** over six questions any founder might reasonably ask. The metric
reading green is the gap list, and it is a gap list of six entries written by
hand.

**Not folded into `events`.** That table is the DAG's audit trail: it requires
`subject_id uuid not null` and hangs off `project_id`. A refusal has neither,
because it happens before any project exists and its subject is a sentence
somebody typed. Forcing it in would mean a synthetic subject id pointing at
nothing, which is how an audit trail stops being readable.

**Append-only including for `service_role`**, following `campaign_outcomes` and
`events` rather than `feedback_events`, which states the intent in a comment and
grants everything anyway. `TRUNCATE` is revoked with `UPDATE` and `DELETE` for the
reason recorded under the RLS policy model: `grant all` includes it, it is not
row-level, and it ignores RLS.

**There is deliberately no `resolved` column.** A gap is closed when the same
question stops being refused, which is a thing to measure rather than a thing to
assert. A boolean somebody ticks after ingesting a document records the intention
to fix it, not the fix.

**One CHECK does real work:** `(core = 'refusing-v0') = (chunks_retrieved = 0)`.
Those two counts are what every query against this table groups by, and the
distinction they carry — the corpus was silent, versus the corpus talked and
missed — is the whole reason it exists. A writer that gets it wrong makes the
table quietly lie rather than error, so the database refuses instead.

**One advisor lint is added and it is the design**, the same sentence the
marketplace slice earned: `rls_enabled_no_policy` (INFO) on `retrieval_gaps`,
beside the standing entries for `events`, `ledger_entries`, `plan_diffs`,
`node_verifications` and `channel_connections`. RLS on, no policy, no client
grant **is** the control here. There is nothing in this table for a user: they
have already been told, in the refusal itself, that their question was not
covered, and one room's phrasing of a question is not another room's business.

**Verified by a rolled-back dry run against the live database** (there is no local
Supabase): both inserts landed, all three CHECK violations fired, and the
privileges came back `service_role` insert/select true, update/delete false,
`authenticated` select false. Applied afterwards and the recorded version
corrected to match the filename, per `supabase/README.md`'s audit.

### An answered gap is still a gap (`20260905130000_retrieval_gaps_ungrounded.sql`)

**A CHECK widening and nothing else.** `20260905120000` constrained `core` to the
three refusal cores deliberately, so that a fourth value would have to arrive as a
schema change — the point at which somebody decides what it means for the corpus.
This is that decision, made once, for `ungrounded-general-v1`
([ADR-0021](../40-adr/0021-a-labelled-ungrounded-tier.md)). The constraint is
dropped and re-added with the new value; the column comment is rewritten to say
what the set now means.

**It belongs in this table rather than a new one, because it is the same signal
wearing a different outcome.** `refusing-ungrounded-v1` and
`ungrounded-general-v1` are produced by the identical condition: retrieval
returned chunks and the groundedness gate judged they do not answer the goal. The
only difference is what the product then did about it, which is a policy decision
that can change and has. Two tables would mean that turning `UNGROUNDED_FALLBACK`
off silently moved the corpus's backlog somewhere else, and the queue would appear
to empty because the answer changed rather than because the gap closed.

**The ingest queue is every core except the operational one** —
`core in ('refusing-v0', 'refusing-ungrounded-v1', 'ungrounded-general-v1')`. A
rising share of `ungrounded-general-v1` means the product is answering more
questions from general practice, which is the tier working and the corpus not
keeping up. It is a number that should fall, and it is not an achievement.

**`retrieval_gaps_no_sources_is_empty` is untouched and still holds.** That check
pairs `core = 'refusing-v0'` with `chunks_retrieved = 0`, and the new core is only
ever reached on a retrieval that returned chunks, so it is never zero for it. The
invariant is enforced upstream too: `RetrievalResult.grounded` _is_
`len(chunks) > 0`, so both writers derive the two fields from the same fact.

**Recorded rather than glossed:** the drop names `retrieval_gaps_core_check`,
which `20260905120000` never declares — it is Postgres's generated name for the
unnamed inline CHECK on `core`, deterministic because that column carries exactly
one. There is no `if exists` guard. It applied cleanly against the live database,
so it stands as written rather than being edited after the fact, but a future
constraint on this table should be named where it is created.

### Threads, and `scope` stops being decorative (`20260901120000` … `20260901123000`)

**Zero new capability, for the second slice running.** No route, no writer, no
client grant that permits a write. Nothing a person can do afterwards that they
could not do before. What changed is what a _future_ thread-scoped member can
see, and no such member can exist until the matcher slice.

**`threads`** carries a denormalised `room_id` beside `channel_id`, on
`action_embeds`' precedent, so tenancy policies are a membership call rather
than a join. The denormalised copy is kept honest by a composite foreign key to
`channels (id, room_id)`, which required adding `unique (id, room_id)` to
`channels` as a target. `task_id` is a **plain unique**: one thread per task
ever, because a reassignment creates a second engagement ([ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md))
and must not fragment the trail of what happened on the task.

**The foreign keys are NO ACTION, and the distinction is the design.** A thread
holding messages cannot be deleted: `on delete set null` would re-home those
messages into the null-thread room stream, which both destroys the container the
audit trail is read through and _widens_ who can see them, since room-scoped
members read that stream. A deletion must not be a disclosure. NO ACTION rather
than RESTRICT because NO ACTION is checked at end of statement, so deleting a
whole room still cascades cleanly — verified on the live database in a
rolled-back transaction rather than argued from the manual.

**`room_members.scope`** gains a check constraint, a nullable `thread_id`, and a
check binding the two (`(scope = 'thread') = (thread_id is not null)`). It had
been `text not null default 'room'` with **no constraint and not one reader**
since `20260728120000` — the fifth member of the unreachable-column family, and
the second of the kind that announces itself as a control, since it shipped
beside `expires_at`, which is enforced everywhere. Shape and rationale in
[ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md).

**`20260901123000` corrects `20260901122000` and is kept as a separate
migration.** The room_members policy had reused the messages predicate verbatim,
which on that table asks a different question, because there the rows _are_ the
scopes: a thread-scoped member matched every membership row pointing at their own
thread rather than only their own. Found by `thread_scope.sql` asserting 1 and
measuring 2. The applied migration is left exactly as it ran, because editing it
to hide the correction is how the recorded body stops matching the file.

**One advisor lint family is added and it is the design.** The new foreign keys
carry covering indexes, which report as `unused_index` until their readers land.
`node_credentials` declined a speculative index on the grounds that it "would
serve a sweep that does not exist"; that argument does not reach here, because a
foreign key _is_ a query, run on every delete of the parent row, and for
`messages_thread_in_same_room` the child table is the one that grows without
bound. The alternative lint, `unindexed_foreign_keys`, names a cost that is real
today.

### The marketplace gets its domain (`20260831120000` … `20260831123000`)

**Zero new capability.** No route, no adapter, no registry, and no client grant
that permits a write. There is nothing a person can do after these four
migrations that they could not do before them. That is deliberate and it is the
marketing domain's ordering repeated: `20260829120000`…`123000` landed four
tables with their guards and no writers, and `20260829150000`'s header states
the resulting doctrine — "a guard that lands after its writer is a guard that
spent the interval not guarding."

**What it is for.** `escalated` is the last live dead end in the product.
`router.ts:93` sends every human-owned step there with the reason "it goes to
the marketplace", and the marketplace does not exist; **twelve tasks sit in that
state on the live database right now.** `20260827120000` measured seventeen and
gave the owner a way to unstick their own project, saying explicitly that it
"is not the marketplace and must not be dressed up as one". This is.

**Three of the module's nine entities land, plus one it does not name.** The
deferrals and their triggers are in §Marketplace schema above. The fourth table,
`node_verifications`, is **forced by the design rather than specified**: once a
node can read their own profile, the face-search result — which names a third
party the node may be a duplicate of, alongside provider scores used to decide
against them — cannot live on that profile, because RLS filters rows and not
columns. It is the `channel_connections` shape for a different reason: that
table has no client reader because it holds secrets, this one because it holds
somebody else's identity and an adverse inference about its own subject. No
policy, no grant to `authenticated` or `anon`, and append-only including for
`service_role`.

**`node_profiles.user_id` is the primary key**, following `profiles`. A node is
a user, so every child table's tenant predicate is a plain `node_id =
auth.uid()` equality — `ad_entities.project_id`'s "the tenant predicate on a hot
path should not be a subquery" reached by a better road, with no denormalised
copy to drift.

**Two NULL stances, both inherited.** NULL `rate` means nothing quoted and
therefore ineligible, never free (`campaigns.budget_cap` inverted). NULL
`trust_score` means cold start, never zero, because zero would mean measured and
worthless — the same no-invented-zero rule the metrics slice applied to a day
with no spend.

**The line on which guards land now.** A guard lands in this slice **if and only
if it is decidable from the row in front of it**. Structural invariants —
shape, well-formedness, "this boolean cannot be true without that evidence",
"this column is written once" — need no writer's cooperation to be right, and
the only cost of landing them early is that they are true. Lifecycle maps land
with the writer whose transitions could be wrong. That line fits both
precedents exactly: `ad_entities` landed its hierarchy guard immediately and its
transition guard with the publisher (`20260829150000`). Applying it here gives a
clean result: **there is no marketplace lifecycle guard to write at all**,
because the lifecycle is `private.task_transition_allowed` and has been binding
`service_role` since `20260813120000` ([ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)).

The one exception is the **KYC audit trigger**, which lands without its map.
That is not a lifecycle: it stamps `kyc_status_changed_at` and writes one
`node.kyc_status_changed` event. It lands now so slice 3's writer cannot produce
an unaudited KYC change even on its first commit, because AML wants the trail
from the first row rather than from the first correct row. The `kyc_status`
transition map joins the same function in that slice, beside the insert rather
than instead of it, keeping the house rule of one trigger for both.

**PostGIS is not enabled** and service area is a hierarchical jurisdiction code
([ADR-0015](../40-adr/0015-service-geo-is-a-jurisdiction-code.md)).

**Applied to the live database, and the Supabase advisors were run afterwards
rather than only the tests** — `20260813120000` passed 33/33 and still
introduced six lints. This slice adds exactly one, and it is the intended
design: `rls_enabled_no_policy` (INFO) on `node_verifications`, which sits
beside the same lint already standing for `channel_connections` and `events`
for the same reason. RLS on with no policy and no client grant **is** the
control; a policy would be the defect. No `SECURITY DEFINER` view, no function
with a mutable `search_path`, and nothing new granted to `authenticated`.

**Verified against the live database: `supabase/tests/marketplace_rls.sql`,
46/46**, inside a transaction that rolled back. The slice has no writer, so that
file is its only caller — which is what makes four tables landing ahead of their
writers defensible rather than dead: every constraint and both triggers are
exercised. Two of the assertions are about the **task machine staying
unchanged**: `matching → failed` is still refused and `escalated → matching` is
still allowed. Slice 1 restores no arc, and pinning the absence is what will
make slice 4's restoration read as a dated decision rather than as drift —
`20260815220000` silently dropped eight arcs with nothing asserting they had
ever been there.

### The marketplace gets its writers (`20260902120000` … `20260902122000`)

Three functions, **no table change and no grant change at all**. That is the
property worth stating first: the four tables landed with their guards a slice
early precisely so that the writers would arrive to a schema rather than to a
migration, and they did. `supabase/tests/marketplace_rls.sql` is still 46/46,
including all ten of its privilege assertions.

**`private.node_kyc_transition_allowed` + the map inside
`private.guard_node_kyc_audit`** (`20260902120000`). `20260831120000:252-268`
deferred the lifecycle map and named this function as its home, "beside the
insert rather than instead of it, because the house rule is one trigger for both
so that an audit entry cannot be forgotten by a caller and cannot describe a
transition that did not happen." Five arcs land — `unverified → pending`,
`pending → verified | rejected | unverified`, `rejected → pending` — and nothing
else. Nothing reaches `suspended` and nothing leaves `verified`, because neither
has a writer, and permitting an unmakeable transition is the `task_deps` defect.
The helper is separate so a suite can assert one arc per assertion without
arranging a fixture, matching `task_transition_allowed`,
`campaign_transition_allowed` and `ad_entity_transition_allowed`.

One consequence, recorded rather than left to be discovered:
`node_profiles_suspended_has_reason` is now **unreachable**, so the assertion in
`marketplace_rls.sql` that used to exercise it passes for a second reason. Both
raise `23514`. The note is in the suite, beside the assertion.

**`public.invite_node(uuid, text[], text[])`** (`20260902121000`), `security
invoker`, granted to `service_role` alone. Creates the `node_profiles` row and
promotes `profiles.role` to `human_node` in one transaction, because supabase-js
has none and a half-applied invite is either a node the system does not
recognise or a `human_node` with nothing behind it. It never demotes (`admin`
and `ops` raise `insufficient_privilege`), is idempotent on a re-invite via `on
conflict do nothing`, and writes a `node.invited` event because the invite
changes no `kyc_status` and would otherwise leave no trail. The role trigger
does not fire because `auth.uid()` is null under `service_role`, which is the
bypass `20260831110000:59-67` was written with.

**`public.decide_node_kyc(uuid, text, jsonb, text)`** (`20260902122000`), same
grant posture. Its shape was decided by the table rather than the other way
round: `node_verifications` has `update`, `delete` and `truncate` revoked from
`service_role` too, so `insert ... on conflict do nothing` is the only idiom and
the verdict is **derived from the rows in the table after the insert, never from
the payload**. A replay inserts nothing, so deciding from the argument would
work by accident where deciding from the table works by construction. This is
`campaign_outcomes`' lesson (`20260829123000`) applied to identity. The status
change is an ordinary `update`, so it passes through the map above and a node who
never submitted cannot be verified.

**Verified against the live database: `supabase/tests/node_onboarding.sql`,
36/36**, inside a transaction that rolled back, plus `marketplace_rls.sql` still
46/46. Advisors run afterwards: **no new lint**. The `rls_enabled_no_policy`
INFO on `node_verifications` still stands and is still the design.

### A comment promised a guard and no migration ever wrote it (`20260831110000`)

`20260724000000_init.sql:21`, in the file that creates `profiles`, says role
escalation is blocked here and that "a later migration adds a trigger preventing
self role changes". **There is no later migration.** All forty-four were read.
`profiles_update_own` carries `using (auth.uid() = user_id)` with no column
restriction, and `20260728170000:22` grants `update` on **every column** to
`authenticated`, restated verbatim at `20260812120100:31`.

**Measured before the fix, on the live database, rather than argued:**
`has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')`
returned true, `update public.profiles set role = 'admin' where user_id =
auth.uid()` **completed with no error**, and the row read back `admin`.

This is the defect class this repository has now named five times — `risk_tier`
unreachable for its whole life, `task_deps` holding no row for two weeks,
`artifacts.storage_path` with no bucket, `projects.budget_ceiling` with no
writer — and it is the worst-shaped member of the family, because **the promise
reads as though it were kept.** The other four announce themselves as absences;
this one announces itself as a control. That is how it survived forty-four
migrations of review.

**Latent today, and it stops being latent in the next slice.** Nothing currently
authorises on `profiles.role`: `apps/api/src/plugins/auth.ts:48` reads the role
from the JWT and every ownership check comes from `rooms.owner_id`, which is why
this is a fix and not an incident. The marketplace domain lands next and makes
`human_node` mean "eligible for paid work funded from somebody else's authorised
budget", at which point a self-service role column is escalation directly into
the money path.

**Two controls, because the first has already been silently undone once.** The
column grant (`revoke update`, then `grant update (display_name, jurisdiction,
languages)`) is the real fix. The trigger exists because `20260812120100`
restated the table-wide grant while doing something else entirely, so a future
migration restoring `grant update on public.profiles` would re-open this with no
diff that looks like a security change. **A `grant` line cannot undo a trigger.**
`auth.uid() is not null` is the whole person/server distinction: `service_role`
writes with no JWT, so ops promotion through the server path is untouched, and a
request carrying a person's claims is a person whatever function it travels
through — so a future `SECURITY DEFINER` helper cannot launder a role change on a
user's behalf. Predicate entirely in the trigger's `when` clause, body nothing
but the raise, exactly as `private.guard_ad_entity_external_id`
(`20260829150000`) is written.

Covered by four assertions in `supabase/tests/rls_membership.sql` (now 26). The
one that matters is run **as `postgres` with a person's claims set**, bypassing
both the grant and RLS, so the only thing left refusing the write is the trigger:
a test run as `authenticated` would be refused by the column grant first and
would still pass with the trigger deleted.

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

### `campaign_outcomes` gets its writer and its guard (`20260829160000`)

The last of the four marketing tables with no writer has one: the metrics sweep in
`apps/api/src/lib/metrics.ts`. Three things about the schema turned out to be
load-bearing once something wrote to it, and all three were decided in
`20260829123000` before any writer existed.

**Append-only by grant, including for `service_role`, means the writer has exactly
one tool.** `insert ... on conflict do nothing` is not a stylistic preference here:
`on conflict do update` would fail on privilege rather than resolve anything, so
the unique key is the whole idempotency mechanism and there is no fallback behind
it.

**The unique key only dedupes windows that match exactly**, which turns "what
counts as a period" into a correctness property rather than a formatting one. The
sweep answers it with one pure producer (`duePeriods`), whole closed UTC days, and
never today, because a partial day could never be revised into a whole one and the
next pass would append an overlapping row instead of replacing it. A doubled spend
is the number the optimizer reads when deciding whether to pause a campaign.

**`source` was plain `text` with its two values in a comment**, which is the shape
`ad_entities` shipped in and `20260829150000` closed. It is a check constraint now,
landing in the same change as the first writer on the same ordering. It matters
more than a provenance nit because `source` is part of the unique key: a row
written as `metrics` or `pull-metrics` would collide with nothing, so a typo would
look like a label mistake and behave like a duplicated payment record. `manual` is
included although nothing writes it yet, since it is half of what the key means, and
leaving it out would enforce today's writers rather than the design.

**Applied and verified against the live database: `supabase/tests/marketing_rls.sql`,
42/42**, with three new assertions (the constraint exists, an unrecognised source
raises `23514`, both documented values insert). Advisors after the migration:
the same seven pre-existing lints and no new one.

`campaign_outcomes` also gains its first reader in the same slice, in
`buildProjectDetail`, which is deliberate: shipping a writer with nobody reading it
would extend this file's most-repeated defect class rather than close it.

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

**It has its writer now, and no migration came with it.** The connect flow uses
the table, the enum, the index, the grants and the unique constraint exactly as
they landed: the guards arrived before the writer on purpose and needed no
adjustment when it came, which is the outcome that ordering is supposed to
produce. Three things about the writer belong here rather than in the module doc.

`unique (room_id, provider, external_account_id)` is what the write relies on:
`writeConnection` upserts on it, so a second authorisation for an account already
connected updates the row instead of creating a rival, and "which token do we
use" keeps one answer. It is also the bound on replaying a signed `state` inside
its lifetime, since a repeated successful exchange lands on the same row.

**Reconnecting is the same write.** The upsert states `status = 'active'` rather
than leaving whatever was there, because an expired or revoked connection coming
back is the ordinary path and a row that stayed `revoked` after a fresh grant
would be refused by `checkScopes` on a credential that is perfectly good.

**Disconnecting is an update, never a delete.** `status = 'revoked'` with
`access_token`, `refresh_token` and `token_expires_at` all nulled. The row is the
record that this account was connected, on this date, by this person; the
credential is not. Deleting would destroy the first to achieve the second.

**The table audits itself from `apps/api`, because it has no trigger.**
`campaigns` records its transitions through `private.guard_campaign_transition`;
this table has nothing equivalent, so connecting and disconnecting would
otherwise be the only acts in the marketing domain with no `events` row.
`auditConnection` writes `channel.connected` / `channel.revoked` with
`project_id` **null**, which is the case that column is nullable for: a
connection belongs to a room and no project. `actor_id` is passed explicitly,
since the `auth.uid()` idiom reads null under the service key and this whole path
runs under it. The payload carries the scopes and the account id and never a
token, because an audit trail holding the credential would reintroduce, in a
table with no policy of its own, exactly what the projection withholds.

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

**`20260829150000` adds the lifecycle guard the table shipped without**, in the
same change as its first writer. There was no state machine on `ad_entities`
originally and that was right at the time: no writer existed whose transitions
could be wrong, and a machine enforcing arcs nobody could take is the `task_deps`
defect this repository has already paid for. The map is
`draft -> publishing|archived`, `publishing -> live|failed|rejected`,
`live -> paused|rejected|archived`, `paused -> live|archived`,
`rejected -> archived`, with `archived` and `failed` terminal.

**`rejected` is deliberately not terminal.** Revise-and-resubmit produces a new
entity, so the disapproved one is closed out rather than resurrected; making it
terminal would strand a row forever in a state that reads like an unanswered
question. `rejected` is reachable from `live` as well as from `publishing`,
because a platform can disapprove an entity that is already running.

The same migration makes **`external_id` write-once**, which had been a column
comment since the table was created and is now a second BEFORE UPDATE trigger.
Separate from the lifecycle guard because the two bind on different conditions:
the lifecycle guard fires only on a state change, and write-once has to hold on
every update. Its `when` clause is the whole check, which is what keeps the
resume path free: a publisher re-driving a crashed publish writes the **same** id
back, and an identical value is not a change. Overwriting it with a different one
orphans a live object that is still spending, with nothing left in our database
pointing at it.

Neither helper is granted to `service_role`. Both trigger functions are
`SECURITY DEFINER`, so the writer never needs EXECUTE on their internals, which
is the `20260813130000` / `20260815200000` trap avoided by construction rather
than by a grant. Note `private.campaign_transition_allowed` is still granted to
nobody for the same reason, so Node relies on the trigger and never consults the
map directly.

Two idempotency keys are declared now and written later, so their writers arrive
to a column instead of to a migration: `campaigns.source_embed_id` (one approved
card, one campaign) and the unique
`(campaign_id, period_start, period_end, source)` on `campaign_outcomes` (the
same period pulled twice is one row). `ad_entities.idempotency_key` is the DB
half of rules 9 and 12 for the publish side effect, **and it has its writer now**:
the sweep derives `publish:<campaignId>:campaign` from the campaign id alone, so a
retry collides here instead of creating a second row.

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
- **Roles:** `user` | `human_node` | `verified_pro` | `admin` | `ops` — carried as a JWT claim **and** in `profiles.role` (the DB backstop). **Never self-service** (`20260831110000`): `authenticated` holds a column grant covering `display_name`, `jurisdiction` and `languages` only, and a trigger refuses a `role` change from anyone carrying a JWT even if the table-wide grant is ever restored.
- Tenancy scoping is **project- and room-membership based** (not a single `org_id` column) so a user, the AI, and multiple nodes can share a room with different privileges.

## Chat schema

| Table                                 | Key columns                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rooms`                               | `id`, `project_id`, `kind` (guild/dm), `created_at`                                                                                                                                                    |
| `room_members`                        | **live** — `room_id`, `user_id`, `role`, `scope` (`room`/`thread`, checked), `thread_id?` (`20260901122000`, bound to `scope` by check), `joined_at`, `expires_at` (time-boxed node access)            |
| `channels`                            | `id`, `room_id`, `name`, `kind` (text/topic), `position`; `unique (id, room_id)` as a foreign-key target (`20260901120000`)                                                                            |
| `threads`                             | **live** (`20260901120000`) — `id`, `room_id` (denormalised), `channel_id`, `task_id?` UNIQUE, `title`, `created_at`; `unique (id, room_id)`, composite FK to `channels (id, room_id)`. No writer      |
| `messages`                            | `id`, `room_id`, `channel_id`, `thread_id?` (**live**, `20260901121000`), `author_id`, `author_kind` (user/agent/node/system), `body`, `idempotency_key` UNIQUE, `seq` (ordering cursor), `created_at` |
| `reactions`, `pins`, `saved_messages` | —                                                                                                                                                                                                      |
| `action_embeds`                       | **live** (`20260812120000`) — `id`, `message_id` UNIQUE, `room_id`, `component` (plan/approval/pay/sign/assign), `payload` JSONB, `required_role`, `state`, `acted_by`, `acted_at`, `expires_at`       |
| `presence`                            | ephemeral (Realtime Presence), not authoritative in Postgres                                                                                                                                           |

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

**Membership is inherited, not re-derived.** `private.is_project_member` resolves a project through the rooms pointing at it, reusing the one membership definition rather than adding a second to keep in step. **The narrowing that was recorded here twice is closed** (`20260901122000`): the helper now requires `scope = 'room'`, so a thread-scoped member is not a project member at all. `private.artifact_object_project` terminates in it and inherited that with no edit, which is the payoff for there being one definition. See [ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md).

**A policy helper in `public` is an API endpoint, and this was learned twice.** `20260813120000` created `task_deps_satisfied` in `public` as `SECURITY DEFINER` with `EXECUTE` granted to `authenticated`, which published the scheduler's READY predicate at `/rest/v1/rpc/task_deps_satisfied`. That is advisor lint 0028/0029, **the same lint `20260728160000_harden_security_definer.sql` exists to clear**, reintroduced by someone who had read that migration. It repeats easily because it looks like ordinary least privilege: define a helper, grant it to the roles that need it. In Supabase, `public` is the API schema, so the grant is also a publication. `20260813130000` moved it to `private` and dropped it to `SECURITY INVOKER`, since unlike `is_room_member` it is never evaluated inside a policy and so never needed to bypass RLS. The same migration pinned `search_path` on the four workflow functions that lacked it (lint 0011); the two guard functions enforcing the state machine are precisely the wrong pair to leave resolvable through a caller's search path.

**And then the same migration locked the only writer out of the machine it enforces.** `20260813130000` hardened the workflow functions correctly and left `service_role` without EXECUTE on the guards' internals, so `private.guard_task_transition` fired, ran as the caller, and failed on its first line with `permission denied for function task_transition_allowed`. **Every write to `tasks.state` through the API was refused**, from the day that migration landed: plans materialised, their tasks sat `PENDING`, and each scheduler tick swept them and failed. `service_role` separately had no USAGE on `private` at all, so the public wrappers over `tasks_ready` failed too. Closed by `20260815190000` (schema USAGE) and `20260815200000`, which makes both guards **SECURITY DEFINER** rather than granting EXECUTE to the caller: a guard meant to bind trusted code must not depend on trusted code holding privileges on its private parts, and granting per-role would leave the same trap for the next writer.

**Neither was visible to anything but running the product.** `rls_workflow.sql` asserts the machine **as `postgres`**, deliberately and correctly, which is exactly why it is blind here, since `postgres` owns these functions: the suite proved the machine works and could not prove anyone could reach it. A missing grant is not a lint, so the advisor was silent too.

**The 33 assertions passed before those six lints existed.** A pgTAP suite asserts the properties somebody thought to assert; the advisor checks the ones everybody forgets. Run `get_advisors` after every migration, not just the tests.

**`task_deps_satisfied` is the scheduler's READY predicate**, and two of its choices are deliberate. Only **hard** deps block, since soft is an ordering preference and resource a shared-constraint hint, and treating either as blocking would stall a graph that is progressing perfectly well. And a dependency counts as satisfied at **`approved`**, not `done`: a dependent step can start once the work it needed is accepted, where waiting for `paid` would hold the whole graph on a bank transfer.

## Marketplace schema

Six tables are live and three are deferred. The table says which is which,
because a list mixing live tables with intentions reads as though all of them are
there.

| Table                | Status                                                                       | Key columns / notes                                                                                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node_profiles`      | ✅ live `20260831120000`, written by `invite_node` + `decide_node_kyc`       | `user_id` **PK** (a node is a user), `kyc_status`, `availability`, `trust_score` (NULL = cold start, never 0), `service_jurisdictions text[]`, `rate` + `rate_period` (NULL = nothing quoted, never free)                                 |
| `node_skills`        | ✅ live `20260831121000`, written by `/api/node/skills`                      | `(node_id, skill_tag)` PK, `verified`. Tag is shape-checked text, not an enum                                                                                                                                                             |
| `node_credentials`   | ✅ live `20260831122000`, written by `/api/node/credentials` (claims only)   | Renamed from the spec's `credentials`. `kind`, `jurisdiction`, `verified` (write-once true), `evidence_path`, `revoked_at`                                                                                                                |
| `node_verifications` | ✅ live `20260831123000`, written by `decide_node_kyc`                       | The check log. **No policy and no client grant at all**; append-only including for `service_role`                                                                                                                                         |
| `offers`             | ✅ live `20260903120000`, written by the matcher sweep and the node's routes | Its entire content is a lifecycle, so it landed **with** its writers rather than ahead of them. Full shape in §`offers` below                                                                                                             |
| `engagements`        | ✅ live `20260904120000`, written by `accept_offer`                          | **No state column** ([ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)): engagement state is `tasks.state`. Carries `agreed_price` (frozen), `deadline_at`, `terms_hash`, `outcome`. Full shape in §`engagements` below |
| `proof_artifacts`    | ⏳ slice 6, with the proof loop                                              | `artifacts` already has `kind` and `storage_path`. A second answer to "where is the deliverable" is the `is_project_member` defect class; slice 6 decides table vs. columns                                                               |
| `ratings`            | ⏳ slice 8                                                                   | Written after `paid`. Feeds `trust_score`, which lands now as a nullable column so the writer arrives to a column rather than a migration                                                                                                 |
| `disputes`           | ⏳ slice 8, with the ops path                                                | A `disputed` task with no ops console is a state nobody can leave — the `escalated` defect reproduced deliberately                                                                                                                        |

**`credentials` is named `node_credentials` here, diverging from the module doc
on purpose.** A table called `public.credentials` three tables from
`channel_connections` reads as auth credentials to every future schema browser.
Reconciled rather than left to drift: `human-nodes-marketplace.md` is edited in
the same change.

**`service_geo` (PostGIS) is `service_jurisdictions text[]`**, argued in
[ADR-0015](../40-adr/0015-service-geo-is-a-jurisdiction-code.md). PostGIS is not
installed and the matching rule is a containment test over a hierarchy plus a
specificity ordering, not a geometry query.

## Payments schema

**Two tables are live and the rest are deferred**, on the marketplace schema's
habit above. **Nothing in this schema charges anything**: the only registered
payment provider is a deterministic in-repo fake, and the counsel gate in
[payments-billing.md](../30-modules/payments-billing.md) is unmoved, because
modelling an obligation against an already-authorised ceiling is not money
movement.

| Table                       | Status                                                                    | Key columns                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow_holds`              | ✅ live `20260904121000`, written by `accept_offer` + the reconcile sweep | `id`, `task_id`, `project_id`, `charge_id`, `amount numeric(12,2) > 0`, `currency`, `state` checked text (`held\|released\|refunded`), `idempotency_key` UNIQUE |
| `ledger_entries`            | ✅ live `20260904122000`, written by the same two                         | `id`, `account`, `debit`/`credit numeric(12,2) >= 0` with `check ((debit = 0) <> (credit = 0))`, `currency`, `ref_type`, `ref_id`, `created_at`                 |
| `payouts`                   | ⏳ slice 7, with `held → released`                                        | `id`, `node_id`, `transfer_id`, `amount`, `platform_fee`, `state`, `idempotency_key` UNIQUE                                                                     |
| `subscriptions`             | ⏳ no slice; nothing bills anybody                                        | `id`, `user_id`, `tier`, `status`, `current_period_end`                                                                                                         |
| `platform_fees`, `invoices` | ⏳ with the first transfer                                                | —                                                                                                                                                               |

**`escrow_holds` lifecycle.** `private.escrow_transition_allowed` permits exactly
`held → refunded`, whose producer is `apps/api/src/lib/escrow-reconcile.ts`.
**`released` is in the check constraint and out of the map**: the constraint is
the column's vocabulary and the map is what can be done today, and release's
producer is the payout slice. A `security definer` trigger validates, stamps
`updated_at` and writes `escrow.transitioned`, with a `when (old.state is
distinct from new.state)` clause so an ordinary edit is not read as a
self-transition. It binds `service_role`.

**`escrow_holds` RLS and grants.** One policy,
`escrow_holds_select_member` (`private.is_project_member(project_id)`), and
`grant select` to `authenticated`: a hold names no node, so what it tells a member
is how much of their own ceiling is spoken for. `delete` and `truncate` are
revoked **including from `service_role`**.

**`ledger_entries` has the strictest posture in the schema.** RLS enabled with
**no policy and no client grant at all**, the `events` shape: the reader of raw
entries is the Phase-3 ops console, and a member's view of money is the
projection. `update`, `delete` and `truncate` are revoked **including from
`service_role`**, because append-only that binds only clients is not append-only.
Balance is a property of two rows and cannot be a constraint, so it is enforced by
the pair constructors in `packages/payments` and pinned by pgTAP as
`sum(debit) = sum(credit)` per `ref_id`. `account` is text validated by a reviewed
file rather than an enum, on `channel_connections.provider`'s precedent.

- Money movements are **idempotent** (unique `idempotency_key`) and **event-sourced**; the ledger is append-only.
- **`projects.budget_ceiling` now has two classes of committer**: non-terminal campaign `budget_cap`s and `escrow_holds` at `state = 'held'`. Four places compute that sum and must move in step ([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)). This is still not a CHECK constraint, on this file's standing ground: a constraint is a rule the database applies to itself with no idea what was authorised.

## Marketing schema

The first vertical's domain. All four tables are **live** (`20260829120000` …
`20260829123000`); the narrative and the three deliberate stances are at the top
of this file. `content_items`, `creative_assets`, `email_sequences`,
`landing_pages` and `creative_performance` remain design-only, tracked in
[marketing-growth-engine.md](../30-modules/marketing-growth-engine.md).

| Table                 | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `campaigns`           | `id`, `project_id`, `task_id?`, `name`, `objective`, `channel` (meta/google/email/organic_social), `state` (draft→ready→publishing→live→paused→completed, plus cancelled/failed), `budget_cap` (**NULL = nothing authorised**), `cpa_ceiling` (**NULL = optimizer abstains**, > 0 CHECKed, `20260830120000`), `currency`, `pause_reason` (CHECKed to its four values since `20260830120000`), `source_embed_id` UNIQUE, `created_by` |
| `channel_connections` | `id`, `room_id`, `connected_by`, `provider` (registry-validated), `channel`, `external_account_id`, `granted_scopes[]`, `access_token`, `refresh_token`, `token_expires_at`, `status` (active/expired/revoked), UNIQUE `(room_id, provider, external_account_id)`                                                                                                                                                                    |
| `ad_entities`         | `id`, `campaign_id`, `project_id`, `parent_id?`, `kind` (campaign/ad_set/ad), `state` (…/rejected/archived), `external_id?`, `channel_connection_id?`, `spec` JSONB, `idempotency_key` UNIQUE                                                                                                                                                                                                                                        |
| `campaign_outcomes`   | `id`, `campaign_id`, `project_id`, `period_start`, `period_end`, `spend`, `impressions`, `clicks`, `conversions`, `revenue`, `metrics` JSONB, `source` (`pull_metrics`/`manual`, CHECKed since `20260829160000`), UNIQUE `(campaign_id, period_start, period_end, source)`                                                                                                                                                           |

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
  which is where rule 7 puts it. The same stance holds for `cpa_ceiling`: the
  check constraints refuse malformed values (0, negative), and the judgement
  itself is `decideCpaBreach` in tool code.
- **`cpa_ceiling`'s NULL inverts the budget columns', and both comments say so.**
  An unset spend authorisation blocks (`NULL = nothing authorised`); an unset
  judgement threshold abstains (`NULL = the optimizer does not judge this
campaign`). Setting it authorises the automatic pause
  ([ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)). New event
  verbs with this slice: `campaign.cpa_ceiling_set` (explicit `actor_id`, the
  authorisation), `campaign.auto_paused` (`actor_kind = 'system'`, carrying the
  breach arithmetic), and `campaign.resumed` (explicit `actor_id`), beside the
  trigger-written `campaign.transitioned` whose `paused → live` count is what
  the pause idempotency key's epoch is derived from.

## RAG schema

| Table                          | Key columns                                                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_sources`            | `id`, `url`, `authority`, `crawl_cadence`, `last_crawled`, `content_hash`                                                                                |
| `documents`                    | `id`, `source_id`, `jurisdiction`, `business_type`, `doc_type`, `effective_date`, `valid_from`, `valid_to`, `content_hash`, `version`, `lang`            |
| `doc_chunks`                   | `id`, `document_id`, `parent_id`, `chunk_text`, `context_prefix`, `embedding halfvec(1024)`, `fts tsvector` (generated), `metadata` JSONB, `embed_model` |
| `suppliers`, `cost_benchmarks` | **typed rows**, not prose chunks (structured retrieval)                                                                                                  |
| `eval_golden_set`              | `id`, `query`, `expected`, `jurisdiction`                                                                                                                |
| `retrieval_gaps`               | `id`, `core`, `surface`, `goal` (scrubbed), `reason`, `candidates_considered`, `chunks_retrieved`, `top_sources` JSONB, `room_id`, `created_at`          |

**Indexes:** HNSW on `doc_chunks.embedding` (`halfvec_cosine_ops`, `m=16`, `ef_construction=200`), GIN on `fts`, partial btree on filter columns (`market`, `business_type`, `doc_type`) and on `(valid_from, valid_to)`.

Details worth knowing before touching this schema:

- **`fts` is a generated column with a per-row language.** `to_tsvector(regconfig, text)` is `IMMUTABLE` (unlike the single-argument form), which is what allows the config to come from the row's own `lang` column. That keeps sparse retrieval multilingual with no trigger to maintain.
- **`doc_chunks.owner_project_id` is denormalised** from `documents` by a trigger. It exists so the tenant predicate on the hot retrieval path is a plain column test rather than a join or a per-row function call. Never write it from application code.
- **Tenant-scoped rows are denied to clients, not guessed at.** `owner_project_id is null` (the shared reference corpus) is all `authenticated` may read. There is no projects/membership table yet, so there is nothing to check ownership against, and defaulting to visible would be a leak waiting for the flywheel to populate that column. Widen the policy in the same migration that adds projects.
- **`retrieval_gaps` is the corpus's own feedback loop and holds no vectors.** It sits in the RAG schema because it is read while deciding what to ingest, not because retrieval touches it. Nothing in the request path reads it, the AI service only ever inserts, and the write is fire-and-forget so a bad minute at PostgREST cannot slow a refusal. `goal` is scrubbed of emails, URLs, phone numbers and long digit runs (`redact.scrub`) before it is stored, because rule 8 keeps PII out of logs and the index and a new store does not get a new posture. It is deliberately **not** stripped of the audience or product noun, which is the opposite trade from `intake.strip_particulars` and for a stated reason: a ledger whose rows all read "how do I get more [redacted] for my [redacted]" records that something was refused and nothing about what.
- **`hnsw.ef_search` and `hnsw.iterative_scan` are set at runtime** inside `hybrid_search` via `set_config(..., is_local => true)`, not in the function's `SET` clause. Postgres validates that clause at `CREATE` time and `postgres` is not superuser on Supabase, so the clause form fails with "permission denied to set parameter". `iterative_scan` matters specifically because retrieval applies hard filters: without it the HNSW scan returns its k nearest and the `WHERE` then discards most of them, silently under-filling the candidate list.

## RLS policy model

- **Every table is RLS-on.** Access is derived from **membership**, not a bare `user_id = auth.uid()`:
  - Chat: a row in `room_members` (respecting `scope` and `expires_at`) gates `messages`/`channels`/`threads`. **`scope` is enforced since `20260901122000`**, having been an unread column with no check constraint for 44 migrations. Three helpers express it — `private.member_scope_covers(room, thread)`, `..._channel(room, channel)` and `..._message(message)` — each taking the row's own thread rather than deriving it. `member_scope_covers(room, null)` is the established reading for "room-scoped members only" and is how `feedback_events` is gated. `private.is_room_member` is deliberately unchanged and still backs `rooms_select_member`, so a thread-scoped member sees the room shell: a client that cannot read the room cannot render anything at all. `room_members`' own policy is the exception, because there the rows _are_ the scopes ([ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md)).
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
- **A check constraint that calls a function is not re-validated when the function changes.** Postgres validates a constraint when it is added and never again, so editing the body of something like `private.is_jurisdiction_code` (`20260831120000`) leaves every existing row passing a rule it no longer satisfies, silently. Any migration that changes such a function must `alter table … validate constraint` (or drop and re-add the constraint) for every table that calls it, in the same change.
- Any change here requires updating this doc (owner in `.docmeta.yml`) and, if it changes tenant isolation, [security-compliance.md](security-compliance.md).

## `offers` (marketplace slice 4, `20260903120000`)

One offer of one task to one node. **The first table in the marketplace domain to
land with its writers**, inverting the guards-before-writers ordering the other
four followed, because `20260831120000:27-33` deferred it precisely on the
grounds that "its entire content is a lifecycle" and a transition map nobody can
exercise is the `ad_entities` mistake.

| Column           | Type                   | Notes                                                                               |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `id`             | `uuid` pk              |                                                                                     |
| `task_id`        | `uuid not null`        | → `tasks` cascade                                                                   |
| `project_id`     | `uuid not null`        | → `projects` cascade. Denormalised so the guard trigger's audit event needs no join |
| `node_id`        | `uuid not null`        | → `node_profiles(user_id)` cascade                                                  |
| `round`          | `int not null`         | Which cascade pass. Re-derived from the task's own transition history               |
| `status`         | `public.offer_status`  | `open` is the only non-terminal value                                               |
| `expires_at`     | `timestamptz not null` | Compared at read time; the sweep settles the row for the trail only                 |
| `declined_at`    | `timestamptz`          | Required when `status = 'declined'`                                                 |
| `decline_reason` | `text`                 | ≤ 500 chars, and only on a decline                                                  |

**Enum `public.offer_status`:** `open | declined | expired | withdrawn |
accepted`. Four settlements because they answer different questions. `accepted`
was declared (add-value is irreversible) and **unreachable for two slices**,
becoming reachable in `20260904124000` once `accept_offer` could fund escrow in
the same transaction.

**Lifecycle:** `private.offer_transition_allowed` permits exactly `open →
declined | expired | withdrawn | accepted`, all four terminal. One `security
definer` trigger validates and writes the `offer.transitioned` audit event, with a
`when (old.status is distinct from new.status)` clause so an ordinary edit is not
read as a self-transition. The trigger binds `service_role`, so no writer can
route around the map.

**Three uniqueness rules carry the design.** `(task_id, round)` is the sweep's
replay contract: a pass that inserted and crashed re-derives the same round and
collides rather than opening a second offer. `(task_id, node_id)` means a node is
asked once ever. A partial unique on `(task_id) where status = 'open'` makes
one-at-a-time cascade structural.

**RLS and grants.** One policy, `offers_select_own` (`node_id = auth.uid()`), and
`grant select` to `authenticated`. **The project owner reads zero rows, and still
does after slice 5**, which is deliberate and pgTAP-asserted. The counterparty
pair opened through `engagements` (`20260904126000`), so the owner learns who took
their step; an offer names everybody who was _asked_, including the people who
declined, and publishing that trail is a separate disclosure decision. `delete`
and `truncate` are revoked **including from `service_role`**, the
`node_verifications` precedent.

**New index on `tasks`** (`20260903121000`): `tasks_market_idx (state) where state
in ('matching','offered')`. The other two task indexes are project-scoped and
serve the scheduler; the matcher is the first reader that asks a question across
all projects.

**New event verbs:** `offer.transitioned` (trigger), `offer.created` (the sweep,
`system`), `offer.declined` (the route, `actor_kind = 'node'` with the node's id),
and `task.match_requested` (the dispatch route, with the owner's id).

## `engagements` (marketplace slice 5, `20260904120000`)

One deal: one node took one task at one price. **No state column**
([ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md)) because
every state it could carry is a `public.task_state` already under trigger
enforcement. `tasks.state` carries the fact about the **work**; this carries facts
about the **deal**.

| Column                                       | Type                       | Notes                                                                                                 |
| -------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                                         | `uuid` pk                  |                                                                                                       |
| `task_id`                                    | `uuid not null`            | → `tasks` cascade                                                                                     |
| `project_id`                                 | `uuid not null`            | → `projects` cascade. Denormalised, the `offers` precedent                                            |
| `node_id`                                    | `uuid not null`            | → `node_profiles(user_id)` cascade                                                                    |
| `offer_id`                                   | `uuid not null` **UNIQUE** | `accept_offer`'s entire idempotency contract. A new cascade round is a new offer, so it is epoch-ed   |
| `agreed_price`                               | `numeric(12,2) > 0`        | **Frozen at acceptance.** Deliberately does not follow `node_profiles.rate`                           |
| `currency`                                   | `text not null`            | Checked against the project's before the insert                                                       |
| `accepted_at`                                | `timestamptz`              |                                                                                                       |
| `deadline_at`, `nda_signed_at`, `terms_hash` | nullable                   | **No writer and no reader in slice 5.** The e-signature step is not built; the shape is settled       |
| `ended_at`, `outcome`                        | nullable                   | `completed \| reassigned \| cancelled \| disputed_resolved`, bound to `ended_at` by an equality check |

**One live engagement per task**, as `engagements_one_live_idx (task_id) where
ended_at is null`. Partial rather than plain, because a reassignment after a
no-show creates a **second** engagement and a plain unique would forbid the
recovery path the machine exists to support.

**Write-once guard.** `private.guard_engagement_end()` (SECURITY DEFINER) refuses
any change to `task_id`, `node_id`, `offer_id`, `agreed_price` or `currency`,
refuses un-ending, refuses re-outcoming, and writes `engagement.ended` in the same
trigger so an entry cannot be forgotten by a caller.

**RLS and grants.** Two policies, and the second is the deliberate opening of "who
took my step": `engagements_select_node` (`node_id = auth.uid()`) and
`engagements_select_member` (`private.is_project_member(project_id)`). `delete`
and `truncate` are revoked including from `service_role`; UPDATE survives because
ending a deal is an update and the guard is what constrains it.

## `accept_offer` (marketplace slice 5, `20260904125000`)

`public.accept_offer(p_offer_id uuid, p_charge_id text) returns uuid`, `security
invoker`, granted to `service_role` alone. The fifth writer of
`materialise_campaign`'s kind and the first that commits money. In order:
idempotency before validation (via `engagements.offer_id`); the offer read and
checked open on **Postgres's** clock; the price frozen from `node_profiles` with
an hourly rate refused; `select ... for update` on the project, then the ceiling
re-checked over **both** committer classes; the three arcs as conditional UPDATEs
so every guard fires and every audit row is trigger-written; the engagement, hold
and balanced ledger pair; the thread created-or-found; the node admitted
thread-scoped; and explicit `events` rows for the three things an INSERT created.

**No task-map migration ships in slice 5.** `offered → claimed` and
`claimed → escrow_funded` have been in `private.task_transition_allowed` since
`20260813120000` and simply gain a producer.
[ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md) records why
`claimed → matching` stays dropped: both moves are in one transaction, so
`claimed` is transit-only.

**New event verbs:** `engagement.created`, `engagement.ended` (trigger),
`escrow.transitioned` (trigger), `thread.created`, `node.admitted`, and
`offer.accepted` (the route, `actor_kind = 'node'` with the node's id).

## `private.engaged_counterparty` (marketplace slice 5, `20260904126000`)

The counterparty pair, deferred by name in `20260831120000`, `20260901122000` and
`20260901123000` and written once here. SECURITY DEFINER, `stable`, EXECUTE to
`anon` and `authenticated`, backing a **second** policy on `public.profiles`
(`profiles_select_counterparty`). `private.shares_room_with` is untouched, so the
roster narrowing cannot be lost by editing the counterparty rule.

**It joins through `engagements`, never through `room_members.thread_id`**, and
that is the whole design. A membership row outlives the work, so a predicate over
memberships would need a second copy of the time-box; the owner is room-scoped and
shares no thread with the node, so "we share a thread" is false for exactly the
person the owner half exists to serve. `ended_at is null` is the entire time-box:
ending the engagement closes the pair again.

**`node_profiles` and `offers` stay closed**, deliberately. What opens is
`profiles`: a display name and the basics a chat surface needs.
