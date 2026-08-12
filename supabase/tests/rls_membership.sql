-- RLS membership tests (AGENTS.md rule 18).
--
-- security-compliance.md calls dynamic group-chat membership "the hardest
-- membership surface": a user, the AI, and several time-boxed nodes sharing one
-- room with different privileges. Until now it had zero test coverage, which
-- meant the only evidence that RLS worked was that nothing had visibly leaked.
--
-- Everything runs inside a transaction that ROLLBACKs, so the fixtures below
-- never persist. Safe to run against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/rls_membership.sql
--
-- The pattern for testing RLS is to become the role PostgREST would use and
-- supply the JWT claims GoTrue would have issued, because `auth.uid()` reads
-- those claims. Testing as `postgres` proves nothing: it bypasses RLS entirely,
-- which is exactly how a policy bug survives review.
--
-- `plan()` must be called before the first assertion; pgTAP aborts with "You
-- tried to run a test without a plan" otherwise.
--
-- Verified green against the live database: 22/22, including the case that
-- matters most, an expired node seeing nothing at all.

begin;

select extensions.plan(22);

-- ---------------------------------------------------------------- fixtures

create temporary table ids (k text primary key, v uuid);
insert into ids (k, v) values
  ('owner',      gen_random_uuid()),
  ('member',     gen_random_uuid()),
  ('expired',    gen_random_uuid()),
  ('outsider',   gen_random_uuid()),
  ('room',       gen_random_uuid()),
  ('other_room', gen_random_uuid());

create or replace function pg_temp.id(text) returns uuid language sql stable as
  $$ select v from ids where k = $1 $$;

-- auth.users rows are required by the foreign keys.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.id(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@test.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('expired'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.id('room'), 'Test room', pg_temp.id('owner')),
       (pg_temp.id('other_room'), 'Someone else''s room', pg_temp.id('outsider'));

-- Three kinds of membership, which is the point of the exercise:
--   * the owner, unbounded
--   * a node whose access has not expired
--   * a node whose access HAS expired, which must behave exactly like a stranger
insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.id('room'), pg_temp.id('owner'),   'user',       'room', null),
       (pg_temp.id('room'), pg_temp.id('member'),  'human_node', 'room', now() + interval '1 day'),
       (pg_temp.id('room'), pg_temp.id('expired'), 'human_node', 'room', now() - interval '1 hour');

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.id('other_room'), pg_temp.id('outsider'), 'user', 'room', null);

insert into public.messages (id, room_id, author_id, author_kind, body, idempotency_key)
values (gen_random_uuid(), pg_temp.id('room'), pg_temp.id('owner'), 'user', 'hello', 'test-msg-1');

insert into public.messages (id, room_id, author_id, author_kind, body, idempotency_key)
values (gen_random_uuid(), pg_temp.id('other_room'), pg_temp.id('outsider'), 'user',
        'private', 'test-msg-2');

insert into public.action_embeds (message_id, room_id, component, payload, required_role)
select id, pg_temp.id('room'), 'plan',
       '{"title":"t","summary":"s","stages":[],"citations":[]}'::jsonb, 'owner'
from public.messages where idempotency_key = 'test-msg-1';

insert into public.feedback_events (room_id, actor_id, verdict, subject)
values (pg_temp.id('room'), pg_temp.id('owner'), 'approved', '{"title":"t"}'::jsonb);

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.count_as(p_user uuid, p_sql text)
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

-- ------------------------------------------------------------------- rooms

select extensions.is(
  pg_temp.count_as(pg_temp.id('owner'), 'select count(*) from public.rooms'),
  1::bigint,
  'owner sees exactly their own room'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('member'), 'select count(*) from public.rooms'),
  1::bigint,
  'an unexpired node sees the room it is engaged on'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('expired'), 'select count(*) from public.rooms'),
  0::bigint,
  'an EXPIRED node sees no room at all: time-boxed access actually expires'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('outsider'), 'select count(*) from public.rooms'),
  1::bigint,
  'an outsider sees only their own room, never ours'
);

-- ---------------------------------------------------------------- messages

select extensions.is(
  pg_temp.count_as(pg_temp.id('owner'), 'select count(*) from public.messages'),
  1::bigint,
  'owner reads their room''s messages and nobody else''s'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('member'), 'select count(*) from public.messages'),
  1::bigint,
  'an unexpired node reads the room''s messages'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('expired'), 'select count(*) from public.messages'),
  0::bigint,
  'an expired node reads nothing: the message history does not outlive the access'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('outsider'), 'select count(*) from public.messages'),
  1::bigint,
  'an outsider reads only their own room''s messages'
);

-- ----------------------------------------------------------- action_embeds

select extensions.is(
  pg_temp.count_as(pg_temp.id('owner'), 'select count(*) from public.action_embeds'),
  1::bigint,
  'owner sees the plan card in their room'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('expired'), 'select count(*) from public.action_embeds'),
  0::bigint,
  'an expired node cannot see the plan card'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('outsider'), 'select count(*) from public.action_embeds'),
  0::bigint,
  'an outsider cannot see another room''s plan card'
);

-- --------------------------------------------------------- feedback_events

select extensions.is(
  pg_temp.count_as(pg_temp.id('owner'), 'select count(*) from public.feedback_events'),
  1::bigint,
  'owner sees the flywheel labels for their own room'
);

select extensions.is(
  pg_temp.count_as(pg_temp.id('outsider'), 'select count(*) from public.feedback_events'),
  0::bigint,
  'an outsider cannot read another room''s flywheel labels'
);

-- ------------------------------------------------------- privileges (not RLS)
--
-- RLS filters rows a grant already permits. These assert the grants themselves,
-- because a missing policy and a missing grant fail very differently and the
-- project has been bitten by both.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.action_embeds', 'INSERT'),
  'authenticated cannot INSERT an embed: a client could otherwise fabricate an approval card'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.action_embeds', 'UPDATE'),
  'authenticated cannot UPDATE an embed: approving is a server-checked action, not a write'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.feedback_events', 'UPDATE'),
  'feedback_events is append-only: a rewritable training signal is not evidence'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.feedback_events', 'DELETE'),
  'feedback_events cannot be deleted by a client'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.messages', 'UPDATE'),
  'authenticated cannot rewrite the audit trail'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.messages', 'DELETE'),
  'authenticated cannot delete messages'
);

-- TRUNCATE bypasses RLS entirely, so holding it defeats every policy above.
-- Closed in 20260812120100; asserted here so it cannot silently return.
select extensions.ok(
  not has_table_privilege('authenticated', 'public.messages', 'TRUNCATE'),
  'authenticated cannot TRUNCATE messages: TRUNCATE ignores RLS'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.messages', 'SELECT'),
  'anon has no read access to chat'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.messages', 'TRUNCATE'),
  'anon cannot TRUNCATE messages'
);

select * from extensions.finish();

rollback;
