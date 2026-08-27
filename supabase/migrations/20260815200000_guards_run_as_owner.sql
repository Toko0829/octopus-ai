-- 20260815200000_guards_run_as_owner.sql — the state machine could not be entered
-- by the only role that writes to it.
--
-- `20260813130000` hardened the workflow functions, correctly, and locked
-- `service_role` out of the machine those functions enforce. The trigger fired,
-- ran as the caller, and its first internal call failed:
--
--   42501: permission denied for function task_transition_allowed
--   CONTEXT: PL/pgSQL function private.guard_task_transition() line 3 at IF
--
-- So **every** write to `tasks.state` through the API was refused. A plan
-- materialised, its tasks sat `PENDING`, and each tick swept them and failed
-- sixteen times. Nothing surfaced it: the scheduler is a best-effort sweep by
-- design, a refusal is recorded rather than thrown, and the approval route
-- reports success because the approval genuinely did succeed.
--
-- **Why the tests could not see it.** `rls_workflow.sql` asserts the state machine
-- as `postgres`, deliberately, because a guard must bind trusted code too. That is
-- the right assertion and it is exactly why it is blind here: `postgres` owns
-- these functions. The suite proved the machine works; it could not prove anyone
-- could reach it. A missing grant is also not a lint, so the advisor was silent.
-- Only running the product found it, twice in one session, the other being
-- `service_role` having no USAGE on the schema at all (`20260815190000`).
--
-- **The fix is DEFINER on the guards rather than a grant to the caller**, and that
-- is the point. Granting EXECUTE to `service_role` would work today and leave the
-- same trap for the next role that writes a task: the machine's internals are not
-- a caller's business, and a guard that binds trusted code must not depend on
-- trusted code holding privileges on its private parts. Both functions are pure
-- logic over enum values, read no tables, live in a schema PostgREST does not
-- expose, and already pin `search_path`, so running them as owner widens nothing.

alter function private.guard_task_transition() security definer;
alter function private.guard_task_dep_acyclic() security definer;

comment on function private.guard_task_transition() is
  'Enforces the per-task state machine on every UPDATE. SECURITY DEFINER so the '
  'machine binds any writer without that writer needing EXECUTE on its internals, '
  'which is what silently refused every transition from the API.';

comment on function private.guard_task_dep_acyclic() is
  'Keeps the DAG acyclic and edges inside one project. SECURITY DEFINER for the '
  'same reason as the transition guard.';
