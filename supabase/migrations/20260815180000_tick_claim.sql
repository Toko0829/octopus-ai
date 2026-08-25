-- 20260815180000_tick_claim.sql — one ticker at a time, over PostgREST (ADR-0010).
--
-- ADR-0010 specifies a lock so only one instance walks the DAG whatever the deploy
-- topology. The obvious implementation does not work here: `pg_advisory_lock` is
-- session-scoped, supabase-js speaks PostgREST, and PostgREST gives no session
-- affinity between calls, so a lock taken in one request is not held in the next.
-- `pg_try_advisory_xact_lock` would work but only inside one statement, and the
-- tick's logic is TypeScript by design (`@octopus/core` holds the decisions).
--
-- So the claim is a lease, the same shape as `task_runs.lease_until` and for the
-- same reason: a lease survives the caller disappearing, where a lock held by a
-- dead session has to be cleaned up by somebody.
--
-- **Worth being precise about what this does and does not protect.** It prevents
-- duplicated effort, not duplicated execution. Execution is already protected by
-- the unique attempt row on `task_runs`, so a second worker reaching the same task
-- is refused by the database rather than by this. That ordering matters: if this
-- table were the only guard, losing it would be a correctness bug instead of a
-- performance one.

create table private.tick_claim (
  -- One row, ever. The primary key is a constant so an INSERT of a second claim
  -- collides rather than creating a parallel lease nobody notices.
  id          bool primary key default true constraint tick_claim_single check (id),
  worker      text        not null,
  claimed_at  timestamptz not null default now(),
  lease_until timestamptz not null
);

comment on table private.tick_claim is
  'Which process is currently walking the DAG (ADR-0010). Prevents duplicated '
  'effort; duplicated EXECUTION is prevented by the unique attempt row on '
  'task_runs, which is the guard that actually protects correctness.';

create or replace function private.try_claim_tick(
  p_worker text,
  p_lease_seconds int default 120
)
returns boolean
language plpgsql
security invoker
set search_path = private, public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_claimed boolean;
begin
  -- One statement, so two callers racing are serialised by the row lock rather
  -- than by reading and then writing. The `where` on the conflict path is what
  -- makes it a try rather than a wait: an unexpired claim held by someone else
  -- updates nothing, and `returning` therefore yields no row.
  insert into private.tick_claim (id, worker, claimed_at, lease_until)
  values (true, p_worker, v_now, v_now + make_interval(secs => p_lease_seconds))
  on conflict (id) do update
     set worker      = excluded.worker,
         claimed_at  = excluded.claimed_at,
         lease_until = excluded.lease_until
   where private.tick_claim.lease_until < v_now
      -- The same worker re-claiming is an extension, not a contention. Without
      -- this a ticker whose previous pass ran long would lock itself out until
      -- its own lease expired.
      or private.tick_claim.worker = p_worker
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function private.try_claim_tick(text, int) is
  'Take the ticker lease, or return false if another worker holds an unexpired '
  'one. A lease rather than an advisory lock because PostgREST offers no session '
  'affinity, and because a lease survives the holder vanishing.';

create or replace function private.release_tick_claim(p_worker text)
returns void
language sql
security invoker
set search_path = private, public, pg_temp
as $$
  -- Scoped to the holder: a worker whose lease already expired and was taken by
  -- someone else must not be able to release the new holder's claim.
  update private.tick_claim
     set lease_until = now()
   where worker = p_worker;
$$;

-- `private`, INVOKER, service_role only. In Supabase `public` is the API schema,
-- so a helper there with EXECUTE granted is a published endpoint (lint 0028/0029,
-- the one `20260728160000` and `20260813130000` both exist to clear). Nothing here
-- is evaluated inside an RLS policy, so none of it needs to bypass RLS either.
revoke all on function private.try_claim_tick(text, int) from public;
revoke all on function private.release_tick_claim(text) from public;
grant execute on function private.try_claim_tick(text, int) to service_role;
grant execute on function private.release_tick_claim(text) to service_role;
grant select, insert, update on private.tick_claim to service_role;

-- ------------------------------------------------- PostgREST-reachable ----
--
-- supabase-js can only call RPCs in `public`, so the three functions the ticker
-- needs get thin wrappers there. Same containment as `scheduler_ready_tasks` and
-- `materialise_plan`: SECURITY INVOKER, and EXECUTE granted to `service_role`
-- alone, so `anon` and `authenticated` cannot reach them and lints 0028 / 0029 do
-- not fire. The logic stays in `private`; only the doorway is public.

create function public.try_claim_tick(p_worker text, p_lease_seconds int default 120)
returns boolean
language sql
security invoker
set search_path = public
as $$
  select private.try_claim_tick(p_worker, p_lease_seconds);
$$;

create function public.release_tick_claim(p_worker text)
returns void
language sql
security invoker
set search_path = public
as $$
  select private.release_tick_claim(p_worker);
$$;

create function public.reclaim_expired_runs()
returns table (task_id uuid, run_id uuid, attempt int)
language sql
security invoker
set search_path = public
as $$
  select * from private.reclaim_expired_runs(now());
$$;

revoke all on function public.try_claim_tick(text, int) from public;
revoke all on function public.release_tick_claim(text) from public;
revoke all on function public.reclaim_expired_runs() from public;
grant execute on function public.try_claim_tick(text, int) to service_role;
grant execute on function public.release_tick_claim(text) to service_role;
grant execute on function public.reclaim_expired_runs() to service_role;
