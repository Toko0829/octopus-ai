-- 20260903120000_marketplace_offers.sql — the fifth marketplace table, and the
-- first one in this domain that lands with its writer rather than ahead of it.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md,
--       docs/40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md
--
-- `20260831120000:27-33` deferred this table by name and said why: "`offers` is
-- specifically the wrong fifth: its entire content is a lifecycle", and landing a
-- transition map for transitions nobody can make is the `ad_entities` mistake,
-- already corrected once. So the ordering inverts here **on purpose**. The map in
-- this file has a producer for every arc it permits, shipping in the same change:
-- the matcher sweep in `apps/api/src/lib/match.ts` and the decline route in
-- `apps/api/src/routes/nodes.ts`. That is the rule `20260902120000:9-16` states,
-- applied in the direction it points rather than the direction habit points.
--
-- **`accepted` is declared and unreachable, and that is not the defect above.**
-- `alter type ... add value` is irreversible (supabase/README.md:31), so a status
-- omitted now is a migration and a deployment away later, while a status declared
-- now costs one enum label. What would make it the `task_deps` defect is a map
-- permitting the arc, and the map does not: nothing reaches `accepted` and pgTAP
-- pins every path to it as refused. The wording of that assertion is deliberately
-- descriptive ("slice 5 decides") rather than promissory, because this repository
-- has just spent a slice cleaning up a test message that said "restored in slice
-- 4" about an arc slice 4 then decided not to restore.
--
-- **What an offer is not.** It is not an `action_embeds` row. Embeds are
-- room-scoped, their `required_role` understands only `owner`
-- (`apps/api/src/routes/embeds.ts:132` denies everyone else), and their verb set
-- is approve/request_changes. An offer is addressed to one node, carries a
-- lifecycle rather than a verdict, and its reader is not in the room at all.
--
-- **Nothing here admits anybody to anything.** No `room_members` row, no thread,
-- no `author_kind = 'node'` writer. A node reads their offers at `/node` and can
-- decline. Accepting is refused by this map because accepting is inseparable from
-- funding escrow, and escrow is the next slice.

-- ---------- Enum ----------

-- `open` is the only non-terminal status, which is what makes the three
-- settlements below exhaustive rather than merely enumerated.
--
-- The three settlements answer three different questions and collapsing any two
-- would make the trail unreadable: `declined` is a person saying no and is the
-- only one that can carry a reason, `expired` is a person saying nothing, and
-- `withdrawn` is the offer ceasing to be relevant through no act of the node's
-- (their owner cancelled the step, or took it on themselves while the offer was
-- out). A cascade reads very differently depending on which of the three it was,
-- and slice 8's ratings will read exactly that.
create type public.offer_status as enum (
  'open',
  'declined',
  'expired',
  'withdrawn',
  'accepted'
);

-- ---------- Table ----------

create table public.offers (
  id            uuid primary key default gen_random_uuid(),

  -- Cascade from the task rather than the project: deleting a project deletes
  -- its tasks, so both paths arrive here anyway, and the narrower one is the
  -- one that states the relationship.
  task_id       uuid not null references public.tasks (id) on delete cascade,

  -- Denormalised from the task, exactly as `action_embeds.room_id` is from its
  -- message. The guard trigger writes an audit event and `events.project_id` is
  -- the column every reader of that log filters on; resolving it through a join
  -- inside a trigger is how a trigger acquires a reason to fail.
  project_id    uuid not null references public.projects (id) on delete cascade,

  node_id       uuid not null references public.node_profiles (user_id) on delete cascade,

  -- Which pass of the cascade produced this offer. Re-derived by the sweep from
  -- the task's own transition history rather than stored anywhere else, so a
  -- crash mid-cascade recomputes the same number and collides on the unique key
  -- below instead of opening a second offer.
  round         int not null default 0,

  status        public.offer_status not null default 'open',

  -- **Expiry is a timestamp, never a status a clock has to write.**
  -- `20260831120000:56-59` argued this for `kyc_status` and the argument is the
  -- same here: a state you must run a sweep to enter is wrong between sweeps.
  -- Readers compare against now(); the sweep settles the row so the trail says
  -- what happened, but no reader depends on the sweep having run.
  expires_at    timestamptz not null,

  declined_at   timestamptz,
  decline_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A declined offer without a time is a decline nobody can place in the trail.
  constraint offers_declined_has_time
    check (status <> 'declined' or declined_at is not null),

  -- A reason belongs to a decline and to nothing else. Without this an expired
  -- offer could carry text a node never wrote.
  constraint offers_reason_only_on_decline
    check (decline_reason is null or status = 'declined'),

  constraint offers_reason_length
    check (decline_reason is null or char_length(decline_reason) <= 500),

  constraint offers_round_nonneg
    check (round >= 0),

  constraint offers_expiry_after_creation
    check (expires_at > created_at)
);

