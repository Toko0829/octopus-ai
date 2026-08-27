-- 20260813130000_harden_workflow_functions.sql — clear the advisor lints that
-- 20260813120000 introduced.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/10-architecture/security-compliance.md
--
-- Written as a follow-up rather than by editing the previous migration, for the
-- same reason `20260728160000_harden_security_definer.sql` was: the previous one
-- is already applied, and a migration file that no longer matches what ran is
-- worse than an extra file.
--
-- Two findings, and the first one is embarrassing in a useful way: it is the
-- SAME lint (0028 / 0029) that `20260728160000` exists to clear, reintroduced by
-- someone who had read that migration. The pattern is easy to repeat because it
-- looks like ordinary least privilege: define a helper in `public`, grant EXECUTE
-- to the roles that need it. In Supabase, `public` is the API schema, so that
-- grant also publishes the function at `/rest/v1/rpc/<name>`.

-- ---------- 1. task_deps_satisfied does not belong in the API schema ----------
--
-- It was created in `public` as SECURITY DEFINER with EXECUTE granted to
-- `authenticated`, which published the scheduler's READY predicate as a callable
-- endpoint. Nothing client-side needs it: the scheduler is trusted server code,
-- and a client asking "is this task dispatchable" is a client reading the graph's
-- shape one probe at a time.
--
-- Moved to `private`, which PostgREST does not expose, and downgraded to
-- SECURITY INVOKER. DEFINER was never needed here. Unlike `is_room_member`, this
-- function is not evaluated inside an RLS policy, so it does not have to bypass
-- RLS to avoid recursion; it runs as `service_role`, which already sees every row.
-- Removing the privilege is better than hiding the endpoint that exposed it.
drop function if exists public.task_deps_satisfied(uuid);

create function private.task_deps_satisfied(p_task uuid)
returns boolean
language sql
stable
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

revoke all on function private.task_deps_satisfied(uuid) from public;
grant execute on function private.task_deps_satisfied(uuid) to service_role;

comment on function private.task_deps_satisfied(uuid) is
  'True when every HARD dependency of this task has reached approved or later. '
  'The scheduler''s READY predicate. Server-only: not in the API schema.';

-- ---------- 2. Pin search_path on the remaining workflow functions ----------
--
-- Advisor 0011. `is_project_member` already had it; these four did not, because
-- they are SECURITY INVOKER and it felt unnecessary. It is not: a function
-- resolving unqualified names through the caller's search_path can be pointed at
-- a different `events` or `tasks` by a caller who controls it, and the two guard
-- functions are the ones enforcing the state machine, which makes them exactly
-- the wrong pair to leave resolvable.
--
-- Bodies are unchanged apart from the SET clause and full schema qualification.

create or replace function private.task_state_is_terminal(s public.task_state)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('done', 'failed', 'cancelled');
$$;

create or replace function private.task_transition_allowed(
  p_from public.task_state,
  p_to   public.task_state
)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if private.task_state_is_terminal(p_from) then
    return false;
  end if;

  if p_to in ('cancelled', 'blocked') then
    return true;
  end if;

  return case p_from
    when 'pending'         then p_to in ('ready')
    when 'ready'           then p_to in ('routing')
    when 'routing'         then p_to in ('ai_running', 'escalated', 'needs_user')
    when 'ai_running'      then p_to in ('ai_self_check', 'escalated', 'failed')
    when 'ai_self_check'   then p_to in ('approved', 'ai_running', 'escalated', 'failed')
    when 'needs_user'      then p_to in ('routing')
    when 'escalated'       then p_to in ('matching')
    when 'matching'        then p_to in ('offered', 'failed')
    when 'offered'         then p_to in ('claimed', 'matching', 'failed')
    when 'claimed'         then p_to in ('escrow_funded', 'matching')
    when 'escrow_funded'   then p_to in ('in_progress', 'disputed')
    when 'in_progress'     then p_to in ('proof_submitted', 'disputed')
    when 'proof_submitted' then p_to in ('in_review', 'in_progress')
    when 'in_review'       then p_to in ('approved', 'rejected', 'disputed')
    when 'rejected'        then p_to in ('in_progress', 'disputed')
    when 'approved'        then p_to in ('payout_pending', 'done')
    when 'payout_pending'  then p_to in ('paid', 'disputed')
    when 'paid'            then p_to in ('done')
    when 'disputed'        then p_to in ('approved', 'in_progress', 'rejected')
    when 'blocked'         then p_to in ('ready', 'routing', 'in_progress', 'failed')
    else false
  end;
end;
$$;

create or replace function private.guard_task_transition()
returns trigger
language plpgsql
set search_path = public
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
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'task.transitioned',
    'task',
    new.id,
    jsonb_build_object('from', old.state, 'to', new.state)
  );

  return new;
end;
$$;

create or replace function private.guard_task_dep_acyclic()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_task_project uuid;
  v_dep_project  uuid;
begin
  select project_id into v_task_project from public.tasks where id = new.task_id;
  select project_id into v_dep_project  from public.tasks where id = new.depends_on_task_id;

  if v_task_project is distinct from v_dep_project then
    raise exception 'task_deps must stay within one project (% vs %)',
      v_task_project, v_dep_project
      using errcode = 'foreign_key_violation';
  end if;

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

revoke all on function private.task_state_is_terminal(public.task_state) from public;
revoke all on function private.task_transition_allowed(public.task_state, public.task_state) from public;
revoke all on function private.guard_task_transition() from public;
revoke all on function private.guard_task_dep_acyclic() from public;

-- ---------- Not a defect: events has RLS on and no policy ----------
--
-- Advisor 0008 reports this as INFO and it is deliberate, not an oversight. RLS
-- enabled with no policy denies every client read, which is exactly the intent:
-- the audit log has no client reader until the Phase 3 ops console exists, and
-- members already see its human-readable projection as chat system messages.
-- Recorded here so the next person reading the advisor output does not "fix" it
-- by adding a policy.