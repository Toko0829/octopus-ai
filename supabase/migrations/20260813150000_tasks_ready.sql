-- 20260813150000_tasks_ready.sql — the scheduler's selection query.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md
--
-- `task_deps_satisfied` answers the question for one task. This answers it for a
-- project, which is what the scheduler actually asks.
--
-- It lives in SQL rather than in the scheduler for one reason: there must be ONE
-- definition of "ready". A TypeScript reimplementation would be a second, and the
-- two would drift the first time either the dependency semantics or the set of
-- satisfying states changed. The scheduler's job is to decide what happens to a
-- ready task, not to work out which tasks those are.
--
-- Ordered by position so a tick processes a project in the order the plan
-- presented it. That is a readability property rather than a correctness one:
-- anything the order actually matters for is a dependency and belongs in an edge.
create function private.tasks_ready(p_project uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  select t.id
  from public.tasks t
  where t.project_id = p_project
    and t.state = 'pending'
    and private.task_deps_satisfied(t.id)
  order by t.position;
$$;

revoke all on function private.tasks_ready(uuid) from public;
grant execute on function private.tasks_ready(uuid) to service_role;

comment on function private.tasks_ready(uuid) is
  'Tasks in this project that are PENDING with every hard dependency satisfied. '
  'The scheduler''s selection query; server-only.';

-- A thin wrapper in the API schema, because supabase-js can only call RPCs in
-- `public`. Same containment as `materialise_plan`: SECURITY INVOKER, and EXECUTE
-- granted to `service_role` alone, so `anon` and `authenticated` cannot reach it
-- and advisor lints 0028 / 0029 do not fire.
create function public.scheduler_ready_tasks(p_project uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select private.tasks_ready(p_project);
$$;

revoke all on function public.scheduler_ready_tasks(uuid) from public;
grant execute on function public.scheduler_ready_tasks(uuid) to service_role;

comment on function public.scheduler_ready_tasks(uuid) is
  'PostgREST-reachable wrapper over private.tasks_ready. service_role only.';