-- One offer per cascade round. This is the sweep's replay contract: a pass that
-- crashed after inserting and before moving the task re-derives the same round,
-- collides here, reads the row back and finishes the move. Without it the retry
-- opens a second offer to a second node for the same round, which is the
-- double-offer this table would otherwise have no defence against.
create unique index offers_task_round_idx on public.offers (task_id, round);

-- A node is offered a given step once, ever. Two consequences, both intended:
-- the cascade cannot loop back onto somebody who already said no, and a
-- re-dispatch after exhaustion re-exhausts immediately against an unchanged
-- pool. The second is a real limit and is recorded in the module doc rather than
-- discovered; re-offer policy needs a reason to re-ask, and "the owner clicked
-- again" is not one.
create unique index offers_task_node_idx on public.offers (task_id, node_id);

-- One live offer per task, as structure rather than as sweep discipline. This is
-- the whole of "first-accept-wins with cascade" expressed where it cannot be
-- forgotten: the marketplace doc's alternative, a sealed-bid window over
-- concurrent offers, would drop this index and is a different slice's decision.
create unique index offers_one_open_idx on public.offers (task_id) where status = 'open';

-- The node's own list, newest first.
create index offers_node_idx on public.offers (node_id, created_at desc);

-- The sweep's expiry scan. Partial because a settled offer never expires again.
create index offers_open_expiry_idx on public.offers (expires_at) where status = 'open';

-- ---------- The offer lifecycle ----------

create function private.offer_status_is_terminal(s public.offer_status)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('declined', 'expired', 'withdrawn', 'accepted');
$$;

-- The transition map, as data, in its own function rather than inlined in the
-- guard, for the reason `20260902120000:51-56` gives: a pgTAP suite can then
-- assert one arc per assertion with no fixture at all.
--
-- Three arcs, and no universal cancellation rule. `tasks` and `campaigns` both
-- carry "anything non-terminal may reach cancelled", because both are long-lived
-- records somebody may need to stop. An offer is neither: it settles one of
-- three ways within 48 hours and every one of those ways is already here, so a
-- fourth would be a state with no question behind it.
--
-- **Nothing reaches `accepted`.** Acceptance moves money into escrow in the same
-- act (`claimed -> escrow_funded` is the task machine's only exit from
-- `claimed`), so an arc to `accepted` without escrow would strand a node in a
-- deal nobody funded. Slice 5 adds the arc and the funding together.
create function private.offer_transition_allowed(
  p_from public.offer_status,
  p_to   public.offer_status
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.offer_status_is_terminal(p_from) then false
    -- The node said no. The only settlement that can carry a reason.
    when p_from = 'open' then p_to in ('declined', 'expired', 'withdrawn')
    else false
  end;
$$;

revoke all on function private.offer_status_is_terminal(public.offer_status) from public;
revoke all on function private.offer_transition_allowed(public.offer_status, public.offer_status) from public;

-- Validate, then record. One trigger for both, so an audit entry cannot be
-- forgotten by a caller and cannot describe a transition that did not happen.
--
-- SECURITY DEFINER for the `20260815200000` reason, unchanged: a guard that binds
-- trusted code must not depend on that code holding EXECUTE on its internals.
-- Being a trigger rather than a grant is what makes it bind `service_role` too,
-- so neither the sweep nor the decline route can route around the map.
--
-- `auth.uid()` is null for both writers here (each acts through the secret key),
-- so this event is always `system`. The two callers write their own richer events
-- naming the actual actor, exactly as `20260813120000:357-359` describes for
-- tasks: the trigger records that the status moved, the caller records who and
-- why.
create function private.guard_offer_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.offer_transition_allowed(old.status, new.status) then
    raise exception
      'illegal offer transition % -> % for offer %',
      old.status, new.status, old.id
      using errcode = 'check_violation',
            hint = 'See the offer lifecycle in docs/30-modules/human-nodes-marketplace.md.';
  end if;

  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'offer.transitioned',
    'offer',
    new.id,
    jsonb_build_object(
      'from', old.status,
      'to', new.status,
      'task_id', new.task_id,
      'round', new.round
    )
  );

  return new;
