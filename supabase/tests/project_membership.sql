-- project_membership.sql — a room's SECOND project is visible to its members.
--
-- Covers 20260827110000_project_membership_via_card.sql.
--
-- The regression this pins is not exotic and was live for two weeks.
-- `materialise_plan` writes `rooms.project_id` under `where ... and project_id is
-- null`, so the first plan approved in a room claims that column forever. While
-- `private.is_project_member` resolved membership through it, every later project
-- in that room was invisible to every client, including the person who approved
-- it. Measured on the live database before the fix: 6 projects of which 3 were
-- reachable, with 47 tasks and 28 of 58 artifacts unreachable.
--
-- It failed as **zero rows, never as an error**, which is why nothing caught it:
-- through PostgREST an invisible project and an empty one read identically. So
-- the assertions below are counts on both sides of the boundary rather than a
-- single "can the owner see it", because a predicate that returns nothing to
-- everybody would pass any one-sided version of this suite.
--
-- Asserted as `authenticated` with request.jwt.claims set, exactly as PostgREST
-- would. Running these as `postgres` would prove nothing: that role bypasses RLS,
-- which is precisely how a policy bug survives review. (The state-machine suites
-- do the opposite, on purpose and for the opposite reason.)
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/project_membership.sql

begin;

select extensions.plan(13);

-- ------------------------------------------------------------- fixtures ----

create temporary table pmids (k text primary key, v uuid) on commit drop;

create or replace function pg_temp.pid(p_k text) returns uuid
language sql stable as $$ select v from pmids where k = p_k $$;

insert into pmids (k, v)
select k, gen_random_uuid()
from unnest(array[
  'owner', 'expired', 'outsider',
  'room', 'legacy_room', 'other_room',
  'msg_first', 'msg_second', 'embed_first', 'embed_second',
  'proj_first', 'proj_second', 'proj_legacy', 'proj_other',
  'task_first', 'task_second', 'task_legacy', 'task_other',
  'art_first', 'art_second'
]) as k;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.pid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@project-membership-test.invalid', '', now(), now(), now()
from unnest(array['owner', 'expired', 'outsider']) as k;

-- The legacy project needs a room of its own, because `rooms.project_id` is a
-- single column: one room cannot point at two projects. Getting that wrong is how
-- the first draft of this suite failed its own legacy assertions and briefly
-- looked like a defect in the migration.
insert into public.rooms (id, name, owner_id)
values (pg_temp.pid('room'), 'Membership room', pg_temp.pid('owner')),
       (pg_temp.pid('legacy_room'), 'Room from before plan cards', pg_temp.pid('owner')),
       (pg_temp.pid('other_room'), 'Somebody else''s room', pg_temp.pid('outsider'));

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.pid('room'), pg_temp.pid('owner'),   'user',       'room', null),
       (pg_temp.pid('legacy_room'), pg_temp.pid('owner'), 'user',    'room', null),
       -- Time-boxed access that has run out. The marketplace rests on this, so it
       -- is asserted against the NEW predicate rather than assumed to carry over.
       (pg_temp.pid('room'), pg_temp.pid('expired'), 'human_node', 'room', now() - interval '1 hour'),
       (pg_temp.pid('other_room'), pg_temp.pid('outsider'), 'user', 'room', null);

-- Two plan cards posted in the one room, which is the ordinary case: a person
-- approves a plan, and later approves another.
insert into public.messages (id, room_id, author_kind, body)
values (pg_temp.pid('msg_first'),  pg_temp.pid('room'), 'agent', 'First plan'),
       (pg_temp.pid('msg_second'), pg_temp.pid('room'), 'agent', 'Second plan');

insert into public.action_embeds (id, message_id, room_id, component, payload, state)
values (pg_temp.pid('embed_first'),  pg_temp.pid('msg_first'),  pg_temp.pid('room'),
        'plan', '{"kind":"plan"}'::jsonb, 'approved'),
       (pg_temp.pid('embed_second'), pg_temp.pid('msg_second'), pg_temp.pid('room'),
        'plan', '{"kind":"plan"}'::jsonb, 'approved');

insert into public.projects (id, owner_id, goal, status, source_embed_id)
values (pg_temp.pid('proj_first'),  pg_temp.pid('owner'), 'first goal',  'active', pg_temp.pid('embed_first')),
       (pg_temp.pid('proj_second'), pg_temp.pid('owner'), 'second goal', 'active', pg_temp.pid('embed_second')),
       -- No card at all: a project from before source_embed_id existed. Reachable
       -- only through rooms.project_id, which is why that link is kept.
       (pg_temp.pid('proj_legacy'), pg_temp.pid('owner'), 'legacy goal', 'active', null),
       (pg_temp.pid('proj_other'),  pg_temp.pid('outsider'), 'not ours',  'active', null);

