-- 20260904120000_engagements.sql — the deal table. A node took a step, and this
-- is the row that says so.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/30-modules/payments-billing.md,
--       docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md,
--       docs/40-adr/0019-claimed-to-matching-stays-dropped.md
--
-- **No state column, and that is ADR-0016 rather than an omission.** Every state
-- an engagement could carry is already a `public.task_state` value, already has
-- its arcs enforced by a trigger that binds `service_role`, and already writes an
-- audit row on every transition. A second enum over the same truth would drift
-- silently, because "the engagement says in_progress and the task says in_review"
-- is a confusing screen rather than an error. So `tasks.state` carries the fact
-- about the **work** and this table carries facts about the **deal**:
-- `agreed_price` frozen at acceptance, `deadline_at`, `terms_hash`, `outcome`.
--
-- **This row IS the counterparty opening**, and that is the point of landing it
-- before the policy that uses it. `20260901122000` narrowed
-- `private.shares_room_with` to require room scope on both sides and left the
-- owner-sees-node and node-sees-owner pair closed in both directions, saying in
-- as many words that the policy "joins through `engagements`, which does not
-- exist" and that approximating it would be the two-representations defect.
-- `20260904126000` writes that join. It is a separate migration because a table
-- and a policy that reads it are two concerns, and this file's guard is already
-- one file's worth of argument.
--
-- **One live engagement per task**, as a partial unique index rather than a plain
-- one. A no-show or a reassignment creates a **second** engagement on the same
-- task (that is the sentence ADR-0016 ends on), so a plain unique would forbid
-- the recovery path the machine exists to support. `where ended_at is null` says
-- the narrower true thing: at most one deal is live at a time.
--
-- **Multi-node splits are forbidden by that index, deliberately and with a
-- trigger to revisit.** payments-billing.md says one charge can fund several
-- transfers; under ADR-0016 that needs several live engagements on one task. The
-- trigger is the first acceptance criteria naming more than one node, and at that
-- point this index is what changes.
--
-- **Three nullable columns ship with no writer, on purpose and stated here rather
-- than discovered.** `deadline_at`, `nda_signed_at` and `terms_hash` are what the
-- module doc's step 1 ("node e-signs a per-task engagement + NDA") will need.
-- Nothing in this slice sets any of them, and nothing reads them. They are
-- columns rather than a later migration because the shape is settled and the
-- writer is not, which is the opposite of the `task_deps` mistake: that was a
-- *rule* enforced with no producer, and these are *facts* with no recorder. A
-- reader who wants to know whether an NDA was signed gets NULL, which is the
-- honest answer, rather than a column that does not exist.

-- ---------- Table ----------

