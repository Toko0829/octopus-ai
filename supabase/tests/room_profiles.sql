-- room_profiles: what a workspace knows about its business is the owner's to read.
-- Covers 20260911120000_room_profiles.sql.
--
-- The assertion worth reading first is the second one: a MEMBER of the room,
-- not an outsider, reads zero rows. Every other client policy in this database
-- admits a room's members, and this is the first that does not, because a budget
-- band is the one thing a human node in the room has no business seeing.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/room_profiles.sql

begin;

select extensions.plan(10);

-- ---------------------------------------------------------------- fixtures

create temporary table pids (k text primary key, v uuid);
insert into pids (k, v) values
  ('owner', gen_random_uuid()),
  ('member', gen_random_uuid()),
  ('outsider', gen_random_uuid()),
  ('room', gen_random_uuid()),
  ('room2', gen_random_uuid());

create or replace function pg_temp.pid(text) returns uuid language sql stable as
  $$ select v from pids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.pid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '-profile@test.invalid', '', now(), now(), now()
  from (values ('owner'), ('member'), ('outsider')) as u(k);

insert into public.rooms (id, name, owner_id) values
  (pg_temp.pid('room'),  'Profile room', pg_temp.pid('owner')),
  (pg_temp.pid('room2'), 'Second room',  pg_temp.pid('owner'));

insert into public.room_members (room_id, user_id, role) values
  (pg_temp.pid('room'), pg_temp.pid('owner'),  'user'),
  (pg_temp.pid('room'), pg_temp.pid('member'), 'user');

insert into public.room_profiles (room_id, icp, offer, budget_band, updated_by)
values (pg_temp.pid('room'), 'solo founders', 'a course', '500_2k', pg_temp.pid('owner'));

-- As a client, not as postgres. `postgres` bypasses RLS, so running these as the
-- owner would prove nothing.
create or replace function pg_temp.profiles_as(p_user uuid) returns int
language plpgsql as $$
declare n int;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select count(*)::int into n from public.room_profiles;
  perform set_config('role', 'postgres', true);
  return n;
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $$;

-- `anon` holds no grant on any table here (`20260812120100`), so an
-- unauthenticated read is a permission error rather than zero rows, on every
-- table alike. Asserted as such so a later grant does not slip in unnoticed.
create or replace function pg_temp.profiles_as_anon() returns text
language plpgsql as $$
declare n int;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*)::int into n from public.room_profiles;
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

create or replace function pg_temp.write_as(p_user uuid, p_sql text) returns text
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- ---------------------------------------------------------------- reads

select extensions.is(pg_temp.profiles_as(pg_temp.pid('owner')), 1,
  'the owner reads their workspace profile');

select extensions.is(pg_temp.profiles_as(pg_temp.pid('member')), 0,
  'a member of the room who is not the owner reads nothing: the first owner-only policy here');

select extensions.is(pg_temp.profiles_as(pg_temp.pid('outsider')), 0,
  'an outsider reads nothing');

select extensions.is(pg_temp.profiles_as_anon(), '42501',
  'anon is refused outright, as on every table here: no grant, not merely no rows');

-- ---------------------------------------------------------------- writes

select extensions.is(
  pg_temp.write_as(pg_temp.pid('owner'),
    format($q$ insert into public.room_profiles (room_id, icp) values (%L, 'x') $q$, pg_temp.pid('room2'))),
  '42501',
  'even the owner cannot insert as a client: writes are the API''s');

select extensions.is(
  pg_temp.write_as(pg_temp.pid('owner'),
    format($q$ update public.room_profiles set icp = 'y' where room_id = %L $q$, pg_temp.pid('room'))),
  '42501',
  'even the owner cannot update as a client');

select extensions.is(
  pg_temp.write_as(pg_temp.pid('owner'),
    format($q$ delete from public.room_profiles where room_id = %L $q$, pg_temp.pid('room'))),
  '42501',
  'even the owner cannot delete as a client');

-- ---------------------------------------------------------------- helper and shape

select extensions.ok(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'is_room_owner'),
  'is_room_owner is security definer, so a policy can read rooms');

select extensions.is(
  (select pg_temp.write_as(pg_temp.pid('owner'), $q$ select 1 $q$)),
  null,
  'the write helper itself succeeds as a client, so the 42501s above are refusals and not a broken harness');

delete from public.rooms where id = pg_temp.pid('room');
select extensions.is(
  (select count(*) from public.room_profiles where room_id = pg_temp.pid('room')),
  0::bigint,
  'deleting the room deletes its profile');

select * from extensions.finish();

rollback;
