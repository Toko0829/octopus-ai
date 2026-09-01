-- 20260907121000_payouts.sql — what was paid, to whom, for which deal.
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/10-architecture/data-model.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0013-approving-a-campaign-publishes-it.md,
--       docs/40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md
--
-- **Nothing is charged and nothing is transferred.** The only registered payment
-- provider is the in-repo deterministic fake; `transfer_id` is visibly
-- `tr_fake_…` on every row this build writes, distinct from `ch_fake_…` so
-- nobody reconciling the two tables can mistake a charge for a transfer.
-- `carriesRealMoney` refuses a real provider in `apps/api/src/lib/payout.ts`
-- before the call. **The counsel gate in payments-billing.md is unmoved.**
--
-- ---------- Why this table exists rather than a column on `engagements` ----------
--
-- Because a payout is an act with somebody else's identifier attached and a
-- window in which it is uncertain, and `engagements` is written once and then
-- ended ([ADR-0016](../../docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md)).
-- This is the row that exists **before** the transfer, so a crash between asking
-- and knowing is recoverable: the record of an uncertain request is what makes it
-- resumable, and an unrecorded certain one is not
-- ([ADR-0013](../../docs/40-adr/0013-approving-a-campaign-publishes-it.md), whose
-- ordering this slice takes rather than ADR-0014's inversion, because a transfer
-- **creates** something under an id the provider mints).
--
-- ---------- No unique key on `engagement_id`, on purpose ----------
--
-- One engagement is paid once, and that is enforced — by
-- `idempotency_key`, which is `payout:<engagement_id>` from
-- `packages/payments/src/keys.ts` and is unique here. A partial unique on
-- `engagement_id` beside it would be a second copy of one rule, and the
-- repeated cost of a second copy in this repository is that the two drift. The
-- key is the constraint; the column is what a reader joins on.
--
-- ---------- `platform_fee` is a column written from a constant `0` ----------
--
-- vision.md names a 15-25% marketplace take rate and data-model.md lists this
-- column, so it lands. It is written from one constant in
-- `apps/api/src/lib/payout.ts` and that constant is zero, argued in
-- [ADR-0024](../../docs/40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md):
-- escrow holds exactly the `agreed_price` the offer showed the node **before**
-- they accepted, and deducting a fee at release changes what a person agreed to
-- after they agreed to it. A take rate needs the offer and the node console to
-- name it first, which is a pricing slice with a surface, not a number invented
-- in a migration. The check is `>= 0` rather than `> 0` precisely because zero is
-- the value this build writes.
--
-- The **column** is not the `task_deps` anti-pattern, which was a *rule* enforced
-- over an empty set. This is a *fact* with a value, on `trust_score`'s precedent:
-- it lands nullable-or-defaulted so its writer arrives to a column rather than to
-- a migration.

-- ---------- Table ----------

