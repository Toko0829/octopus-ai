-- 20260815170000_run_leases.sql — crash recovery for in-process runs (ADR-0010).
--
-- Durable runs move onto the Postgres already holding the state, rather than onto
-- a managed orchestrator. ADR-0006 left no continuation to preserve (the reasoning
-- core is stateless and Node drives it a step at a time), and `20260813120000` put
-- the state machine under trigger enforcement, so what is actually missing is
-- narrow: a way to tell a task that is RUNNING from one whose worker died.
--
-- Today those are indistinguishable. A crash mid-execute leaves `tasks.state =
-- 'ai_running'` and a `task_runs` row at `running` forever, and nothing sweeps it,
-- which is the symptom `ai-orchestrator.md` already records as expected until this
-- lands. A lease makes the difference observable: a live worker keeps extending
-- it, a dead one stops.

alter table public.task_runs
  add column lease_until timestamptz;

comment on column public.task_runs.lease_until is
  'When this attempt stops being presumed alive (ADR-0010). A running worker '
  'extends it; the reclaim sweep takes anything past it. Null means no lease was '
  'ever taken, which is how rows written before this migration read, so the sweep '
  'must not treat null as expired.';

-- Partial, because the sweep only ever asks about live attempts and that is a
-- small slice of a table that grows one row per attempt forever.
create index task_runs_live_lease_idx
  on public.task_runs (lease_until)
  where status = 'running';

-- ---------------------------------------------------------------- reclaim ----
--
-- Returns the tasks it recovered so the caller can log them individually. A count
-- would be cheaper and would hide which project stalled, and "why did this task
-- restart" is the first question anyone asks about one.
create or replace function private.reclaim_expired_runs(p_now timestamptz default now())
returns table (task_id uuid, run_id uuid, attempt int)
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
begin
  -- Conditional on `status = 'running'` in the UPDATE itself rather than checked
  -- first, so a worker that finishes while this runs simply wins: its own update
  -- lands, and this one matches nothing. Reading then writing would be the race
  -- this exists to survive, not one to introduce.
  --
  -- `lease_until is not null` matters: rows from before this migration carry
  -- null, and treating that as expired would reclaim every historical attempt on
  -- the first sweep.
  return query
  with expired as (
    update public.task_runs r
       set status  = 'failed',
           error   = coalesce(r.error, 'lease expired; worker presumed lost'),
           ended_at = p_now
     where r.status = 'running'
       and r.lease_until is not null
       and r.lease_until < p_now
    returning r.task_id, r.id, r.attempt
  )
  select e.task_id, e.id, e.attempt from expired e;
end;
$$;

comment on function private.reclaim_expired_runs(timestamptz) is
  'Fail attempts whose worker stopped extending the lease (ADR-0010). Deliberately '
  'does NOT move the task itself: the state machine has one owner and it is the '
  'scheduler, so this reports what died and lets the caller decide between a retry '
  'and an escalation.';

-- `private`, not `public`, and INVOKER rather than DEFINER. Both deliberate, and
-- both are the lesson `20260813130000` exists to record: in Supabase `public` is
-- the API schema, so creating a helper there and granting EXECUTE publishes it at
-- /rest/v1/rpc/. This is never evaluated inside an RLS policy, so it never needed
-- to bypass RLS either. Only trusted server code calls it.
revoke all on function private.reclaim_expired_runs(timestamptz) from public;
grant execute on function private.reclaim_expired_runs(timestamptz) to service_role;
