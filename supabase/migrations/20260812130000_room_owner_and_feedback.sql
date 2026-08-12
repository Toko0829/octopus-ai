-- 20260812130000_room_owner_and_feedback.sql — ownership, and the first labelled data.
-- Owner doc: docs/10-architecture/data-model.md
--
-- Two additions that belong together because the second is only meaningful once
-- the first makes the approve action real.

-- rooms.owner_id: who the room belongs to.
--
-- `action_embeds.required_role` is 'owner', and nothing could evaluate that.
-- `room_members.role` is the platform role enum (user / human_node / admin), not
-- a statement of ownership, and every member of a room carries 'user'. Approving
-- a plan is the first action gated on ownership, so without this column the check
-- would be nominal: a rule written down and enforced by nothing.
--
-- Nullable, because it is backfilled below and because a room may later belong to
-- a project rather than directly to a person (data-model.md keeps `owner_id` on
-- `projects`). A null owner means nobody can approve, which is the safe default
-- rather than the permissive one.
alter table public.rooms add column owner_id uuid references auth.users (id);

-- The earliest member is the creator: POST /api/rooms inserts the caller as the
-- first member immediately after creating the room.
update public.rooms r
set owner_id = (
  select m.user_id from public.room_members m
  where m.room_id = r.id
  order by m.joined_at asc
  limit 1
)
where r.owner_id is null;

create index rooms_owner_idx on public.rooms (owner_id);

-- feedback_events: flywheel v0 (learning-flywheel.md, mechanism 2).
--
-- Every approve / request-changes on a plan is a labelled example: the AI
-- produced something and a human accepted or rejected it. This is the first
-- labelled data the system collects, and the correction rate derived from it is
-- the metric that says whether the AI is actually learning the vertical.
--
-- Append-only by grant. No client role gets UPDATE or DELETE, because a training
-- signal that can be rewritten after the fact is not evidence of anything.
create table public.feedback_events (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms (id) on delete cascade,
  embed_id    uuid references public.action_embeds (id) on delete set null,
  actor_id    uuid not null references auth.users (id),
  verdict     text not null check (verdict in ('approved', 'changes_requested')),
  -- The most valuable part of a rejection is why, so the note is captured with it.
  note        text,
  -- The output being judged, captured at decision time. Denormalised deliberately:
  -- the embed's state changes after the verdict, and a label has to describe what
  -- was actually judged rather than what the row looks like later.
  subject     jsonb not null,
  created_at  timestamptz not null default now()
);

create index feedback_events_room_idx on public.feedback_events (room_id, created_at desc);

alter table public.feedback_events enable row level security;

create policy "feedback_events_select_member" on public.feedback_events
  for select using (private.is_room_member(room_id));

grant select on public.feedback_events to authenticated;
grant all on public.feedback_events to service_role;

comment on table public.feedback_events is
  'Flywheel v0: human verdicts on AI output, as labelled data. Append-only; written server-side.';