-- The room claims the FIRST project, exactly as materialise_plan leaves it. This
-- single line is what made every other project in the room invisible.
update public.rooms set project_id = pg_temp.pid('proj_first') where id = pg_temp.pid('room');
update public.rooms set project_id = pg_temp.pid('proj_legacy') where id = pg_temp.pid('legacy_room');
update public.rooms set project_id = pg_temp.pid('proj_other') where id = pg_temp.pid('other_room');

insert into public.tasks (id, project_id, title, owner_type, state)
values (pg_temp.pid('task_first'),  pg_temp.pid('proj_first'),  'Step of the first plan',  'ai', 'approved'),
       (pg_temp.pid('task_second'), pg_temp.pid('proj_second'), 'Step of the second plan', 'ai', 'approved'),
       (pg_temp.pid('task_legacy'), pg_temp.pid('proj_legacy'), 'Step of a legacy plan',   'ai', 'approved'),
       (pg_temp.pid('task_other'),  pg_temp.pid('proj_other'),  'Not ours',                'ai', 'approved');

insert into public.artifacts (id, task_id, project_id, kind, title, body)
values (pg_temp.pid('art_first'),  pg_temp.pid('task_first'),  pg_temp.pid('proj_first'),
        'draft', 'Delivered by the first plan',  'body'),
       (pg_temp.pid('art_second'), pg_temp.pid('task_second'), pg_temp.pid('proj_second'),
        'draft', 'Delivered by the second plan', 'body');

-- Count as a given user, exactly as PostgREST would. Same idiom as rls_workflow.sql.
create or replace function pg_temp.pcount_as(p_user uuid, p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql into n;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

-- ------------------------------------------------- the regression itself ----

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.projects where id = %L', pg_temp.pid('proj_second'))),
  1::bigint,
  'owner sees the SECOND project in the room (the regression: no room points at it)'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.tasks where project_id = %L', pg_temp.pid('proj_second'))),
  1::bigint,
  'owner sees the second project''s tasks'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.artifacts where project_id = %L', pg_temp.pid('proj_second'))),
  1::bigint,
  'owner sees the second project''s artifacts, which is the work they paid for'
);

-- ----------------------------------------- the first project still works ----

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.projects where id = %L', pg_temp.pid('proj_first'))),
  1::bigint,
  'owner still sees the first project (the card link covers what the room link did)'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.artifacts where project_id = %L', pg_temp.pid('proj_first'))),
  1::bigint,
  'owner still sees the first project''s artifacts'
);

-- ------------------------------------------------ the legacy link is kept ----

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.projects where id = %L', pg_temp.pid('proj_legacy'))),
  1::bigint,
  'a project with no plan card stays visible through rooms.project_id'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.tasks where id = %L', pg_temp.pid('task_legacy'))),
  1::bigint,
  'and so do its tasks'
);

-- --------------------------------------------------- nothing else widened ----

-- The whole point of a membership predicate is what it refuses. A version of this
-- fix that simply returned true would pass every assertion above.

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('outsider'),
    format('select count(*) from public.projects where id in (%L, %L, %L)',
           pg_temp.pid('proj_first'), pg_temp.pid('proj_second'), pg_temp.pid('proj_legacy'))),
  0::bigint,
  'a member of a different room sees none of this room''s projects'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('outsider'),
    format('select count(*) from public.tasks where project_id in (%L, %L)',
           pg_temp.pid('proj_first'), pg_temp.pid('proj_second'))),
  0::bigint,
  'nor their tasks'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('outsider'),
    format('select count(*) from public.artifacts where project_id in (%L, %L)',
           pg_temp.pid('proj_first'), pg_temp.pid('proj_second'))),
  0::bigint,
  'nor their artifacts'
);

-- An expired node sees NOTHING AT ALL. Same property rls_membership.sql calls the
-- load-bearing one, re-asserted here because this migration rewrote the predicate
-- that enforces it and a time-box dropped in a rewrite is silent.

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('expired'),
    format('select count(*) from public.projects where id in (%L, %L)',
           pg_temp.pid('proj_first'), pg_temp.pid('proj_second'))),
  0::bigint,
  'an expired node sees neither project, however the room resolves'
);

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('expired'),
    format('select count(*) from public.artifacts where project_id = %L', pg_temp.pid('proj_second'))),
  0::bigint,
  'an expired node sees no artifacts'
);

-- The room this project does NOT belong to must not become an access path just
-- because its member is looking at a project of the same owner.

select extensions.is(
  pg_temp.pcount_as(pg_temp.pid('owner'),
    format('select count(*) from public.projects where id = %L', pg_temp.pid('proj_other'))),
  0::bigint,
  'the owner sees nothing in a room they do not belong to'
);

select * from extensions.finish();

rollback;
