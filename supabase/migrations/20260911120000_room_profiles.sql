-- 20260911120000_room_profiles.sql — what a workspace knows about its own business, as facts.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/ai-orchestrator.md, docs/30-modules/chat-discord.md
--
-- Intake asked for the audience, the offer and the budget band on every goal,
-- because nothing stored them: `documents.owner_room_id` holds what a workspace
-- says about itself as prose for retrieval, and intake deliberately does not
-- retrieve (what somebody sells is in their head, not in the corpus). Four of
-- the five playbook slots are facts about the business rather than about a
-- goal, so they live on the room. Intake seeds its first round from them and
-- the second goal in a room asks nothing. `target_metric` is absent on purpose:
-- it belongs to a goal.
--
-- **Owner-only to read, and the first owner-only policy in this repository.**
-- Every other client policy here admits a room's members. A budget band is the
-- one thing a human node admitted to the room has no business seeing, and RLS
-- filters rows rather than columns, so the row is visible to the owner alone.
-- The alternative was the `channel_connections` precedent (no client policy at
-- all, an API projection after an ownership check). That precedent exists for
-- a table holding credentials; this one holds four sentences, the owner is the
-- only reader either way, and a policy that says so in SQL is a control a pgTAP
-- suite can assert directly. `private.is_room_owner` is the helper, shaped like
-- `private.is_room_member` and for the same reasons: security definer so a
-- policy can read `rooms`, executable by `anon` so an unauthenticated select
-- resolves to zero rows rather than a permission error.
--
-- **No client write grant.** Writes come from `apps/api` as `service_role`,
-- after the route has read the room as the caller and checked `owner_id`, and
-- from the agent run when intake finishes with something the owner stated. A
-- client able to update this row could state somebody else's budget.

create table public.room_profiles (
  room_id     uuid primary key references public.rooms (id) on delete cascade,
  icp         text check (icp is null or char_length(icp) between 1 and 400),
  offer       text check (offer is null or char_length(offer) between 1 and 400),
  budget_band text check (budget_band is null or char_length(budget_band) between 1 and 400),
  timeline    text check (timeline is null or char_length(timeline) between 1 and 400),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null
);

comment on table public.room_profiles is
  'What a workspace knows about its own business: the four intake slots that are '
  'facts about the business rather than about a goal. Owner-only to read, '
  'server-written.';

create function private.is_room_owner(p_room uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.rooms r
    where r.id = p_room
      and r.owner_id is not null
      and r.owner_id = auth.uid()
  );
$$;

revoke all on function private.is_room_owner(uuid) from public;
grant execute on function private.is_room_owner(uuid) to anon, authenticated;

alter table public.room_profiles enable row level security;

create policy room_profiles_select_owner on public.room_profiles
  for select to authenticated
  using (private.is_room_owner(room_id));

-- A policy is not a grant (data-model.md): select for the client role, nothing
-- else, and Supabase's default TRUNCATE/REFERENCES/TRIGGER revoked as every
-- table here does.
grant select on public.room_profiles to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.room_profiles
  from anon, authenticated;
grant all on public.room_profiles to service_role;