create table public.engagements (
  id            uuid primary key default gen_random_uuid(),

  task_id       uuid not null references public.tasks (id) on delete cascade,

  -- Denormalised from the task, on `offers`' precedent (`20260903120000:70-76`)
  -- and for the same reason: the guard below writes an audit event and
  -- `events.project_id` is the column every reader of that log filters on.
  -- Resolving it through a join inside a trigger is how a trigger acquires a
  -- reason to fail.
  project_id    uuid not null references public.projects (id) on delete cascade,

  node_id       uuid not null references public.node_profiles (user_id) on delete cascade,

  -- **The accept's idempotency anchor, and the only one.** `accept_offer` reads
  -- this before it validates anything, so a retried accept returns the
  -- engagement it already made rather than re-checking a ceiling that may have
  -- moved since. Unique because an offer is accepted once; a cascade round that
  -- comes back to the same task is a different offer row and therefore a
  -- different key, which is what makes the epoch problem disappear instead of
  -- needing a counter.
  offer_id      uuid not null unique references public.offers (id) on delete cascade,

  -- **Frozen at acceptance, and it must not follow `node_profiles.rate`.** A node
  -- who raises their rate after accepting has not raised the price of work
  -- already agreed, and a projection that read the profile instead of this column
  -- would silently rewrite history on every render. The escrow hold, the ledger
  -- pair and the eventual payout all measure against this number.
  agreed_price  numeric(12, 2) not null check (agreed_price > 0),

  -- Checked against the project's own currency by `accept_offer` before the
  -- insert. Kept here rather than joined so a later payout reads one row.
  currency      text not null,

  accepted_at   timestamptz not null default now(),

  -- **No writer in this slice**, and no reader. See the header: the shape is
  -- settled, the e-signature step is not.
  deadline_at   timestamptz,
  nda_signed_at timestamptz,
  terms_hash    text,

  ended_at      timestamptz,

  -- Four ways a deal ends, and they are not interchangeable. `completed` is the
  -- work delivered and approved; `reassigned` is a no-show whose step went back
  -- to the market; `cancelled` is the owner or the machine stopping the task
  -- underneath a live deal (the reconcile sweep's outcome); `disputed_resolved`
  -- is ops closing one. Slice 8 rates on the difference.
  outcome       text check (outcome in ('completed', 'reassigned', 'cancelled', 'disputed_resolved')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- An ended engagement with no outcome is a deal nobody can explain, and an
  -- outcome with no end date is a claim about a deal that is still running. The
  -- equality states both at once rather than as two half-constraints that could
  -- be satisfied separately.
  constraint engagements_outcome_iff_ended
    check ((outcome is null) = (ended_at is null)),

  constraint engagements_ended_after_accepted
    check (ended_at is null or ended_at >= accepted_at)
);

-- One live deal per task. See the header for why this is partial rather than
-- plain: reassignment after a no-show creates a second engagement, and
-- `claimed -> matching` was the arc that used to be pointed at when saying so
-- ([ADR-0019](../../docs/40-adr/0019-claimed-to-matching-stays-dropped.md)
-- explains why that arc stays dropped and where the producer will actually
-- leave from).
create unique index engagements_one_live_idx
  on public.engagements (task_id) where ended_at is null;

-- The node's own list, newest first: `GET /api/node/engagements` reads exactly
-- this order.
create index engagements_node_idx on public.engagements (node_id, accepted_at desc);

-- The owner's list, and the project panel's task projection.
create index engagements_project_idx on public.engagements (project_id);

-- The counterparty helper (`20260904126000`) joins live engagements to the node
-- and to the project, so both directions want this covered.
create index engagements_live_idx on public.engagements (node_id, project_id)
  where ended_at is null;

-- ---------- Write-once guard ----------
--
-- SECURITY DEFINER for the `20260815200000` reason, unchanged: a guard that binds
-- trusted code must not depend on that code holding EXECUTE on its internals.
-- Being a trigger rather than a grant is what makes it bind `service_role` too,
-- so neither `accept_offer` nor the reconcile sweep can route around it.
--
-- **Five columns are immutable after the insert**, and each is immutable for its
-- own reason. `agreed_price` is the number escrow was funded against and the
-- number a payout will pay; letting it move would let somebody re-price work
-- after the money was held. `offer_id` is the idempotency anchor, so changing it
-- would make a replay create a second engagement. `node_id` is who is being paid.
-- `task_id` is what for. `currency` is the unit all of the above are in.
--
-- **Ending is one-way.** Un-ending would reopen a deal that a refund has already
-- reversed and a membership revocation has already closed, and re-outcoming would
-- let "cancelled" become "completed" after the fact, which is the one edit that
-- would make the trail lie about money.
create function private.guard_engagement_end()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.task_id is distinct from old.task_id
     or new.node_id is distinct from old.node_id
     or new.offer_id is distinct from old.offer_id
     or new.agreed_price is distinct from old.agreed_price
     or new.currency is distinct from old.currency then
    raise exception
      'engagement % is written once: task, node, offer, price and currency cannot change',
      old.id
      using errcode = 'check_violation',
            hint = 'A re-priced or re-assigned deal is a new engagement, not an edit.';
  end if;

  if old.ended_at is not null and new.ended_at is null then
    raise exception 'engagement % has already ended and cannot be reopened', old.id
      using errcode = 'check_violation';
  end if;

  if old.outcome is not null and new.outcome is distinct from old.outcome then
    raise exception
      'engagement % already ended as %; an outcome is written once',
      old.id, old.outcome
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();

  -- Written here rather than by the caller, the house rule `20260902120000:51-56`
  -- states: one trigger for both validation and audit, so an entry cannot be
  -- forgotten by a caller and cannot describe an ending that did not happen. The
  -- INSERT audits nothing (a trigger fires on UPDATE only), which is why
  -- `accept_offer` writes `engagement.created` explicitly.
  if old.ended_at is null and new.ended_at is not null then
    insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
    values (
      new.project_id,
      auth.uid(),
      case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
      'engagement.ended',
      'engagement',
      new.id,
      jsonb_build_object(
        'task_id', new.task_id,
        'node_id', new.node_id,
        'outcome', new.outcome,
        'agreed_price', new.agreed_price,
        'currency', new.currency
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function private.guard_engagement_end() from public;

create trigger engagements_guard_end
  before update on public.engagements
  for each row
  execute function private.guard_engagement_end();

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.engagements enable row level security;

-- The node reads their own deals. `node_id` is `node_profiles.user_id`, which is
-- `auth.uid()`, so this is a plain equality with no join and no helper.
create policy "engagements_select_node" on public.engagements
  for select using (node_id = auth.uid());

-- **And the owner reads it, which is the deliberate opening of "who took my
-- step".** `offers` refused this and said why (`20260903120000:249-265`): an
-- offer names every node who was *asked*, including the ones who said no, and
-- publishing a decline trail is a disclosure decision this slice does not need to
-- make. An engagement names the one node who **took the work and is being paid
-- from the owner's authorised budget**, which the owner is entitled to know by
-- any reading. So this policy opens exactly that row and `offers` stays closed,
-- which is why the projection rather than the offer table is what the panel
-- reads.
--
-- `private.is_project_member` requires `scope = 'room'`, so an admitted node is
-- not a project member and does not read other people's engagements through this
-- half. They read their own through the policy above.
create policy "engagements_select_member" on public.engagements
  for select using (private.is_project_member(project_id));

grant select on public.engagements to authenticated;
grant all on public.engagements to service_role;

-- Append-and-settle, never erase, including for `service_role`: the offers shape
-- (`20260903120000:294-299`), which is `node_verifications`' before it. UPDATE
-- survives because ending an engagement is an update and the guard above is what
-- constrains it.
revoke delete, truncate on public.engagements from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.engagements is
  'One deal: one node took one task at one price. No state column (ADR-0016) because every '
  'state is already a task_state under trigger enforcement. Carries facts about the deal, not '
  'about the work. One live engagement per task; a reassignment creates a second row.';

comment on column public.engagements.agreed_price is
  'The price frozen at acceptance. Deliberately NOT read back from node_profiles.rate: a node '
  'who raises their rate has not re-priced work already agreed, and escrow, the ledger pair and '
  'the payout all measure against this number.';

comment on column public.engagements.offer_id is
  'The accepted offer, unique. This is accept_offer''s entire idempotency contract: a replay '
  'finds this row and returns it before validating anything. A new cascade round is a new offer '
  'row, so the key is naturally epoch-ed.';

comment on column public.engagements.terms_hash is
  'Reserved for the per-task engagement and NDA the module doc specifies. No writer and no '
  'reader in slice 5, stated in the migration header rather than left to be discovered.';

comment on function private.guard_engagement_end() is
  'Makes the deal write-once and the ending one-way, and writes engagement.ended in the same '
  'trigger. SECURITY DEFINER so it binds any writer including service_role, without that writer '
  'needing EXECUTE on its internals (the 20260815200000 lesson).';
