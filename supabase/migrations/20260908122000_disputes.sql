-- 20260908122000_disputes.sql — what went wrong, who said so, and what was decided about it.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/30-modules/admin-ops.md,
--       docs/30-modules/payments-billing.md,
--       docs/10-architecture/data-model.md,
--       docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, third migration. The table `20260831120000:28` named as a
-- sibling that did not exist yet, and that `data-model.md:1075` has carried as
-- "⏳ slice 8, with the ops path" ever since.
--
-- ---------- No state column, and this is the load-bearing decision ----------
--
-- A dispute looks exactly like something that wants a lifecycle: raised, under
-- review, resolved, maybe appealed. It does not get one.
-- [ADR-0016](../../docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md)
-- decided this for `engagements` and the argument transfers without weakening:
-- **`tasks.state` is the machine**, `disputed` is a value in it, and the arcs out
-- of `disputed` are declared in `private.task_transition_allowed` where a trigger
-- enforces them against `service_role` and superuser alike. A `status` column
-- here would be a second machine over one truth, and "two machines over one
-- truth is this repository's most expensive recorded defect ... worse, because it
-- would drift silently."
--
-- So **open is `resolved_at is null`**. It is derived, it cannot disagree with
-- the task, and there is no arc for anybody to get wrong. The partial unique
-- index below is written against that derivation, which is what makes "one open
-- dispute per task" a constraint rather than an intention.
--
-- `resolution` is the same distinction ADR-0016 draws between `campaign_state`
-- and `pause_reason`, and that `engagements.outcome` already embodies: **it looks
-- like state and is not.** Null until `resolved_at`, written once, no arcs, no
-- map. The reason is data; the state is the machine.
--
-- ---------- Evidence is text, and that is not a placeholder ----------
--
-- `evidence` is free text and there is deliberately no `dispute_artifacts` table
-- and no artifact join. [ADR-0022](../../docs/40-adr/0022-proof-is-an-artifact.md)
-- refused a second deliverable table for proof and its reasoning applies harder
-- here: the evidence a dispute actually reads **already exists and is already
-- immutable**. The proof is `artifacts` at `kind = 'proof'`; the offer trail is
-- `offers`, which has `delete` and `truncate` revoked from `service_role` itself
-- precisely because "the offer trail is what a dispute reads"
-- (`20260903120000:284`); the conversation is `messages`; the roster is
-- `room_members`, whose access is stamped with `expires_at` and never deleted
-- "so the roster still records that this person was here, which is what a dispute
-- reads" (`20260906124000:150-154`); and the arithmetic behind every money
-- decision is in `events.payload`, put there because "the numbers a decision
-- rested on belong where a dispute can read them" (data-model.md:77).
--
-- Six surfaces were built to be read by this table. What this column adds is the
-- one thing none of them holds: **what the person raising it says is wrong.**
--
-- ---------- Who reads a dispute ----------
--
-- Both parties, and nobody else. The owner through `private.is_project_member`,
-- the node through their own engagement. Ops read it as `service_role` from
-- behind the role check in `apps/api/src/plugins/require-ops.ts` — there is no
-- ops-wide policy on this table and there must not be one, because RLS cannot
-- read `profiles.role` without a SECURITY DEFINER helper in `public`, and
-- security-compliance.md:99 records that exact shape being reintroduced once by
-- somebody who had read the migration that fixed it. `ledger_entries` established
-- the posture this follows: the client grant is the control, and it is narrow.

-- ---------- Table ----------

