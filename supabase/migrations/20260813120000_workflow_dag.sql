-- 20260813120000_workflow_dag.sql — projects, the task DAG, and the state machine.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md (the lifecycle this encodes)
--
-- Turns a plan from a CARD into WORK. Until now a plan was one `action_embeds`
-- row: six stages of prose with owners and citations, which a person could read
-- and approve and nothing could execute. This is the structure the scheduler
-- walks and the router dispatches, and it is deliberately built before either of
-- them, because both drive it and neither defines it.
--
-- Three properties are enforced HERE rather than in application code, because all
-- three are invariants of the data and not of one caller:
--
--   * **Illegal state transitions are rejected**, including for `service_role`.
--     The state machine in business-projects-workflow.md is the contract between
--     a non-deterministic reasoning core and a durable, auditable system. A guard
--     that only exists in the runner is a guard the next runner does not inherit,
--     and this project already plans to change runners (ADR-0001's escape hatch).
--   * **The DAG stays acyclic.** Nothing in the name enforces it. A cycle makes
--     the scheduler's "all hard deps done" question unanswerable, and the symptom
--     is a project that never advances rather than an error anyone can see.
--   * **Every transition is recorded**, by the same trigger that validates it.
--     Recording transitions from the caller would mean an audit trail that is
--     complete only as long as every caller remembers, which is not an audit trail.

-- ---------- Enums ----------

create type public.project_status as enum (
  'draft',       -- goal captured, not yet planned
  'planning',    -- orchestrator decomposing into a DAG
  'active',      -- scheduler dispatching READY tasks
  'paused',      -- user kill-switch, honoured at a safe checkpoint
  'completed',
  'cancelled'
);

-- Who executes a task. Mirrors PlanStep.owner across the seam (AI / HUMAN / YOU),
-- with 'user' spelled out because 'YOU' is presentation and this is storage.
create type public.task_owner_type as enum ('ai', 'human', 'user');

create type public.task_dep_kind as enum ('hard', 'soft', 'resource');

-- Mirrors the tool risk tiers in ai-orchestrator.md. Carried on the task so the
-- router can refuse to auto-run something irreversible without asking.
create type public.task_risk_tier as enum ('read_only', 'reversible', 'external', 'high_risk');

-- The full machine from business-projects-workflow.md.
--
-- Defined complete rather than trimmed to what is reachable today. The marketplace
-- states (matching..paid) have no code behind them until Phase 2's matcher lands,
-- and that is fine: the transition map below is the specification, and adding the
-- states later would mean editing this machine twice and re-deriving arcs that are
-- already written down. Which subgraph is live is recorded in the module doc, not
-- inferred from which enum values exist.
create type public.task_state as enum (
  'pending',
  'ready',
  'routing',
  'ai_running',
  'ai_self_check',
  'escalated',
  'needs_user',
  'matching',
  'offered',
  'claimed',
  'escrow_funded',
  'in_progress',
  'proof_submitted',
  'in_review',
  'approved',
  'payout_pending',
  'paid',
  'done',
  'rejected',
  'disputed',
  'failed',
  'cancelled',
  'blocked'
);

create type public.task_run_status as enum ('running', 'succeeded', 'failed', 'cancelled');

-- ---------- Tables ----------

create table public.projects (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id),
  goal           text not null,
  status         public.project_status not null default 'draft',
  -- The authorised ceiling. Nullable because a read-only planning project has no
  -- budget yet; NULL means "nothing authorised", never "unlimited". Spend caps are
  -- enforced in tool code (rule 7); this is the number they check against.
  budget_ceiling numeric(12, 2),
  currency       text not null default 'USD',
  -- Market for the marketing wedge, jurisdiction for later verticals. Kept as free
  -- text until jurisdiction packs exist, rather than an enum guessing their keys.
  market         text,
  archetype      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index projects_owner_idx on public.projects (owner_id, created_at desc);

-- `rooms.project_id` has existed since 20260728120000 with no foreign key, because
-- there was no table to point at. Now there is. Left nullable: a workspace room
-- can exist before any goal is posted in it, which is exactly what happens today.
alter table public.rooms
  add constraint rooms_project_id_fkey
  foreign key (project_id) references public.projects (id) on delete set null;

create index rooms_project_idx on public.rooms (project_id);

create table public.tasks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects (id) on delete cascade,
  title               text not null,
  detail              text,
  -- Which funnel stage this came from, so a plan card and its tasks stay
  -- reconcilable. Free text rather than an enum: FUNNEL_STAGES lives in
  -- packages/contracts and services/ai, and a third copy here would be a third
  -- thing to keep in step.
  stage               text,
  owner_type          public.task_owner_type not null,
  state               public.task_state not null default 'pending',
  risk_tier           public.task_risk_tier not null default 'reversible',
  -- What "done" means for this task, checked by the maker-checker critic before it
  -- can unblock anything. A task without criteria can only ever be approved by
  -- opinion.
  acceptance_criteria jsonb not null default '{}',
  inputs              jsonb not null default '{}',
  expected_artifact   text,
  cost_estimate       numeric(12, 2),
  -- Indices into the plan's citations. A task that came from a cited step keeps
  -- the citation, because rule 10 applies to the work as much as to the prose that
  -- proposed it.
  citations           int[] not null default '{}',
  -- Ordering within the project as the plan presented it. Not execution order:
  -- that is what task_deps decides.
  position            int not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index tasks_project_idx on public.tasks (project_id, position);
-- The scheduler's hot query: which tasks in this project are dispatchable.
create index tasks_state_idx on public.tasks (project_id, state);

create table public.task_deps (
  task_id            uuid not null references public.tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks (id) on delete cascade,
  dep_kind           public.task_dep_kind not null default 'hard',
  primary key (task_id, depends_on_task_id),

  -- A task depending on itself is a cycle of length one, and the recursive check
  -- below would not catch it as cheaply.
  constraint task_deps_no_self check (task_id <> depends_on_task_id)
);

create index task_deps_depends_on_idx on public.task_deps (depends_on_task_id);

create table public.task_runs (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  -- Correlates to the durable run and to every log line and LLM trace it produced
  -- (observability.md). Text rather than uuid: the id's shape belongs to whichever
  -- orchestrator is running, and ADR-0001 documents changing it.
  agent_run_id text,
  status       public.task_run_status not null default 'running',
  attempt      int not null default 1,
  error        text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,

  -- Retries are attempts of the same task, and each one is its own row. Without
  -- this a replayed durable step silently overwrites the history of why the first
  -- attempt failed, which is the thing you need when debugging a replay.
  unique (task_id, attempt)
);

create index task_runs_task_idx on public.task_runs (task_id, started_at desc);

-- The append-only audit log (data-model.md).
--
-- `project_id` is an addition to the sketch in that doc, which listed no tenant
-- column. It is needed: without one, an event cannot be scoped to anybody, and a
-- log you cannot scope is a log you can only expose to nobody or to everybody.
--
-- Today it is exposed to nobody. There is deliberately NO client select policy:
-- the audit-trail explorer is an admin-ops console (Phase 3), and what a member
-- sees in the meantime is the human-readable projection of this log as system
-- messages in chat, which is what discord-chat-spec.md already specifies. Adding
-- a read policy is a decision to make when there is a console to justify it.
create table public.events (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid references public.projects (id) on delete cascade,
  actor_id     uuid references auth.users (id),
  actor_kind   public.author_kind not null default 'system',
  verb         text not null,
  subject_type text not null,
  subject_id   uuid not null,
  payload      jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

create index events_project_idx on public.events (project_id, created_at desc);
create index events_subject_idx on public.events (subject_type, subject_id, created_at desc);

-- ---------- Membership ----------
--
-- A project is visible to the members of a room that points at it. That reuses the
-- one membership definition the system already has rather than inventing a second
-- one to keep in step, and it is correct: the room is where the project is
-- discussed, so its members are exactly who should see the work.
--
-- KNOWN NARROWING, and it lands with threads. security-compliance.md requires a
-- human node to see only its engaged task thread, time-boxed. Threads do not exist
-- yet, so room membership is currently coarser than the target: a node admitted to
-- a room would see the whole DAG rather than one task. No node is admitted to any
-- room today, so nothing is exposed by it now, and the pgTAP suite asserts the
-- outsider and expired cases so the narrowing has somewhere to land.
create function private.is_project_member(p_project uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.rooms r
    join public.room_members m on m.room_id = r.id
    where r.project_id = p_project
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

revoke all on function private.is_project_member(uuid) from public;
-- anon keeps EXECUTE for the same reason is_room_member does: an unauthenticated
-- select must resolve to zero rows rather than a permission error.
grant execute on function private.is_project_member(uuid) to anon, authenticated;

-- ---------- The state machine ----------

-- Is this task state terminal? Terminal states have no outgoing arcs at all, which
-- is what makes "done" mean done rather than "done for now".
create function private.task_state_is_terminal(s public.task_state)
returns boolean
language sql
immutable
as $$
  select s in ('done', 'failed', 'cancelled');
$$;

-- The transition map, as data.
--
-- Derived from the diagram in business-projects-workflow.md plus the arcs that
-- diagram implies but does not draw (a critic that passes, a user who answers, an
-- offer that expires back into matching). Where this and the doc disagree, the doc
-- is the specification and this is the bug.
--
-- Two arcs are universal and expressed as rules rather than listed on every state,
-- because listing them 20 times is 20 places to forget one:
--   * anything non-terminal may be CANCELLED (the kill switch, honoured at a safe
--     checkpoint, must not have states it cannot reach)
--   * anything non-terminal may become BLOCKED (an external dependency stalled)
create function private.task_transition_allowed(
  p_from public.task_state,
  p_to   public.task_state
)
returns boolean
language plpgsql
immutable
as $$
begin
  -- Terminal means terminal. Checked first so no arc below can accidentally
  -- resurrect a cancelled task.
  if private.task_state_is_terminal(p_from) then
    return false;
  end if;

  if p_to in ('cancelled', 'blocked') then
    return true;
  end if;

  return case p_from
    when 'pending'         then p_to in ('ready')
    when 'ready'           then p_to in ('routing')
    -- The router's three outcomes: the AI runs it, an expert is needed, or only
    -- the person can answer.
    when 'routing'         then p_to in ('ai_running', 'escalated', 'needs_user')
    when 'ai_running'      then p_to in ('ai_self_check', 'escalated', 'failed')
    -- The critic either accepts the artifact, sends it back for a bounded retry,
    -- or gives up and escalates to a human. ai_self_check -> approved is the only
    -- path by which an AI task completes without anyone paying anybody.
    when 'ai_self_check'   then p_to in ('approved', 'ai_running', 'escalated', 'failed')
    -- The person answered, so re-route with what they said.
    when 'needs_user'      then p_to in ('routing')
    when 'escalated'       then p_to in ('matching')
    -- matching -> failed is "no eligible node", which is a real outcome and must
    -- not masquerade as an error.
    when 'matching'        then p_to in ('offered', 'failed')
    -- offered -> matching is the expiry/decline cascade: no task stalls on a
    -- silent node (human-nodes-marketplace.md).
    when 'offered'         then p_to in ('claimed', 'matching', 'failed')
    -- claimed -> matching is the no-show path, back into the cascade.
    when 'claimed'         then p_to in ('escrow_funded', 'matching')
    when 'escrow_funded'   then p_to in ('in_progress', 'disputed')
    when 'in_progress'     then p_to in ('proof_submitted', 'disputed')
    -- proof_submitted -> in_progress covers a proof withdrawn or superseded before
    -- review starts.
    when 'proof_submitted' then p_to in ('in_review', 'in_progress')
    when 'in_review'       then p_to in ('approved', 'rejected', 'disputed')
    -- The bounded re-do. "Bounded" is the runner's job to enforce; the machine
    -- only says the arc exists.
    when 'rejected'        then p_to in ('in_progress', 'disputed')
    -- Two exits, and which one applies is decided by who did the work: an AI task
    -- is simply done, a human task owes somebody money first.
    when 'approved'        then p_to in ('payout_pending', 'done')
    when 'payout_pending'  then p_to in ('paid', 'disputed')
    when 'paid'            then p_to in ('done')
    -- Ops resolving a dispute can release, send back, or reject.
    when 'disputed'        then p_to in ('approved', 'in_progress', 'rejected')
    -- Unblocking returns to whichever phase was interrupted.
    when 'blocked'         then p_to in ('ready', 'routing', 'in_progress', 'failed')
    else false
  end;
end;
$$;

revoke all on function private.task_state_is_terminal(public.task_state) from public;
revoke all on function private.task_transition_allowed(public.task_state, public.task_state) from public;

-- Validate the transition, then record it. One trigger for both, so an audit entry
-- cannot be forgotten by a caller and cannot describe a transition that did not
-- happen.
create function private.guard_task_transition()
returns trigger
language plpgsql
as $$
begin
  if not private.task_transition_allowed(old.state, new.state) then
    raise exception
      'illegal task transition % -> % for task %',
      old.state, new.state, old.id
      using errcode = 'check_violation',
            hint = 'See the state machine in docs/30-modules/business-projects-workflow.md.';
  end if;

  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    -- A write with no JWT is a server write. The agent and the matcher both act
    -- through the secret key, so they arrive here indistinguishable from each
    -- other; naming the specific actor is the caller's job via its own event.
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'task.transitioned',
    'task',
    new.id,
    jsonb_build_object('from', old.state, 'to', new.state)
  );

  return new;
end;
$$;

revoke all on function private.guard_task_transition() from public;

-- `when` matters: without it every unrelated UPDATE (a retry count, an artifact
-- path) would be validated as a transition from a state to itself, which the map
-- correctly rejects, and ordinary edits would become impossible.
create trigger tasks_guard_transition
  before update on public.tasks
  for each row
  when (old.state is distinct from new.state)
  execute function private.guard_task_transition();

-- ---------- The DAG stays a DAG ----------

create function private.guard_task_dep_acyclic()
returns trigger
language plpgsql
as $$
declare
  v_task_project uuid;
  v_dep_project  uuid;
begin
  select project_id into v_task_project from public.tasks where id = new.task_id;
  select project_id into v_dep_project  from public.tasks where id = new.depends_on_task_id;

  -- A cross-project edge would let one tenant's scheduler block on another's work
  -- and would make the project a leaky unit of cancellation.
  if v_task_project is distinct from v_dep_project then
    raise exception 'task_deps must stay within one project (% vs %)',
      v_task_project, v_dep_project
      using errcode = 'foreign_key_violation';
  end if;

  -- Walk the existing edges from the proposed dependency. If the task being given
  -- a new dependency is already reachable from it, this edge closes a cycle.
  if exists (
    with recursive reachable(id) as (
      select new.depends_on_task_id
      union
      select d.depends_on_task_id
      from public.task_deps d
      join reachable r on d.task_id = r.id
    )
    select 1 from reachable where id = new.task_id
  ) then
    raise exception 'task_deps edge % -> % would create a cycle',
      new.task_id, new.depends_on_task_id
      using errcode = 'check_violation',
            hint = 'The task graph must stay acyclic or the scheduler cannot decide what is READY.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_task_dep_acyclic() from public;

create trigger task_deps_guard_acyclic
  before insert or update on public.task_deps
  for each row
  execute function private.guard_task_dep_acyclic();

-- ---------- The scheduler's question ----------

-- Are this task's HARD dependencies all satisfied?
--
-- Soft and resource deps are deliberately not consulted: soft is a preference for
-- ordering and resource is a shared-constraint hint, and treating either as
-- blocking would stall a graph that is making perfectly good progress.
--
-- "Satisfied" is approved-or-later, not done. A dependent step can start once the
-- work it needed is accepted; waiting for `paid` would hold the whole graph on a
-- bank transfer.
create function public.task_deps_satisfied(p_task uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
    select 1
    from public.task_deps d
    join public.tasks t on t.id = d.depends_on_task_id
    where d.task_id = p_task
      and d.dep_kind = 'hard'
      and t.state not in ('approved', 'payout_pending', 'paid', 'done')
  );
$$;

comment on function public.task_deps_satisfied(uuid) is
  'True when every HARD dependency of this task has reached approved or later. '
  'The scheduler''s READY predicate.';

-- ---------- RLS ----------

alter table public.projects  enable row level security;
alter table public.tasks     enable row level security;
alter table public.task_deps enable row level security;
alter table public.task_runs enable row level security;
alter table public.events    enable row level security;

create policy "projects_select_member" on public.projects
  for select using (private.is_project_member(id));

create policy "tasks_select_member" on public.tasks
  for select using (private.is_project_member(project_id));

create policy "task_deps_select_member" on public.task_deps
  for select using (
    exists (
      select 1 from public.tasks t
      where t.id = task_deps.task_id and private.is_project_member(t.project_id)
    )
  );

create policy "task_runs_select_member" on public.task_runs
  for select using (
    exists (
      select 1 from public.tasks t
      where t.id = task_runs.task_id and private.is_project_member(t.project_id)
    )
  );

-- `events` gets NO select policy. See the table comment above: nobody reads it
-- from a client until there is a console that justifies it.

-- ---------- Grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and omitting
-- the grant is what made every table unreachable in 20260728170000.
--
-- Read-only for clients, everywhere. Every write here is a state transition driven
-- by the orchestrator, the scheduler or the matcher, all of which are trusted
-- server code. A client that could UPDATE `tasks` could mark its own task approved
-- and unblock a payout, which is precisely the authorisation the whole design puts
-- in tool code rather than in the caller.
grant select on public.projects  to authenticated;
grant select on public.tasks     to authenticated;
grant select on public.task_deps to authenticated;
grant select on public.task_runs to authenticated;

grant all on public.projects  to service_role;
grant all on public.tasks     to service_role;
grant all on public.task_deps to service_role;
grant all on public.task_runs to service_role;
grant all on public.events    to service_role;

-- Append-only, by grant, for the same reason feedback_events is: an audit record
-- that can be rewritten after the fact is not evidence of anything.
--
-- TRUNCATE is revoked alongside UPDATE and DELETE, and it is the one people miss.
-- `grant all` includes it, it is not row-level, and it ignores RLS entirely, so a
-- role holding it can empty the audit log whatever the policies say. That is the
-- same defect 20260812120100 closed for `anon`, arriving here by a different door.
revoke update, delete, truncate on public.events from service_role;

grant execute on function public.task_deps_satisfied(uuid) to authenticated, service_role;

-- ---------- Comments ----------

comment on table public.projects is
  'A venture: one goal, its budget ceiling, and its lifecycle. Client-readable, server-written.';
comment on table public.tasks is
  'The task DAG''s nodes. State transitions are validated and audited by trigger, '
  'including for service_role.';
comment on table public.task_deps is
  'DAG edges. Acyclicity and single-project containment are enforced by trigger.';
comment on table public.task_runs is
  'One row per attempt, so a retry never overwrites why the previous attempt failed.';
comment on table public.events is
  'Append-only audit log. No client read policy: members see the projection in chat.';
