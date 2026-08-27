-- 20260815190000_service_role_private_usage.sql — the grant that made the
-- scheduler a no-op through the API.
--
-- `service_role` had no USAGE on `private`. Every `SECURITY INVOKER` wrapper in
-- `public` that reaches into `private` therefore failed with `42501 permission
-- denied for schema private` for the exact role it was written for, including
-- `public.scheduler_ready_tasks`. **The scheduler has never worked through
-- supabase-js.** A plan materialised, its tasks sat `PENDING`, the inline tick
-- after approval threw, and the route caught it, logged it, and returned the
-- approval as successful, which is the correct degradation and also the reason
-- nobody noticed.
--
-- Worth being precise about why the pgTAP suites did not catch it. They run the
-- state-machine assertions **as `postgres` on purpose**, which is right for what
-- they assert (a guard must bind trusted code too) and is exactly why they cannot
-- see this: `postgres` has USAGE on everything. The advisor could not see it
-- either, because a missing grant is not a lint. It took running the product.
--
-- **USAGE is not EXECUTE**, which is what keeps this narrow. It permits `private`
-- to be named; every function and table in it still needs its own grant, and
-- those remain `service_role`-only. `anon` gets nothing, as `20260728170000` and
-- `20260812120100` intend.
--
-- `authenticated` already holds USAGE here and that is correct rather than an
-- oversight: RLS policy expressions are evaluated as the **querying** role, so
-- `authenticated` must be able to reach `private.is_room_member`, and revoking it
-- would break every membership policy in the schema. See data-model.md.

grant usage on schema private to service_role;

comment on schema private is
  'Helpers PostgREST must not expose. `service_role` needs USAGE to call the '
  'public SECURITY INVOKER wrappers that reach in here (without it the scheduler '
  'silently no-ops); `authenticated` needs it so RLS policies can evaluate '
  'is_room_member as the querying role. Neither grants EXECUTE or SELECT, which '
  'stay per-object.';