create table public.disputes (
  id              uuid primary key default gen_random_uuid(),

  -- The step. This is the join that matters: `tasks.state` is where `disputed`
  -- lives, so every question about whether this dispute is live is answered
  -- there rather than here.
  task_id         uuid not null references public.tasks (id) on delete cascade,

  -- The deal. Not null, because every state a dispute can be raised from
  -- (`escrow_funded`, `in_progress`, `rejected`, `payout_pending`) is downstream
  -- of an acceptance, so there is always exactly one live engagement.
  engagement_id   uuid not null references public.engagements (id) on delete cascade,

  -- Denormalised on `escrow_holds`' and `payouts`' reasoning: the member policy
  -- is a helper call on a column rather than a join through two tables, and
  -- `events.project_id` is written from it.
  project_id      uuid not null references public.projects (id) on delete cascade,

  -- Who said something is wrong, and in which capacity. Both are recorded
  -- because they answer different questions: `raised_by` is a person, and
  -- `raised_role` is the side they were on, which stays true after a role
  -- changes or an engagement ends.
  raised_by       uuid not null references auth.users (id),
  raised_role     text not null check (raised_role in ('owner', 'node')),

  -- What they say is wrong. Required, and length-bounded rather than unbounded:
  -- a dispute with no stated grievance is a freeze with no reason, and the
  -- console has to show this to the other party.
  reason          text not null check (char_length(btrim(reason)) between 1 and 4000),

  -- Anything further they want on the record. Optional; see the header for why
  -- this is text and not a join.
  evidence        text check (evidence is null or char_length(evidence) <= 8000),

  -- Where the task was when the dispute was raised. **Load-bearing rather than
  -- historical**: `resolve_dispute` refuses `rejection_upheld` unless this is
  -- `rejected`, because "the owner's rejection stands" is meaningless about a
  -- dispute raised mid-work. It is also what a reader needs to understand a
  -- resolution, since the task has moved by then.
  from_state      public.task_state not null,

  -- ---------- The resolution half: null together, written together ----------

  -- Checked text rather than an enum, `escrow_holds`' choice for its stated
  -- reason: `alter type ... add value` cannot be rolled back while a check
  -- constraint is dropped and re-added in a normal migration, and this
  -- vocabulary is one migration old.
  --
  -- The four from admin-ops.md:15 plus `rejection_upheld`, which that list does
  -- not name because it is the answer to a dispute only a node can raise, and
  -- nothing could raise one when that list was written.
  resolution      text check (resolution in
                    ('released', 'refunded', 'partial', 'reassigned', 'rejection_upheld')),

  -- What each side got, in the deal's currency. Written on `partial` and on
  -- `refunded`; null on the three resolutions that move no money here.
  -- `numeric(12,2)` matching `escrow_holds.amount`, which is what they are
  -- derived from and checked against.
  release_amount  numeric(12, 2) check (release_amount is null or release_amount > 0),
  refund_amount   numeric(12, 2) check (refund_amount is null or refund_amount > 0),

  -- Why ops decided what they decided. Required at resolution by the RPC and by
  -- the all-or-none constraint below, on admin-ops.md:25's rule: "No destructive
  -- action without a trail." The same sentence is written to `ops_actions`.
  resolution_note text check (resolution_note is null or char_length(btrim(resolution_note)) between 1 and 4000),

  resolved_by     uuid references auth.users (id),
  resolved_at     timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- **The derivation, made structural.** `engagements_outcome_iff_ended` is the
  -- precedent: a resolution is exactly as null as the timestamp that says one
  -- happened, so "open" cannot be ambiguous and a half-written resolution cannot
  -- exist. `resolved_by` and `resolution_note` join the group because a
  -- resolution with no author or no reason is the thing admin-ops.md forbids.
  constraint disputes_resolution_all_or_none
    check (num_nonnulls(resolution, resolved_at, resolved_by, resolution_note) in (0, 4)),

  -- Money is only ever recorded alongside a resolution.
  constraint disputes_amounts_need_a_resolution
    check (resolution is not null or num_nonnulls(release_amount, refund_amount) = 0),

  -- A partial names both halves; the two resolutions that move the whole hold in
  -- one direction name one; the rest name neither. Checked here as well as in
  -- the RPC because this is the row a dispute is read from afterwards.
  constraint disputes_amounts_match_resolution
    check (
      resolution is null
      or (resolution = 'partial' and release_amount is not null and refund_amount is not null)
      or (resolution = 'refunded' and release_amount is null and refund_amount is not null)
      or (resolution in ('released', 'reassigned', 'rejection_upheld')
          and release_amount is null and refund_amount is null)
    ),

  constraint disputes_resolved_after_raised
    check (resolved_at is null or resolved_at >= created_at)
);

-- **One open dispute per task**, written against the derivation rather than
-- against a status column, which is what keeps the two from disagreeing. A task
-- that was disputed, resolved, and disputed again gets a second row — and that
-- is also what makes `dispute-release:<dispute_id>` a safe idempotency key,
-- since a new grievance is a new row and therefore a new key (ADR-0014's epoch
-- argument, satisfied structurally rather than by counting).
create unique index disputes_one_open_per_task_idx
  on public.disputes (task_id) where resolved_at is null;

-- The console lists open disputes oldest-first; the panel and node console read
-- by task; the audit path reads by engagement.
create index disputes_open_idx on public.disputes (created_at) where resolved_at is null;
create index disputes_task_idx on public.disputes (task_id, created_at desc);
create index disputes_engagement_idx on public.disputes (engagement_id);
create index disputes_project_idx on public.disputes (project_id);