create table public.payouts (
  id              uuid primary key default gen_random_uuid(),

  -- The deal being paid. One engagement, one payout; see the header for why that
  -- is enforced by the key rather than by a second unique constraint.
  engagement_id   uuid not null references public.engagements (id) on delete cascade,

  -- Denormalised for the same reasons `escrow_holds` and `offers` denormalise:
  -- the node reads their own payouts with a plain equality and no join, and the
  -- project member's policy is a helper call on a column rather than a join
  -- through two tables.
  node_id         uuid not null references public.node_profiles (user_id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  task_id         uuid not null references public.tasks (id) on delete cascade,

  -- The provider's own reference for the transfer. **Null until the transfer
  -- returns**, which is the entire point of this row existing before the call.
  -- Write-once once non-null, enforced below on `ad_entities.external_id`'s
  -- precedent rather than left as a comment.
  transfer_id     text,

  -- What the node receives. Equal to `engagements.agreed_price` and to
  -- `escrow_holds.amount` in this build, because the fee below is zero; kept as
  -- its own column so that stops being true without a migration.
  amount          numeric(12, 2) not null check (amount > 0),

  -- Retained by the platform. Zero in this build. See the header and ADR-0024.
  platform_fee    numeric(12, 2) not null default 0 check (platform_fee >= 0),

  currency        text not null,

  -- Checked text rather than an enum, `escrow_holds`' choice for its reason:
  -- `alter type ... add value` cannot be rolled back (supabase/README.md) while a
  -- check constraint is dropped and re-added in a normal migration, and this
  -- vocabulary is one slice old.
  --
  -- **`failed` is in the constraint and out of the map**, which is deliberately
  -- the shape `20260904121000` gave `released` and which `20260907120000` has
  -- just closed one table over. The constraint is the column's vocabulary; the
  -- map is what can be done today. Nothing produces `failed`, because a transfer
  -- for work an owner has already approved is not something this codebase lets a
  -- provider close: every failure retries at tick cadence and is logged loudly,
  -- since a terminal row against work somebody did, in a build with no ops
  -- console that could un-terminal it, is the worse outcome. Its producer is
  -- that console, with a person behind it (admin-ops.md, Phase 3).
  state           text not null default 'pending'
                  check (state in ('pending', 'paid', 'failed')),

  -- Rule 9 and rule 12. `payout:<engagement_id>` from
  -- `packages/payments/src/keys.ts`, derived rather than generated, and handed to
  -- the provider as well as stored: this constraint stops us starting a second
  -- payout, and the same string stops an idempotent provider making a second
  -- transfer if we ask anyway.
  idempotency_key text not null unique,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The sweep resumes by engagement; the panel and the node console read by task
-- and by node.
create index payouts_engagement_idx on public.payouts (engagement_id);
create index payouts_task_idx on public.payouts (task_id);
create index payouts_node_idx on public.payouts (node_id, created_at desc);

-- ---------- The payout lifecycle ----------

create function private.payout_state_is_terminal(s text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('paid', 'failed');
$$;

-- The map, as data, in its own function for the reason `20260902120000:51-56`
-- gives: a pgTAP suite can then assert one arc per assertion with no fixture.
--
-- **One arc, and the single absence is argued rather than pending.** See the
-- `state` column comment: `pending -> failed` is refused because nothing in this
-- codebase decides that a payout for approved work will never happen.
create function private.payout_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.payout_state_is_terminal(p_from) then false
    -- `public.settle_payout`, once the provider has answered.
    when p_from = 'pending' then p_to = 'paid'
    else false
  end;
$$;

revoke all on function private.payout_state_is_terminal(text) from public;
revoke all on function private.payout_transition_allowed(text, text) from public;

-- ---------- Write-once, on every update ----------
--
-- Separate from the transition guard because it must fire whether or not the
-- state moved: `transfer_id` is stamped in the same statement that moves the row
-- to `paid`, and the money columns must be immutable even on an update that
-- touches nothing else.
--
-- **`transfer_id` is write-once once non-null** and never nullable again. It is
-- the reference this codebase would use to prove a transfer happened, and a
-- writer that could clear it could make a paid payout look unpaid — which is
-- exactly the resumption path the sweep depends on reading correctly.
-- `ad_entities.external_id` established this shape for the same reason.
create function private.guard_payout_write_once()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.transfer_id is not null and new.transfer_id is distinct from old.transfer_id then
    raise exception
      'payout % already recorded transfer %; a transfer reference is written once',
      old.id, old.transfer_id
      using errcode = 'check_violation',
            hint = 'A second transfer for the same work is a second payout, not an edit.';
  end if;

  if new.engagement_id is distinct from old.engagement_id
     or new.node_id is distinct from old.node_id
     or new.task_id is distinct from old.task_id
     or new.amount is distinct from old.amount
     or new.platform_fee is distinct from old.platform_fee
     or new.currency is distinct from old.currency
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception
      'payout % is written once: deal, node, task, amount, fee, currency and key cannot change',
      old.id
      using errcode = 'check_violation',
            hint = 'A re-priced or re-directed payment is a new payout, not an edit.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.guard_payout_write_once() from public;

create trigger payouts_guard_write_once
  before update on public.payouts
  for each row
  execute function private.guard_payout_write_once();

-- ---------- Validate, then record ----------
--
-- One trigger for both, so an audit entry cannot be forgotten by a caller and
-- cannot describe a transition that did not happen. SECURITY DEFINER for the
-- `20260815200000` reason, and being a trigger rather than a grant is what makes
-- it bind `service_role`, so `settle_payout` cannot route around the map either.
create function private.guard_payout_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.payout_transition_allowed(old.state, new.state) then
    raise exception
      'illegal payout transition % -> % for payout %',
      old.state, new.state, old.id
      using errcode = 'check_violation',
            hint = 'See the payout lifecycle in docs/30-modules/payments-billing.md.';
  end if;

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'payout.transitioned',
    'payout',
    new.id,
    jsonb_build_object(
      'from', old.state,
      'to', new.state,
      'task_id', new.task_id,
      'node_id', new.node_id,
      'amount', new.amount,
      'platform_fee', new.platform_fee,
      'currency', new.currency,
      'transfer_id', new.transfer_id
    )
  );

  return new;
end;
$$;

revoke all on function private.guard_payout_transition() from public;

-- `when` matters here as it does on `offers` and `escrow_holds`: without it,
-- stamping `transfer_id` alone would be validated as a transition from a state to
-- itself, which the map correctly refuses.
create trigger payouts_guard_transition
  before update on public.payouts
  for each row
  when (old.state is distinct from new.state)
  execute function private.guard_payout_transition();

-- ---------- RLS and grants ----------
--
-- **`engagements`' pair, verbatim, because the disclosure question is the same
-- one.** A payout names one node, one step and one amount already visible to
-- both parties: the owner authorised that exact figure when the escrow was
-- funded against their ceiling, and the node was shown it on the offer before
-- they accepted. Nothing here is new information to either of them.

alter table public.payouts enable row level security;

-- **The node reads their own, and this is the one money fact they get.**
-- `ledger_entries` has no policy and no client grant at all, and `escrow_holds`
-- is room-scoped so an admitted thread-scoped node reads nothing there. "Was I
-- paid, and how much" is not a general ledger; it is the answer to the question
-- the whole engagement was about, and refusing it would leave a node whose only
-- way to find out is to ask.
create policy "payouts_select_node" on public.payouts
  for select using (node_id = auth.uid());

-- The owner and their room-scoped members, on `engagements_select_member`'s
-- reasoning: `private.is_project_member` requires `scope = 'room'`, so an
-- admitted node is not a project member and does not read other people's payouts
-- through this half.
create policy "payouts_select_member" on public.payouts
  for select using (private.is_project_member(project_id));

grant select on public.payouts to authenticated;
grant all on public.payouts to service_role;

-- Append-and-settle, never erase, **including for `service_role`**: the
-- `escrow_holds` and `ledger_entries` posture, and this is a money record. UPDATE
-- survives because settling is an update and the two guards above are what
-- constrain it.
revoke delete, truncate on public.payouts from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.payouts is
  'What was paid to a node for an approved step. NOTHING IS TRANSFERRED: the only registered '
  'provider is the in-repo fake and transfer_id is visibly tr_fake_. Written before the transfer '
  'so a crash between asking and knowing is recoverable (ADR-0013 ordering). One engagement is '
  'paid once, enforced by the unique idempotency_key rather than by a second constraint.';

comment on column public.payouts.transfer_id is
  'The provider''s own reference. Null until the transfer returns, then write-once forever: a '
  'writer that could clear it could make a paid payout look unpaid, which is the resumption path '
  'the sweep reads.';

comment on column public.payouts.platform_fee is
  'Retained by the platform. ZERO in this build, from one constant in apps/api/src/lib/payout.ts. '
  'Escrow holds exactly the agreed_price the offer showed the node before they accepted, and '
  'deducting a fee at release would change what a person agreed to after they agreed (ADR-0024).';

comment on column public.payouts.state is
  'pending is the only non-terminal value. failed is in the check constraint and NOT in '
  'payout_transition_allowed: nothing here decides a payout for approved work will never happen, '
  'so every failure retries at tick cadence. Its producer is the Phase-3 ops console.';

comment on function private.guard_payout_transition() is
  'Enforces the payout lifecycle on every state change and writes payout.transitioned. SECURITY '
  'DEFINER so the machine binds any writer including service_role (the 20260815200000 lesson).';

comment on function private.guard_payout_write_once() is
  'Fires on every UPDATE, unlike the transition guard: transfer_id is stamped in the same '
  'statement that moves the row to paid, and the money columns must be immutable even on an '
  'update that changes nothing else.';
