-- 20260831120000_marketplace_node_profiles.sql — the marketplace gets its domain.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md (the module this serves)
--
-- **`escalated` is the last live dead end in the product.** `router.ts:93` sends
-- every human-owned step there with the reason "Needs expert human judgement, so
-- it goes to the marketplace", and the marketplace does not exist; the code says
-- so in five separate places. Twelve tasks sit in that state on the live database
-- right now, which is the same measurement `20260827120000` made (seventeen) when
-- it gave the owner a way to unstick their own project. That migration said, in
-- as many words, "this is not the marketplace and must not be dressed up as one".
-- This is the marketplace, starting where the marketing domain started.
--
-- **Zero new capability.** No route, no adapter, no registry, no client grant
-- that permits a write. There is nothing a person can do after this migration
-- that they could not do before it, and that is the point: this is
-- `20260829120000`…`123000` again, four tables landing with their guards ahead of
-- their writers, because the recorded failure in this repository is the other
-- order. `tasks.risk_tier` was unreachable for its entire life. `task_deps` held
-- no row for two weeks while enforcing an empty set. `artifacts.storage_path` had
-- no bucket. `projects.budget_ceiling` had no writer. And `profiles.role` had a
-- guard that was only ever a sentence in a comment (`20260831110000`, the
-- migration immediately before this one, which exists **because** of this one:
-- `human_node` is about to mean "eligible for paid work funded from somebody
-- else's authorised budget").
--
-- **Three of the module's nine entities land, plus one the module does not name.**
-- `offers`, `engagements`, `proof_artifacts`, `ratings` and `disputes` are
-- deferred with triggers recorded in human-nodes-marketplace.md. Four is the
-- ceiling and `offers` is specifically the wrong fifth: its entire content is a
-- lifecycle, and landing a transition map for transitions nobody can make is the
-- `ad_entities` mistake this repository has already corrected once
-- (`20260829150000`).
--
-- **What is NOT here, deliberately, and is the whole reason the sequence is
-- ordered this way:** nobody is admitted to any room. `security-compliance.md`
-- records twice that room membership is coarser than the thread-scoped,
-- time-boxed access a node requires, and that the narrowing "lands with threads".
-- Threads are the next slice, before any writer can admit anyone. The narrowing
-- is therefore never actually taken.

-- ---------- Enums ----------

-- `pending` is distinct from `unverified` for the reason `campaign_state` keeps
-- `publishing` apart from `live`: between the request and the provider's answer
-- the honest sentence is "we asked", and that is a state rather than a shade of
-- not-verified. It is also what lets `node_verifications` hold no pending row and
-- stay append-only.
--
-- `rejected` and `suspended` are both blocks on matching and are kept apart
-- because they differ in **what can undo them**. `rejected` means the check failed
-- at onboarding and the same evidence will fail again; `suspended` means a
-- verified node lost eligibility on fraud flags or ratings and a review can
-- restore them. Collapsed into one value, "can this person try again" becomes
-- unanswerable from the row.
--
-- There is deliberately no `expired`. A state you must run a clock to enter is a
-- state that is wrong between sweeps. Credential expiry is a date column on
-- `node_credentials` and is evaluated at match time.
create type public.kyc_status as enum (
  'unverified',  -- nothing submitted
  'pending',     -- asked; the provider has not answered
  'verified',
  'rejected',    -- failed at onboarding; the same evidence will fail again
  'suspended'    -- was verified, lost eligibility; a review can restore it
);

-- `busy` is deliberately not a value. Current workload is derivable by counting
-- live engagements, and a stored `busy` would need writing by whatever admits and
-- releases a node, which is a writer that does not exist and two places to forget.
-- human-nodes-marketplace.md already treats workload as a **ranking** input
-- ("load-balancing"), not an eligibility gate, which is the tell.
create type public.node_availability as enum (
  'available',
  'paused',      -- temporarily not taking work; still verified
  'offboarded'   -- gone; kept for the audit trail on past engagements
);

-- ---------- Jurisdiction codes ----------
--
-- human-nodes-marketplace.md specifies PostGIS for service geo. This departs from
-- it, and rule 1 makes that a reconciliation rather than a silent divergence:
-- see ADR-0015 and the module doc, both edited in this change.
--
-- The short version is that the matching rule as written is not a geometry query.
-- "service geo/jurisdiction includes the task location ... jurisdiction exactness
-- (Austin-local > Texas-state)" is a **containment test over a hierarchical code
-- plus a specificity ordering**: `US-TX-AUSTIN` is inside `US-TX` is inside `US`,
-- and exactness is the segment count. A prefix test answers both, exactly.
-- PostGIS answers a different question, radius and polygon, which this module
-- needs exactly once (on-site inspection within n km of a point) and which no
-- task can ask today, because `projects.market` and `documents.jurisdiction` are
-- both free text.
--
-- The decisive argument is representation rather than cost: the RAG corpus, the
-- task location and the jurisdiction packs are all already text, and storing node
-- service area as geometry would give one question two representations that must
-- be kept in step. That is precisely the `is_project_member` / `roomForProject`
-- defect (`20260827110000`) which cost six projects, forty-seven tasks and
-- twenty-eight artifacts their visibility.
--
-- **Recorded trap:** Postgres does not re-validate an existing check constraint
-- when a function it calls changes. Any later migration that edits this shape
-- must `alter table ... validate constraint`, or drop and re-add. Written into
-- data-model.md §Migration conventions in this same change.

create function private.is_jurisdiction_code(p_code text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_code ~ '^[A-Z]{2}(-[A-Z0-9]{1,10}){0,2}$';
$$;

create function private.is_jurisdiction_code_array(p_codes text[])
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_codes is not null
     and not exists (
       select 1 from unnest(p_codes) c where not private.is_jurisdiction_code(c)
     );
$$;

-- `grant execute` to `service_role` alone, and that is not an oversight. A check
-- constraint is evaluated with the privileges of the writing role, and no client
-- role holds INSERT or UPDATE on any table in this domain, so `authenticated`
-- never evaluates it and never needs it. Keeping these out of `authenticated`'s
-- reach also keeps lints 0028/0029 clear: they live in `private` and are never
-- referenced from a policy.
revoke all on function private.is_jurisdiction_code(text) from public;
revoke all on function private.is_jurisdiction_code_array(text[]) from public;
grant execute on function private.is_jurisdiction_code(text) to service_role;
grant execute on function private.is_jurisdiction_code_array(text[]) to service_role;

-- ---------- Tables ----------

-- `user_id` is the primary key, and that is the load-bearing choice. `profiles`
-- already keys on `user_id` (`20260724000000`) and a node **is** a user. Doing the
-- same here makes every child table's tenant predicate a plain `node_id =
-- auth.uid()` equality: no join, and no denormalised tenant column to drift. That
-- is `ad_entities.project_id`'s "the tenant predicate on a hot path should not be
-- a subquery" reached by a better road, because there is no copy at all.
create table public.node_profiles (
  user_id               uuid primary key references public.profiles (user_id) on delete cascade,
  kyc_status            public.kyc_status not null default 'unverified',
  kyc_status_changed_at timestamptz,
  availability          public.node_availability not null default 'paused',
  -- NULL means cold start, never zero. Zero would mean measured and worthless,
  -- which is the invented-zero the metrics sweep already refuses ("a zero claims
  -- a day was measured and found to have none"). Written by ratings, slice 8.
  trust_score           numeric(5, 4),
  completed_engagements integer not null default 0,
  -- Hierarchical codes, not geometry. Argued in ADR-0015.
  service_jurisdictions text[] not null default '{}',
  languages             text[] not null default '{}',
  -- NULL means nothing quoted and therefore ineligible, never free. Same stance
  -- as `campaigns.budget_cap`, which means nothing authorised and never
  -- unlimited, inverted the way this column needs. numeric(12, 2) matches
  -- `projects.budget_ceiling` and `campaigns.budget_cap` exactly, because the
  -- matcher's rule is `rate <= escrowed budget` and two scales would make that
  -- comparison a rounding question.
  rate                  numeric(12, 2),
  rate_period           text,
  currency              text not null default 'USD',
  suspended_reason      text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- **The single most valuable line in this migration.** An unverified node in
  -- the matching pool is unrepresentable at the database rather than merely
  -- refused by the matcher. Rule 7 puts eligibility in tool code; this is the one
  -- condition with no second layer behind it, so it also lives where no prompt
  -- reaches. Stated as a check because it needs no other row to decide, exactly
  -- like `ad_entities_root_has_no_parent`.
  constraint node_profiles_available_requires_kyc check (
    availability <> 'available' or kyc_status = 'verified'
  ),

  -- Deliberately stricter than `campaigns.pause_reason`, which is unconstrained.
  -- The divergence is that one stops spend and this one stops a person earning: a
  -- suspension with no recorded reason can be neither defended nor lifted.
  constraint node_profiles_suspended_has_reason check (
    kyc_status <> 'suspended' or suspended_reason is not null
  ),

  -- A ranking weight outside its own scale silently reorders the pool.
  constraint node_profiles_trust_score_range check (
    trust_score is null or (trust_score >= 0 and trust_score <= 1)
  ),

  -- `120.00` with no period is unusable by the comparison the whole match rests
  -- on, and a period with no figure quotes nothing.
  constraint node_profiles_rate_has_period check ((rate is null) = (rate_period is null)),
  constraint node_profiles_rate_period_known check (
    rate_period is null or rate_period in ('hour', 'task')
  ),
  -- Zero is a kill switch wearing the shape of a price, which is the argument
  -- `20260830120000` makes for refusing a `cpa_ceiling` of 0.
  constraint node_profiles_rate_positive check (rate is null or rate > 0),

  constraint node_profiles_completed_nonneg check (completed_engagements >= 0),

  constraint node_profiles_jurisdictions_wellformed check (
    private.is_jurisdiction_code_array(service_jurisdictions)
  )
);

-- The matcher's pool query, and only it. Partial on the eligibility condition
-- because every other row is irrelevant to the one query this index exists for.
create index node_profiles_eligible_idx
  on public.node_profiles (availability)
  where kyc_status = 'verified';

-- The geo containment filter.
create index node_profiles_jurisdictions_idx
  on public.node_profiles using gin (service_jurisdictions);

-- There is deliberately **no index on `languages`**. It is a post-filter on an
-- already-small pool, and an index with no query is the same defect class as a
-- guard with no writer. It lands with the matcher if the matcher needs it.

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.node_profiles enable row level security;

-- Own row only. **There is deliberately no counterparty policy**, and its absence
-- is a decision rather than an omission: the owner of a task must eventually see
-- the node engaged on it, but that policy joins through `engagements`, which does
-- not exist. A policy that cannot yet be written correctly should not be written
-- approximately. Asserted in `supabase/tests/marketplace_rls.sql`: an owner
-- sharing a room with a node sees zero node profiles today.
create policy "node_profiles_select_own" on public.node_profiles
  for select using (user_id = auth.uid());

-- **`authenticated` gets no INSERT and no UPDATE, diverging deliberately from
-- `profiles`**, which grants column-level update (`20260831110000`).
-- `kyc_status`, `trust_score`, `availability` and every `verified` flag in this
-- domain are exactly the fields a fraudster would set on themselves, and
-- self-attested verification is the definition of the vector this module exists
-- to kill. Onboarding writes through a route in slice 3.
grant select on public.node_profiles to authenticated;
grant all on public.node_profiles to service_role;

-- ---------- The KYC audit trigger ----------
--
-- The audit half lands now and the **transition map does not**, and that split is
-- the line this slice draws: a guard lands here if and only if it is decidable
-- from the row in front of it. Structural invariants need no writer's
-- cooperation to be right. A lifecycle map is only correct with respect to a
-- sequence a writer drives, and landing one for transitions nobody can make is
-- the `task_deps` defect. `ad_entities` is the precedent that fits exactly: its
-- hierarchy guard landed immediately, its transition guard came with the
-- publisher (`20260829150000`).
--
-- The audit half is not a lifecycle. It lands now so that slice 3's writer cannot
-- produce an unaudited KYC change even on its first commit -- AML wants the trail
-- from the first row, not from the first correct row. The `kyc_status` map joins
-- this same function in that slice, beside the insert rather than instead of it,
-- because the house rule is one trigger for both so that an audit entry cannot be
-- forgotten by a caller and cannot describe a transition that did not happen.
--
-- `events.project_id` is left null: node identity is not project-scoped. The
-- column is nullable (`20260813120000:196`) and the only existing reader filters
-- on `subject_id`, so nothing is affected.

create function private.guard_node_kyc_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.kyc_status_changed_at := now();
  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    null,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'node.kyc_status_changed',
    'node',
    new.user_id,
    jsonb_build_object(
      'from', old.kyc_status,
      'to', new.kyc_status,
      'availability', new.availability,
      'suspended_reason', new.suspended_reason
    )
  );

  return new;
end;
$$;

revoke all on function private.guard_node_kyc_audit() from public;

-- The `when` clause matters here for the reason it matters on `campaigns`,
-- `ad_entities` and `tasks`: without it every ordinary edit -- a rate change, a
-- new language -- would stamp `kyc_status_changed_at` and write an audit event
-- describing a transition from a status to itself.
create trigger node_profiles_guard_kyc_audit
  before update on public.node_profiles
  for each row
  when (old.kyc_status is distinct from new.kyc_status)
  execute function private.guard_node_kyc_audit();

-- ---------- Comments ----------

comment on table public.node_profiles is
  'An expert marketer available to take escalated work. Keyed on user_id because a node '
  'IS a user, which makes every child table''s tenant predicate a plain equality. '
  'Own-row readable, server-written: no client INSERT or UPDATE grant exists, because '
  'kyc_status and trust_score are exactly what a fraudster would set on themselves.';

comment on column public.node_profiles.trust_score is
  'Ranking weight in [0,1]. NULL means cold start, never zero: zero would mean measured '
  'and worthless. Written by ratings (slice 8); the column lands now so that writer '
  'arrives to a column rather than to a migration.';

comment on column public.node_profiles.rate is
  'What the node charges. NULL means nothing quoted and therefore ineligible, never free. '
  'numeric(12, 2) to match projects.budget_ceiling, since the matcher compares them.';

comment on column public.node_profiles.service_jurisdictions is
  'Hierarchical codes (US, US-TX, US-TX-AUSTIN), not geometry. Containment is a prefix '
  'test and exactness is the segment count. See ADR-0015.';

comment on function private.guard_node_kyc_audit() is
  'Stamps kyc_status_changed_at and writes the audit event on every KYC status change. '
  'The lifecycle MAP is deliberately absent until slice 3 supplies a writer whose '
  'transitions could be wrong; the audit half lands now so no KYC change is ever '
  'unaudited, including the writer''s first.';
