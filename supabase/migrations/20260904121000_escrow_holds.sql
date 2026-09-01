-- 20260904121000_escrow_holds.sql — an obligation is modelled. **Nothing is
-- charged.**
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/security-compliance.md,
--       docs/40-adr/0011-spend-cap-checked-twice.md,
--       docs/40-adr/0020-the-ceiling-has-two-committer-classes.md
--
-- **Read this paragraph before reading the table.** No money moves in this
-- migration or in any code that writes to it. There is exactly one registered
-- payment provider and it is `packages/payments/src/fake-provider.ts`, an in-repo
-- deterministic fake that makes no network call, holds no key and settles
-- nothing. `carriesRealMoney` on the provider registry is the enforced half of
-- that, in the shape `carriesRealCredentials` and `carriesRealPii` already have:
-- the API writer refuses before any rpc, so the first person to wire Stripe hits
-- a failing write rather than a paragraph they did not read.
--
-- **The counsel gate in payments-billing.md is unmoved by this file.** That gate
-- reads: before real (non-test) money moves, clear money-transmission and
-- escrow-licensing per jurisdiction, platform-of-record determination and tax
-- reporting with counsel. Modelling an obligation against an already-authorised
-- `projects.budget_ceiling` is not money movement. Nothing here captures,
-- transfers, holds a customer balance, or touches a rail. What this table records
-- is *how much of a ceiling the owner already authorised is spoken for*, which is
-- the same class of fact `campaigns.budget_cap` has recorded since
-- `20260829120000`. The gate applies to the slice that first calls a real
-- provider, and it is restated in the module doc rather than weakened here.
--
-- **`charge_id` is the provider's reference and never a secret.** The fake
-- derives it from the idempotency key, so a retried accept hands the replayed rpc
-- the same string. It is stored so a later reconciliation has something to match
-- on; it authorises nothing.
--
-- ---------- Why a second committer class, and what that costs ----------
--
-- `projects.budget_ceiling` has had exactly one class of committer since
-- `20260829140000`: non-terminal campaign `budget_cap`s. From this migration on it
-- has two, because escrow is authorised spend against the same number.
-- [ADR-0020](../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)
-- records the contract that follows: **four places move in step**, pinned by
-- paired suites the way ADR-0011 pins the spend arithmetic. `20260904123000` is
-- the SQL half; the other three are `packages/marketing/src/spend.ts`,
-- `apps/api/src/lib/spend-reads.ts` and the `committedBudget` projection in
-- `apps/api/src/routes/projects.ts`.

-- ---------- Table ----------

