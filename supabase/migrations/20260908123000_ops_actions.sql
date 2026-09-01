-- 20260908123000_ops_actions.sql — what an operator did, and why they said they did it.
-- Owner doc: docs/30-modules/admin-ops.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/security-compliance.md,
--       docs/30-modules/auth-identity.md
--
-- Marketplace slice 8, fourth migration. admin-ops.md:25 states the rule this
-- table exists to make true: "every ops action is written to `ops_actions`
-- (audited). **No destructive action without a trail.**"
--
-- ---------- Why `events` cannot do this job ----------
--
-- `events` is a good audit trail and it is the wrong one here, for three
-- reasons, none of which is fixable by writing to it more carefully.
--
-- **1. It cannot tell an operator from a sweep.** Every writer in this system
-- that runs as `service_role` writes with no JWT, so `auth.uid()` is null and
-- the house `actor_kind` idiom resolves to `'system'` with a null `actor_id`.
-- `settle_payout:219` hardcodes exactly that. An ops action arrives through the
-- same door, so in `events` a person releasing somebody's money would be
-- indistinguishable from the payout sweep doing it on schedule. The whole point
-- of an ops trail is the opposite of that distinction being lost. Here
-- `actor_id` is `not null` and there is no `'system'` branch: **if nobody can be
-- named, nothing is written, because the write fails.**
--
-- **2. It has nowhere to put a reason.** `events.payload` could carry one, but
-- carrying one and requiring one are different guarantees, and admin-ops.md
-- requires one. `reason` here is `not null` and checked non-empty, so a
-- resolution with no stated grounds cannot be recorded — which means it cannot
-- happen, because `resolve_dispute` writes this row inside the same transaction
-- that moves the money.
--
-- **3. It is project-scoped.** `events.project_id` is nullable but every index
-- and every reader assumes it, and ops acts on subjects that are not inside a
-- project at all: a node, a payout, a source. This table is keyed on
-- `(subject_type, subject_id)` and knows nothing about projects.
--
-- Both trails are written. `events` keeps recording what happened to the domain
-- objects, from the triggers that enforce the transitions; this records who
-- decided it and on what grounds. They answer different questions and a dispute
-- console shows both.
--
-- ---------- The posture is `events`', deliberately stricter ----------
--
-- RLS on, **zero policies, zero client grants**, and `update` / `delete` /
-- `truncate` revoked from `service_role` itself. `20260813120000:521-524` notes
-- that `truncate` is the one people miss; it is revoked here too.
--
-- The reader is `apps/api/src/routes/ops.ts` behind
-- `apps/api/src/plugins/require-ops.ts`, as `service_role`. There is no policy
-- an operator could read this through, because a policy would have to test
-- `profiles.role`, and RLS cannot do that without a SECURITY DEFINER helper in
-- `public` — the shape security-compliance.md:99 records being reintroduced once
-- by somebody who had read the migration that fixed it. The API-layer role check
-- plus zero client grants is the defense-in-depth here, and it is the same one
-- `ledger_entries` has had since `20260904122000`.

-- ---------- Table ----------

create table public.ops_actions (
  id           uuid primary key default gen_random_uuid(),

  -- **The operator, and never null.** See the header: this column is the entire
  -- reason this table exists rather than a verb in `events`. It is passed
  -- explicitly into `resolve_dispute` as `p_actor_id` rather than read from
  -- `auth.uid()`, because the RPC runs as `service_role` where `auth.uid()` is
  -- null by construction.
  actor_id     uuid not null references auth.users (id),

  -- What was done, as a dotted verb matching the `events` vocabulary
  -- (`dispute.resolve`). Free text on `events.verb`'s precedent and for its
  -- reason: a check constraint here would need editing by every future console,
  -- and the set of things an operator can do is bounded by which RPCs exist, not
  -- by this column.
  action       text not null check (char_length(btrim(action)) between 1 and 64),

  -- What it was done to. Not a foreign key, on `events`' shape: ops acts across
  -- domains and a union of eight nullable references would be worse than a pair.
  subject_type text not null check (char_length(btrim(subject_type)) between 1 and 32),
  subject_id   uuid not null,

  -- **Why, and never null.** admin-ops.md:25. Checked non-empty rather than
  -- merely non-null, because `''` would satisfy `not null` and satisfy nobody
  -- reading this in six months.
  reason       text not null check (char_length(btrim(reason)) between 1 and 4000),

  -- The arithmetic and the arcs, on data-model.md:77's rule: "the numbers a
  -- decision rested on belong where a dispute can read them." For a resolution
  -- this carries the task arc, the amounts, the hold ids and the engagement
  -- outcome, so the row is readable without re-deriving any of it.
  payload      jsonb not null default '{}',

  created_at   timestamptz not null default now()
);

-- The console lists an operator's own history, and an audit read starts from the
-- subject.
create index ops_actions_subject_idx on public.ops_actions (subject_type, subject_id, created_at desc);
create index ops_actions_actor_idx on public.ops_actions (actor_id, created_at desc);

-- ---------- RLS and grants ----------

alter table public.ops_actions enable row level security;

-- **No policy, and that is the design.** `ledger_entries` and `events` both do
-- this, and the `rls_enabled_no_policy` advisor lint it produces is the correct
-- reading of the intent rather than a finding to clear
-- (`20260904122000:31-42`). Nothing reachable by a client role may read this.

grant insert, select on public.ops_actions to service_role;

-- Append-only, **including for `service_role`**, which is stricter than every
-- money table in this schema and deliberately so. `escrow_holds` and `payouts`
-- keep UPDATE because settling is an update; nothing here is ever settled. An
-- ops trail that trusted code can edit is not a trail, and the account being
-- protected from is the one the operator is using.
revoke update, delete, truncate on public.ops_actions from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.ops_actions is
  'Who did what as an operator, and on what stated grounds (admin-ops.md: no destructive action '
  'without a trail). Separate from events because events cannot distinguish an operator from a '
  'sweep - every service_role write lands there as actor_kind system with a null actor_id - and '
  'because a reason is required here rather than merely possible. Append-only including for '
  'service_role. No policy and no client grant: the reader is apps/api/src/routes/ops.ts behind '
  'the require-ops role check.';

comment on column public.ops_actions.actor_id is
  'The operator, never null. Passed explicitly into the RPC as p_actor_id, because these '
  'functions run as service_role where auth.uid() is null by construction. If nobody can be '
  'named the insert fails, which is the intended failure.';

comment on column public.ops_actions.reason is
  'Why, never null and never blank. Written in the same transaction as the act it explains, so '
  'an unexplained resolution cannot be recorded and therefore cannot happen.';
