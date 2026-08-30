-- 20260831110000_profiles_role_is_not_self_service.sql — a comment promised this
-- guard on day one and no migration ever wrote it.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/auth-identity.md (the role model this defends)
--
-- `20260724000000_init.sql:21` says, in the file that creates the table:
--
--   "A user may read and update their OWN profile. Role escalation is blocked
--    here (a later migration adds a trigger preventing self role changes)"
--
-- There is no later migration. Forty-four files were grepped and the trigger
-- does not exist. `profiles_update_own` carries `using (auth.uid() = user_id)`
-- and no column restriction, and `20260728170000:22` grants `update` on **every
-- column** to `authenticated`, restated verbatim at `20260812120100:31`. So
-- this succeeds today, for any signed-in person, through PostgREST:
--
--   update public.profiles set role = 'admin' where user_id = auth.uid();
--
-- This is the defect class this repository keeps paying for and has now named
-- four times: `tasks.risk_tier` unreachable for its whole life, `task_deps`
-- holding no row for two weeks, `artifacts.storage_path` with no bucket,
-- `projects.budget_ceiling` with no writer. This one is the same shape and the
-- worst payload — **a promise written in a comment and enforced by nothing** —
-- and the promise reads as though it were kept, which is why it survived
-- forty-four migrations of review.
--
-- **It is latent today and stops being latent in the next slice.** Nothing
-- currently authorises on `profiles.role`: `apps/api/src/plugins/auth.ts:48`
-- reads the role from the JWT, and ownership everywhere comes from
-- `rooms.owner_id`. That is why this is a fix rather than an incident. But the
-- marketplace domain lands next and makes `human_node` mean "eligible for paid
-- work funded from somebody else's authorised budget", at which point a
-- self-service role column is escalation straight into the money path. A latent
-- defect fixed before its exploit path opens is the cheapest one this repository
-- will ever close.
--
-- **Two controls, because the first one has already been silently undone once.**
-- The column grant is the real fix. The trigger is there because
-- `20260812120100` restated the table-wide grant while doing something else
-- entirely, and a future migration restoring `grant update on public.profiles`
-- would re-open this with no diff that looks like a security change. A `grant`
-- line cannot undo a trigger. Defense in depth (rule 6) means the second layer
-- has to fail differently from the first, and this one does.

-- ---------- The grant ----------
--
-- `revoke` then a column grant, rather than editing the earlier files: replaying
-- migrations in order must reproduce this state, and rewriting history would
-- leave a database migrated before today permanently wrong.
--
-- `role` is the column that matters. `created_at` and `user_id` are listed out
-- by omission for the same reason: a client has no business rewriting when its
-- own row was created, and `user_id` is the primary key the policy tests.

revoke update on public.profiles from authenticated;

grant update (display_name, jurisdiction, languages) on public.profiles to authenticated;

-- ---------- The trigger ----------
--
-- `auth.uid() is not null` is the whole distinction between a person and the
-- server. `service_role` writes with no JWT, so `auth.uid()` reads null and
-- ops/admin promotion through the server path keeps working exactly as
-- `20260724000000` intended. A request that carries a person's claims is a
-- person, whatever function it is travelling through, which is the property
-- worth having: a future `security definer` helper cannot launder a role change
-- on a user's behalf.
--
-- The predicate lives entirely in the trigger's `when` clause and the body is
-- nothing but the raise, exactly as `private.guard_ad_entity_external_id`
-- (`20260829150000`) is written. That shape is what makes the ordinary case
-- free: an update that does not touch `role` never enters this function.
--
-- `security definer` with `set search_path` pinned is the `20260815200000`
-- lesson and lint 0011.

create function private.guard_profile_role_self_service()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    'role changes are not self-service: % tried to become %',
    old.user_id, new.role
    using errcode = 'insufficient_privilege',
          hint = 'Roles are set by the server through service_role. See docs/30-modules/auth-identity.md.';
end;
$$;

revoke all on function private.guard_profile_role_self_service() from public;

create trigger profiles_guard_role_self_service
  before update on public.profiles
  for each row
  when (old.role is distinct from new.role and auth.uid() is not null)
  execute function private.guard_profile_role_self_service();

comment on function private.guard_profile_role_self_service() is
  'Refuses a role change made by anyone carrying a JWT. The column grant on '
  'public.profiles is the primary control; this is the layer a future grant '
  'cannot silently undo, which is how the original gap survived 44 migrations.';

comment on column public.profiles.role is
  'Platform role. Server-written only: authenticated holds no UPDATE grant on this '
  'column and a trigger refuses the change even if one is restored. Never self-service.';
