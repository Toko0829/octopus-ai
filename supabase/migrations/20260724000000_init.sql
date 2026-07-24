-- 20260724000000_init.sql — Phase 0 baseline: identity + the RLS pattern.
-- Owner doc: docs/10-architecture/data-model.md · docs/30-modules/auth-identity.md
-- Every migration lands with its RLS policy (and, in CI, a pgTAP test).

-- Roles mirror @octopus/config ROLES. Role changes are never self-service.
create type public.user_role as enum ('user', 'human_node', 'verified_pro', 'admin', 'ops');

create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role         public.user_role not null default 'user',
  jurisdiction text,
  languages    text[] not null default '{}',
  created_at   timestamptz not null default now()
);

-- RLS ON by default (defense-in-depth backstop; app checks live in Fastify too).
alter table public.profiles enable row level security;

-- A user may read and update their OWN profile. Role escalation is blocked here
-- (a later migration adds a trigger preventing self role changes); admin/ops act
-- via the server-only service_role path, never the client.
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-provision a profile when a new auth user is created.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