create table public.escrow_holds (
  id              uuid primary key default gen_random_uuid(),

  task_id         uuid not null references public.tasks (id) on delete cascade,

  -- Denormalised for the ceiling sum and for the audit event, the `offers` and
  -- `engagements` precedent. The ceiling is a project-level number, so a hold
  -- that had to join to be counted would make the arithmetic in
  -- `materialise_campaign` a join under a row lock.
  project_id      uuid not null references public.projects (id) on delete cascade,

  -- The provider's own reference for the hold. Text rather than a foreign key to
  -- anything: it is somebody else's identifier, and the only provider today mints
  -- it deterministically from the idempotency key below.
  charge_id       text not null,

  amount          numeric(12, 2) not null check (amount > 0),
  currency        text not null,

  -- `held | released | refunded`, as checked text rather than an enum, and the
  -- reason is reversibility: `alter type ... add value` cannot be rolled back
  -- (supabase/README.md), while a check constraint is dropped and re-added in a
  -- normal migration. The lifecycle here is young enough that the difference is
  -- worth having.
  state           text not null default 'held'
                  check (state in ('held', 'released', 'refunded')),

  -- Rule 9 and rule 12: an idempotency key on every external side effect, backed
  -- by a unique constraint rather than by a convention. `accept_offer` derives it
  -- as `escrow:<offer_id>`, which is naturally epoch-ed because a new cascade
  -- round is a new offer; the reconcile sweep derives its refund key from the
  -- hold id.
  idempotency_key text not null unique,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The ceiling sum, which runs under the project row lock in
-- `materialise_campaign` and in `accept_offer`. Partial because a released or
-- refunded hold commits none of the ceiling and the sum never asks about one.
create index escrow_holds_project_held_idx on public.escrow_holds (project_id)
  where state = 'held';

-- The reconcile sweep's scan: held holds, joined to their task's state.
create index escrow_holds_task_idx on public.escrow_holds (task_id);

-- ---------- The escrow lifecycle ----------

-- The map, as data, in its own function rather than inlined in the guard, for the
-- reason `20260902120000:51-56` gives: a pgTAP suite can then assert one arc per
-- assertion with no fixture at all.
--
-- **One arc, and the two absences are different from each other.**
--
--   * `held -> refunded` is permitted **because it has a producer in this same
--     push**: `apps/api/src/lib/escrow-reconcile.ts`, the ticker phase that
--     unwinds a hold whose task went terminal. Without it a kill-switched task
--     would pin the owner's ceiling forever, which is a real defect and not a
--     theoretical one.
--
--   * `held -> released` is **declared in the check constraint and refused by
--     this map**, and that pairing is deliberate rather than an oversight to
--     tidy. The check constraint is the vocabulary of the column; the map is the
--     set of moves something can make today. Release is what a payout does, its
--     producer is slice 7, and permitting the arc now would be exactly the
--     `task_deps` defect this repository has recorded five times: a rule enforced
--     over an empty set. The wording of the pgTAP assertion that pins it is
--     **descriptive** ("no producer exists") rather than promissory, because a
--     test message that says "restored in slice N" about an arc slice N then
--     declines to restore is a correction this repository has already had to make
--     once.
--
--   * `refunded` and `released` are terminal. A refunded hold does not become
--     held again; that would be a second hold, with its own key.
create function private.escrow_state_is_terminal(s text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('released', 'refunded');
$$;

create function private.escrow_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.escrow_state_is_terminal(p_from) then false
    -- The reconcile sweep, unwinding a hold whose task went terminal.
    when p_from = 'held' then p_to = 'refunded'
    else false
  end;
$$;

revoke all on function private.escrow_state_is_terminal(text) from public;
revoke all on function private.escrow_transition_allowed(text, text) from public;

-- Validate, then record. One trigger for both, so an audit entry cannot be
-- forgotten by a caller and cannot describe a transition that did not happen.
--
-- SECURITY DEFINER for the `20260815200000` reason: a guard that binds trusted
-- code must not depend on that code holding EXECUTE on its internals. Being a
-- trigger rather than a grant is what makes it bind `service_role`, so the
-- reconcile sweep cannot route around the map either.
create function private.guard_escrow_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.escrow_transition_allowed(old.state, new.state) then
    raise exception
      'illegal escrow transition % -> % for hold %',
      old.state, new.state, old.id
      using errcode = 'check_violation',
            hint = 'See the escrow lifecycle in docs/30-modules/payments-billing.md.';
  end if;

  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'escrow.transitioned',
    'escrow_hold',
    new.id,
    jsonb_build_object(
      'from', old.state,
      'to', new.state,
      'task_id', new.task_id,
      'amount', new.amount,
      'currency', new.currency
    )
  );

  return new;
end;
$$;

revoke all on function private.guard_escrow_transition() from public;

-- `when` matters here as it does on `offers`: without it, stamping any other
-- column would be validated as a transition from a state to itself, which the map
-- correctly refuses.
create trigger escrow_holds_guard_transition
  before update on public.escrow_holds
  for each row
  when (old.state is distinct from new.state)
  execute function private.guard_escrow_transition();

-- ---------- RLS and grants ----------

alter table public.escrow_holds enable row level security;

-- **Project members read holds, and this is narrower than it looks.** A hold
-- names no node: it is an amount, a currency and a state against a task. What it
-- tells a member is how much of their own authorised ceiling is spoken for, which
-- is the figure the project GET already shows them for campaigns and which they
-- are plainly entitled to. `private.is_project_member` requires `scope = 'room'`,
-- so an admitted thread-scoped node reads nothing here; a node's view of their
-- own money is the engagement, not the hold.
create policy "escrow_holds_select_member" on public.escrow_holds
  for select using (private.is_project_member(project_id));

grant select on public.escrow_holds to authenticated;
grant all on public.escrow_holds to service_role;

-- Append-and-settle, never erase, including for `service_role`. A hold is a money
-- record; deleting one would make the ledger unreconcilable against it, which is
-- the whole point of having both.
revoke delete, truncate on public.escrow_holds from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.escrow_holds is
  'A modelled escrow obligation against projects.budget_ceiling. NOTHING IS CHARGED: the only '
  'registered provider is the in-repo fake, and the counsel gate in payments-billing.md is '
  'unmoved, because modelling an obligation is not money movement. held -> refunded is the only '
  'permitted arc; released is declared and has no producer until payout.';

comment on column public.escrow_holds.state is
  'held is the only non-terminal value. released is in the check constraint and NOT in '
  'escrow_transition_allowed: the constraint is the column''s vocabulary, the map is what can be '
  'done today, and release''s producer is the payout slice.';

comment on column public.escrow_holds.charge_id is
  'The payment provider''s own reference. Not a secret and it authorises nothing; the fake '
  'derives it from the idempotency key so a replayed accept hands back the same string.';

comment on column public.escrow_holds.idempotency_key is
  'escrow:<offer_id> from accept_offer, escrow-refund:<hold_id> from the reconcile sweep. Unique, '
  'so a retry collides rather than double-holding (rule 9).';

comment on function private.guard_escrow_transition() is
  'Enforces the escrow lifecycle on every UPDATE and writes escrow.transitioned. SECURITY '
  'DEFINER so the machine binds any writer including service_role (the 20260815200000 lesson).';
