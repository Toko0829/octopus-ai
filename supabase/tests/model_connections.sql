-- The model connector tables: RLS, privileges, and the constraints that keep a
-- sealed key sealed. Covers 20260913120000 and 20260913121000.
--
-- Two postures in one suite, deliberately, because the pair is the decision.
--
-- `model_connections` holds a customer's paid API key as ciphertext and has **no
-- client policy and no client grant at all**, so the assertions about it are the
-- shape of an ERROR rather than a count: `42501`, insufficient_privilege, not
-- zero rows. The absence of the grant is the control. Zero rows is what a broken
-- policy looks like and an error is what a deliberate refusal looks like, and
-- this repository has already lost 47 tasks to those two being indistinguishable
-- through PostgREST (`20260827110000`). The owner of the very room is refused
-- too, which is what proves the refusal is not a policy that could be widened.
--
-- `model_routes` holds no secret and IS member-readable, so its assertions are
-- counts. What a client must never do here is WRITE: a client able to update a
-- route could point another member's voice at a provider the owner never
-- connected.
--
-- The fixture inserts a row that looks sealed, so the refusal below is a refusal
-- to read a row that is genuinely there rather than an empty table answering
-- honestly.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/model_connections.sql

begin;

select extensions.plan(22);

-- ---------------------------------------------------------------- fixtures

create temporary table kids (k text primary key, v uuid);
insert into kids (k, v) values
  ('owner',      gen_random_uuid()),
  ('member',     gen_random_uuid()),
  ('outsider',   gen_random_uuid()),
  ('room',       gen_random_uuid()),
  ('other_room', gen_random_uuid()),
  ('conn',       gen_random_uuid());

create or replace function pg_temp.kid(text) returns uuid language sql stable as
  $$ select v from kids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.kid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@models-test.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.kid('room'), 'Models room', pg_temp.kid('owner')),
       (pg_temp.kid('other_room'), 'Other room', pg_temp.kid('outsider'));

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.kid('room'), pg_temp.kid('owner'),  'user',       'room', null),
       (pg_temp.kid('room'), pg_temp.kid('member'), 'human_node', 'room', now() + interval '1 day'),
       (pg_temp.kid('other_room'), pg_temp.kid('outsider'), 'user', 'room', null);

-- A connection carrying a worthless but well-formed-looking seal, so every
-- refusal below is a refusal to read a row that exists.
insert into public.model_connections
  (id, room_id, connected_by, provider, key_ciphertext, key_iv, key_tag, key_hint)
values (pg_temp.kid('conn'), pg_temp.kid('room'), pg_temp.kid('owner'),
        'anthropic', 'bm90LWEtcmVhbC1jaXBoZXJ0ZXh0', 'bm90LWFuLWl2', 'bm90LWEtdGFn', '4f2a');

insert into public.model_routes (room_id, role, provider, model, updated_by)
values (pg_temp.kid('room'), 'strategist', 'anthropic', 'claude-opus-5', pg_temp.kid('owner'));

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.kcount_as(p_user uuid, p_sql text)
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

-- Helper: the SQLSTATE a statement raises as a given user, or null if it
-- succeeds. The code rather than a boolean, because "it threw something" would
-- also pass for a typo'd table name, which would make a refusal look enforced
-- when the test never reached it.
create or replace function pg_temp.kerrcode_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
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

-- Helper: the SQLSTATE a statement raises as `postgres`, for the constraints.
-- They must bind trusted server code too, so they are tested from the privileged
-- role on purpose: `apps/api` writes these rows as `service_role`, and a
-- constraint only RLS enforced would be no constraint at all here.
create or replace function pg_temp.kerrcode_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ------------------------------------------------------ model_connections
--
-- 1: the column exists at all, so the rest of this section is about a table
-- shaped the way the writer expects.

select extensions.has_column('public', 'model_connections', 'key_ciphertext',
  'model_connections carries the sealed key');

select extensions.is(
  pg_temp.kerrcode_as(pg_temp.kid('owner'),
    'select count(*) from public.model_connections'),
  '42501',
  'a client is REFUSED model_connections rather than shown zero rows, and the OWNER of '
  'the very room is refused too: the table holds a customer key and RLS filters rows, not columns'
);

select extensions.is(
  pg_temp.kerrcode_as(pg_temp.kid('outsider'),
    'select count(*) from public.model_connections'),
  '42501',
  'an outsider is refused the same way, so the refusal is not a policy that could be widened'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.model_connections', 'SELECT'),
  'authenticated holds no SELECT on model_connections'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.model_connections', 'SELECT'),
  'anon holds no SELECT on model_connections'
);

