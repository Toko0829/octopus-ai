-- Project membership resolves through the plan card, not through rooms.project_id.
--
-- `private.is_project_member` has always asked "is there a room pointing at this
-- project that the caller belongs to". `materialise_plan` writes `rooms.project_id`
-- once, under `where ... and project_id is null`, so the FIRST project approved in
-- a room claims that column permanently and every later project has no room
-- pointing at it. The predicate therefore returned false for all of them, for
-- everybody, including the person who approved the plan and owns the work.
--
-- It fails as zero rows rather than as an error, which is why it survived: an
-- invisible project and a project with nothing in it read identically through
-- PostgREST. Measured on the live database before this migration: 6 projects, of
-- which 3 were reachable by any client, with **47 tasks and 28 of 58 artifacts**
-- unreachable. One workspace had produced four projects and could see one.
--
-- This is the same root cause as the delivery defect recorded in
-- docs/10-architecture/architecture.md, where 8 approved tasks and 8 stored
-- artifacts never reached the chat because the room still pointed at a project
-- from nine days earlier. That path was fixed in `apps/api/src/lib/room-for-project.ts`
-- by resolving through `projects.source_embed_id`; the RLS predicate was not, so
-- the same wrong question stayed in the security layer for another two weeks.
--
-- `projects.source_embed_id` is unique, set at creation and never changed: a
-- project came from exactly one plan card, and that card was posted in exactly one
-- room. `rooms.project_id` keeps its meaning as "the project this room is
-- currently about", which is a fine thing for a UI to read and the wrong thing to
-- derive access from, because it answers a question that changes.
--
-- Both links are honoured. The card link is the durable one; the room link stays
-- so a project created before `source_embed_id` existed, or by any future writer
-- of that column, does not lose visibility in the other direction. Neither widens
-- tenancy: both terminate in a `room_members` row for the caller, and the
-- time-box on that row is checked exactly as before, so an expired node still
-- sees nothing at all.
--
-- KNOWN NARROWING, unchanged and still landing with threads: security-compliance.md
-- requires a human node to see only its engaged task thread, time-boxed. Room
-- membership remains coarser than that. No node is admitted to any room today.

create or replace function private.is_project_member(p_project uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  with rooms_for_project as (
    -- The durable link: the room the project's plan card was posted in.
    select ae.room_id
    from public.projects p
    join public.action_embeds ae on ae.id = p.source_embed_id
    where p.id = p_project

    union

    -- The legacy link, for projects that predate source_embed_id.
    select r.id
    from public.rooms r
    where r.project_id = p_project
  )
  select exists (
    select 1
    from rooms_for_project rp
    join public.room_members m on m.room_id = rp.room_id
    where m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

comment on function private.is_project_member(uuid) is
  'Membership for every workflow table. Resolves the project to its room through '
  'the plan card it was materialised from (projects.source_embed_id), because '
  'rooms.project_id is claimed by the first project approved in a room and is '
  'therefore not an access path. Both links are accepted; both require a live '
  'room_members row for auth.uid().';

-- Restated rather than assumed. CREATE OR REPLACE preserves the existing ACL, so
-- these are no-ops today; they are here because a function whose grants live only
-- in the migration that first created it is one the next reader has to go looking
-- for. anon keeps EXECUTE for the same reason is_room_member does: an
-- unauthenticated select must resolve to zero rows rather than a permission error.
revoke all on function private.is_project_member(uuid) from public;
grant execute on function private.is_project_member(uuid) to anon, authenticated;