-- ---------- Write-once, and the audit entry that cannot be forgotten ----------
--
-- `guard_engagement_end`'s shape, for its reasons. Resolving is one-way: a
-- re-resolution would let "refunded" become "released" after the money moved,
-- which is the one edit that would make the trail lie about money.
create function private.guard_dispute_resolve()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.task_id is distinct from old.task_id
     or new.engagement_id is distinct from old.engagement_id
     or new.raised_by is distinct from old.raised_by
     or new.raised_role is distinct from old.raised_role
     or new.reason is distinct from old.reason
     or new.from_state is distinct from old.from_state
     or new.created_at is distinct from old.created_at then
    raise exception
      'dispute % is written once: the grievance, who raised it and where it was raised from cannot change',
      old.id
      using errcode = 'check_violation',
            hint = 'A different grievance is a different dispute, raised after this one resolves.';
  end if;

  if old.resolved_at is not null and new.resolved_at is null then
    raise exception 'dispute % has already been resolved and cannot be reopened', old.id
      using errcode = 'check_violation',
            hint = 'A resolution that turned out wrong is a new dispute, so the first decision stays readable.';
  end if;

  if old.resolution is not null and new.resolution is distinct from old.resolution then
    raise exception
      'dispute % was already resolved as %; a resolution is written once',
      old.id, old.resolution
      using errcode = 'check_violation';
  end if;

  new.updated_at := now();

  -- The house rule (`20260902120000:51-56`): one trigger for validation and
  -- audit, so the entry cannot be forgotten by a caller and cannot describe a
  -- resolution that did not happen. `dispute.raised` is written explicitly by
  -- `raise_dispute`, because a trigger on UPDATE audits no INSERT — the same
  -- split `engagements` has.
  if old.resolved_at is null and new.resolved_at is not null then
    insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
    values (
      new.project_id,
      auth.uid(),
      case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
      'dispute.resolved',
      'dispute',
      new.id,
      jsonb_build_object(
        'task_id', new.task_id,
        'engagement_id', new.engagement_id,
        'raised_role', new.raised_role,
        'from_state', new.from_state,
        'resolution', new.resolution,
        'release_amount', new.release_amount,
        'refund_amount', new.refund_amount,
        'resolved_by', new.resolved_by
      )
    );
  end if;

  return new;
end;
$$;

revoke all on function private.guard_dispute_resolve() from public;

create trigger disputes_guard_resolve
  before update on public.disputes
  for each row
  execute function private.guard_dispute_resolve();

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.disputes enable row level security;

-- The node reads disputes on their own deals — including one raised **against**
-- them, which is the point: a node who cannot read the grievance cannot answer
-- it, and the console shows ops both sides.
create policy "disputes_select_node" on public.disputes
  for select using (
    exists (
      select 1
      from public.engagements e
      where e.id = disputes.engagement_id
        and e.node_id = auth.uid()
    )
  );

-- The owner and their room-scoped members. `private.is_project_member` requires
-- `scope = 'room'`, so an admitted thread-scoped node does not read other
-- people's disputes through this half; they read their own through the policy
-- above.
create policy "disputes_select_member" on public.disputes
  for select using (private.is_project_member(project_id));

-- **Select only.** Raising and resolving are `raise_dispute` and
-- `resolve_dispute`, both granted to `service_role` alone, because both move
-- `tasks.state` and one of them moves money. A client INSERT could create a
-- dispute row for a task that never left its state, which is precisely the
-- two-truths defect the header refuses.
grant select on public.disputes to authenticated;
grant all on public.disputes to service_role;

-- Append-and-resolve, never erase, including for `service_role`: the
-- `engagements` / `offers` / `node_verifications` posture. A dispute is the
-- record of an accusation and a decision about somebody's money, and a record
-- trusted code can delete is not a record.
revoke delete, truncate on public.disputes from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.disputes is
  'One grievance about one deal, and what ops decided about it. NO STATE COLUMN (ADR-0016): '
  'tasks.state is the machine, disputed is a value in it, and open is derived as resolved_at is '
  'null. resolution looks like state and is not - null until resolved, written once, no arcs. '
  'One open dispute per task, as a partial unique index over that derivation.';

comment on column public.disputes.evidence is
  'Free text, deliberately not a join. The evidence a dispute reads already exists and is '
  'already immutable: artifacts at kind = proof, the offers trail (delete revoked even from '
  'service_role for this reason), messages, the room_members roster stamped rather than deleted, '
  'and the arithmetic in events.payload. What this column adds is what the raiser says is wrong.';

comment on column public.disputes.from_state is
  'Where the task was when this was raised. Load-bearing, not historical: resolve_dispute '
  'refuses rejection_upheld unless this is rejected, because "the owner''s rejection stands" is '
  'meaningless about a dispute raised mid-work.';

comment on column public.disputes.resolution is
  'The four outcomes admin-ops.md specifies, plus rejection_upheld for the node-raised case that '
  'list predates. Written once with resolved_at, resolved_by and resolution_note, or not at all.';

comment on function private.guard_dispute_resolve() is
  'Write-once on the grievance and on the resolution, and writes dispute.resolved. SECURITY '
  'DEFINER so it binds any writer including service_role (the 20260815200000 lesson). A '
  'resolution that turned out wrong is a new dispute, so the first decision stays readable.';