end;
$$;

revoke all on function private.guard_offer_transition() from public;

-- `when` matters here as it does everywhere else: without it, stamping a
-- `decline_reason` would be validated as a transition from a status to itself,
-- which the map correctly refuses.
create trigger offers_guard_transition
  before update on public.offers
  for each row
  when (old.status is distinct from new.status)
  execute function private.guard_offer_transition();

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.offers enable row level security;

-- The node sees their own offers. `node_id` is `node_profiles.user_id`, which is
-- `auth.uid()`, so this is a plain equality with no join and no helper, which is
-- the whole reason `20260831120000:141-146` keyed the profile on the user id.
create policy "offers_select_own" on public.offers
  for select using (node_id = auth.uid());

-- **The owner sees no offer rows at all, and this absence is load-bearing.**
--
-- An offer names a node. `node_profiles` has no counterparty policy in either
-- direction, and `20260901122000` additionally narrowed `private.shares_room_with`
-- to require room scope on both sides, deliberately closing the owner-sees-node
-- half as well. Handing the owner a row carrying `node_id` would reopen exactly
-- that pair through a side door, one slice before the engagement slice decides
-- what the pair should actually show.
--
-- The owner is not left guessing: `tasks.state` already reads "Finding an expert"
-- and "Offered to an expert" in the project panel, which is what they need to
-- know. Who specifically is considering their step is the engagement slice's
-- question to answer, with a policy written for it.
--
-- pgTAP asserts the project owner reads zero rows, so this stays a decision
-- rather than an oversight somebody later "fixes".

grant select on public.offers to authenticated;
grant all on public.offers to service_role;

-- Append-and-settle, never erase, including for `service_role`. The offer trail
-- is what a dispute reads and what slice 8 rates on, and `node_verifications`
-- (`20260831123000:140`) already set this precedent in this domain. UPDATE
-- survives because a settlement is an update and the guard above is what
-- constrains it.
revoke delete, truncate on public.offers from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.offers is
  'One offer of one task to one node. Its entire content is a lifecycle: open settles '
  'to declined, expired or withdrawn, one live offer per task, one offer per node per '
  'task ever. Node-readable (own rows only), server-written, never deleted.';

comment on column public.offers.round is
  'Which cascade pass produced this offer. Re-derived by the matcher from the task''s '
  'own offered -> matching transition history, so a crashed pass recomputes it and '
  'collides on offers_task_round_idx rather than opening a second offer.';

comment on column public.offers.expires_at is
  'When the offer stops being live. Expiry is compared at read time and settled by the '
  'sweep for the trail; no reader depends on the sweep having run, because a status a '
  'clock must write is wrong between sweeps (the 20260831120000:56-59 argument).';

comment on column public.offers.status is
  'open is the only non-terminal value. accepted is declared but unreachable: nothing '
  'in offer_transition_allowed arrives there, because accepting is inseparable from '
  'funding escrow and escrow is a later slice.';

comment on function private.guard_offer_transition() is
  'Enforces the offer lifecycle on every UPDATE and writes the audit event. SECURITY '
  'DEFINER so the machine binds any writer, including service_role, without that '
  'writer needing EXECUTE on its internals (the 20260815200000 lesson).';