-- TRUNCATE explicitly: `grant all` includes it, it is not row-level, and it
-- ignores RLS entirely, so a role holding it can empty a table whatever the
-- policies say. That is the defect `20260812120100` closed for `anon` and it
-- arrives by a new door with every table.
select extensions.ok(
  not has_table_privilege('authenticated', 'public.model_connections', 'TRUNCATE'),
  'authenticated cannot TRUNCATE model_connections'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_connections (room_id, connected_by, provider, key_ciphertext, key_iv, key_tag, key_hint) '
    'values (' || quote_literal(pg_temp.kid('room')) || '::uuid, '
               || quote_literal(pg_temp.kid('owner')) || '::uuid, ''anthropic'', ''c2Vjb25k'', ''aXY='', ''dGFn'', ''9999'')'),
  '23505',
  'one key per provider per room: re-pasting updates the row rather than creating a rival, '
  'so "which key do we use" cannot have two answers'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_connections (room_id, connected_by, provider, key_ciphertext, key_iv, key_tag, key_hint, status) '
    'values (' || quote_literal(pg_temp.kid('room')) || '::uuid, '
               || quote_literal(pg_temp.kid('owner')) || '::uuid, ''openai'', ''Yw=='', ''aXY='', ''dGFn'', ''1234'', ''expired'')'),
  '23514',
  'there is no third status: an API key does not age out on a timer the way an OAuth token does'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_connections (room_id, connected_by, provider, key_hint) '
    'values (' || quote_literal(pg_temp.kid('room')) || '::uuid, '
               || quote_literal(pg_temp.kid('owner')) || '::uuid, ''google'', ''5678'')'),
  '23514',
  'an active row without a sealed key is refused: a hint with nothing behind it would fail '
  'four minutes into an agent run instead of at the write'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_connections (room_id, connected_by, provider, key_ciphertext, key_iv, key_tag, key_hint, status) '
    'values (' || quote_literal(pg_temp.kid('room')) || '::uuid, '
               || quote_literal(pg_temp.kid('owner')) || '::uuid, ''google'', ''Yw=='', ''aXY='', ''dGFn'', ''5678'', ''revoked'')'),
  '23514',
  'a revoked row may not keep its key: revoking is what destroys the credential and keeps the record'
);

-- ----------------------------------------------------------- model_routes
--
-- Counts here, not error codes, because this table holds no secret: the route is
-- the same fact the message chip already shows in the room.

select extensions.is(
  pg_temp.kcount_as(pg_temp.kid('owner'), 'select count(*) from public.model_routes'),
  1::bigint,
  'the owner reads their own routes'
);

select extensions.is(
  pg_temp.kcount_as(pg_temp.kid('member'), 'select count(*) from public.model_routes'),
  1::bigint,
  'a member reads them too: which model wrote a message is already visible on every message'
);

select extensions.is(
  pg_temp.kcount_as(pg_temp.kid('outsider'), 'select count(*) from public.model_routes'),
  0::bigint,
  'an outsider sees no routes'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.model_routes', 'SELECT'),
  'anon holds no grant at all: an unauthenticated read is refused rather than empty'
);

select extensions.is(
  pg_temp.kerrcode_as(pg_temp.kid('owner'),
    'insert into public.model_routes (room_id, role, provider, model) values ('
    || quote_literal(pg_temp.kid('room')) || '::uuid, ''ads'', ''openai'', ''gpt-5.4'')'),
  '42501',
  'even the owner cannot INSERT a route as a client: a route is set through the API after '
  'an ownership check, because a client that could write here could route another member''s voice'
);

select extensions.is(
  pg_temp.kerrcode_as(pg_temp.kid('owner'),
    'update public.model_routes set model = ''gpt-5.4'' where room_id = '
    || quote_literal(pg_temp.kid('room')) || '::uuid'),
  '42501',
  'and cannot UPDATE one'
);

select extensions.is(
  pg_temp.kerrcode_as(pg_temp.kid('owner'),
    'delete from public.model_routes where room_id = '
    || quote_literal(pg_temp.kid('room')) || '::uuid'),
  '42501',
  'and cannot DELETE one: clearing a role to Auto is an API call, not a client write'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_routes (room_id, role, provider, model) values ('
    || quote_literal(pg_temp.kid('room')) || '::uuid, ''writer'', ''openai'', ''gpt-5.4'')'),
  '23514',
  'the role vocabulary IS closed, unlike the model list: a role is a fact about this '
  'system''s own six jobs, and a typo''d one would silently never resolve'
);

select extensions.is(
  pg_temp.kerrcode_of(
    'insert into public.model_routes (room_id, role, provider, model) values ('
    || quote_literal(pg_temp.kid('room')) || '::uuid, ''ads'', ''openai'', '
    || quote_literal(repeat('m', 121)) || ')'),
  '23514',
  'a model id longer than 120 characters is refused, which is the only thing checked '
  'about it: vendors rename models and an unknown id still renders as itself'
);

-- ------------------------------------------------------------- cascades
--
-- Deleting a room takes both tables with it. The credential one matters most: a
-- deleted workspace must not leave a sealed customer key behind in a table
-- nothing reads any more.

select extensions.lives_ok(
  'delete from public.rooms where id = ' || quote_literal(pg_temp.kid('room')) || '::uuid',
  'the room can be deleted with a connection and a route attached'
);

select extensions.is(
  (select count(*) from public.model_connections where room_id = pg_temp.kid('room')),
  0::bigint,
  'deleting the room cascades the sealed key away with it'
);

select extensions.is(
  (select count(*) from public.model_routes where room_id = pg_temp.kid('room')),
  0::bigint,
  'and the routes with it'
);

select * from extensions.finish();
rollback;
