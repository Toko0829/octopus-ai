-- The artifacts bucket: who can see an object, and who cannot write one.
-- Covers 20260829124000_artifact_storage_bucket.sql.
--
-- Same split as every other suite here. The visibility half runs **as
-- `authenticated` with `request.jwt.claims` set**, exactly as the Storage service
-- would, because `postgres` bypasses RLS and testing there would prove nothing.
--
-- The assertion worth reading twice is the malformed path. The policy resolves a
-- tenant out of the first path segment, and an inline `::uuid` cast would raise
-- `invalid_text_representation` on any object whose first segment is not a UUID.
-- Postgres does not promise to evaluate the `bucket_id` test first, so a single
-- stray object could turn every member's listing into an error rather than into a
-- shorter list. `private.artifact_object_project` returns null instead, and null
-- makes the object invisible, which is the direction this should fail in.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/storage_artifacts.sql

begin;

select extensions.plan(11);

-- ---------------------------------------------------------------- fixtures

create temporary table sids (k text primary key, v uuid);
insert into sids (k, v) values
  ('owner',         gen_random_uuid()),
  ('member',        gen_random_uuid()),
  ('expired',       gen_random_uuid()),
  ('outsider',      gen_random_uuid()),
  ('project',       gen_random_uuid()),
  ('other_project', gen_random_uuid()),
  ('room',          gen_random_uuid()),
  ('other_room',    gen_random_uuid()),
  ('task',          gen_random_uuid()),
  ('artifact',      gen_random_uuid()),
  ('obj',           gen_random_uuid()),
  ('other_obj',     gen_random_uuid()),
  ('junk_obj',      gen_random_uuid());

create or replace function pg_temp.sid(text) returns uuid language sql stable as
  $$ select v from sids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.sid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@storage-test.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('expired'), ('outsider')) as t(k);

insert into public.projects (id, owner_id, goal, status)
values (pg_temp.sid('project'), pg_temp.sid('owner'), 'launch', 'active'),
       (pg_temp.sid('other_project'), pg_temp.sid('outsider'), 'not ours', 'active');

insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.sid('room'), 'Storage room', pg_temp.sid('owner'), pg_temp.sid('project')),
       (pg_temp.sid('other_room'), 'Other room', pg_temp.sid('outsider'), pg_temp.sid('other_project'));

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.sid('room'), pg_temp.sid('owner'),   'user',       'room', null),
       (pg_temp.sid('room'), pg_temp.sid('member'),  'human_node', 'room', now() + interval '1 day'),
       (pg_temp.sid('room'), pg_temp.sid('expired'), 'human_node', 'room', now() - interval '1 hour'),
       (pg_temp.sid('other_room'), pg_temp.sid('outsider'), 'user', 'room', null);

-- Three objects in the bucket: ours, another tenant's, and one whose first path
-- segment is not a UUID at all.
insert into storage.objects (id, bucket_id, name, metadata)
values (pg_temp.sid('obj'), 'artifacts',
        pg_temp.sid('project') || '/' || pg_temp.sid('artifact') || '/brief.pdf',
        '{"mimetype":"application/pdf","size":1024}'),
       (pg_temp.sid('other_obj'), 'artifacts',
        pg_temp.sid('other_project') || '/' || gen_random_uuid() || '/theirs.pdf',
        '{"mimetype":"application/pdf","size":1024}'),
       (pg_temp.sid('junk_obj'), 'artifacts', 'not-a-uuid/stray.pdf',
        '{"mimetype":"application/pdf","size":1}');

create or replace function pg_temp.scount_as(p_user uuid, p_sql text)
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

create or replace function pg_temp.serrcode_as(p_user uuid, p_role text, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', p_role)::text, true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

create or replace function pg_temp.scount_as_anon(p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute p_sql into n;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

-- ---------------------------------------------------------------- the bucket

select extensions.is(
  (select public from storage.buckets where id = 'artifacts'),
  false,
  'the artifacts bucket is private: every read goes through a signed URL a route minted'
);

-- ------------------------------------------------------------- who sees what

select extensions.is(
  pg_temp.scount_as(pg_temp.sid('owner'),
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  1::bigint,
  'the owner sees their project''s file and neither of the other two'
);

select extensions.is(
  pg_temp.scount_as(pg_temp.sid('member'),
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  1::bigint,
  'an unexpired node sees the file of the project it is engaged on'
);

select extensions.is(
  pg_temp.scount_as(pg_temp.sid('expired'),
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  0::bigint,
  'an EXPIRED node sees no file: time-boxed access expires for deliverables too'
);

select extensions.is(
  pg_temp.scount_as(pg_temp.sid('outsider'),
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  1::bigint,
  'an outsider sees only their own project''s file, never ours'
);

select extensions.is(
  pg_temp.scount_as_anon(
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  0::bigint,
  'anon sees nothing: the policy is granted to authenticated only'
);

-- ------------------------------------------------------- the malformed path

select extensions.is(
  pg_temp.serrcode_as(pg_temp.sid('owner'), 'authenticated',
    'select count(*) from storage.objects where bucket_id = ''artifacts'''),
  null::text,
  'an object whose first segment is not a UUID does not error the listing: it is '
  'resolved to null and is therefore invisible, rather than raising on the cast'
);

select extensions.ok(
  private.artifact_object_project('not-a-uuid/stray.pdf') is null,
  'a path that names no tenant resolves to null, which is nobody'
);

-- ------------------------------------------------------------- no client write
--
-- Server-written, like every artifact row. A client that could write here could
-- fabricate the evidence its own task is judged on, and do it without the
-- `artifacts` row that makes the file discoverable at all.

select extensions.is(
  pg_temp.serrcode_as(pg_temp.sid('owner'), 'authenticated', format(
    'insert into storage.objects (bucket_id, name) values (''artifacts'', %L)',
    pg_temp.sid('project') || '/forged/proof.pdf')),
  '42501',
  'a member cannot INSERT an object, even inside their own project folder'
);

-- UPDATE and DELETE with no matching policy affect zero rows rather than raising,
-- so the assertion has to be that the row survived. Checking only for an error
-- would pass against a policy that silently deleted nothing today and something
-- tomorrow.
select pg_temp.serrcode_as(pg_temp.sid('owner'), 'authenticated', format(
  'delete from storage.objects where id = %L', pg_temp.sid('obj')));

select extensions.is(
  (select count(*) from storage.objects where id = pg_temp.sid('obj')),
  1::bigint,
  'a member cannot DELETE the object they can read'
);

select pg_temp.serrcode_as(pg_temp.sid('owner'), 'authenticated', format(
  'update storage.objects set name = ''moved.pdf'' where id = %L', pg_temp.sid('obj')));

select extensions.is(
  (select count(*) from storage.objects
    where id = pg_temp.sid('obj') and name like pg_temp.sid('project') || '%'),
  1::bigint,
  'a member cannot move the object out of its tenant folder'
);

select * from extensions.finish();

rollback;
