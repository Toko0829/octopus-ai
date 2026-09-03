-- Agent persona tests — covers 20260912120000, which named the four agent voices.
--
-- The column carries a label, not a capability, so the interesting assertions are
-- the ones about what it CANNOT do: a value nobody defined, a persona on a row
-- that is not the agent's, and a client naming one for itself. That last is the
-- same guarantee `author_kind` has had since `20260904127000`, and it is here for
-- the same reason: a message filed under a specialist's name in somebody's audit
-- trail is a forgery whether or not any money moved.
--
-- Two halves, split as `thread_scope.sql` splits them.
--
--   * The **constraint half** runs as `postgres` on purpose. Checks bind trusted
--     server code, and the secret key is the only writer that will ever set this
--     column. A guard that only refused clients would refuse nobody who was ever
--     going to write it.
--   * The **RLS half** runs as `authenticated` with `request.jwt.claims` set,
--     exactly as PostgREST would. Running it as `postgres` would prove nothing:
--     that role bypasses RLS entirely.
--
-- **The regression assertions are the point of the file.** `20260912120000` adds
-- one conjunct to `messages_insert_own`, and `alter policy ... with check`
-- REPLACES the expression rather than appending to it, so the whole predicate is
-- retyped in that migration. A conjunct dropped in the retyping would not fail
-- anything here unless somebody asserted the capabilities it protects, and every
-- such failure reads as "the chat stopped working" rather than as a security
-- change. Assertions 7 and 8 are those: a room-scoped member can still post to
-- the room stream, and a thread-scoped node can still post into their own thread.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/message_persona.sql

begin;

select extensions.plan(10);

-- ---------------------------------------------------------------- fixtures

create temporary table mpids (k text primary key, v uuid);
insert into mpids (k, v) values
  ('owner',  gen_random_uuid()),
  ('node',   gen_random_uuid()),
  ('room',   gen_random_uuid()),
  ('chan',   gen_random_uuid()),
  ('project',gen_random_uuid()),
  ('task',   gen_random_uuid()),
  ('thread', gen_random_uuid());

create or replace function pg_temp.mpid(text) returns uuid language sql stable as
  $$ select v from mpids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.mpid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@personas.invalid', '', now(), now(), now()
from (values ('owner'), ('node')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.mpid('room'), 'Persona test room', pg_temp.mpid('owner'));

insert into public.channels (id, room_id, name)
values (pg_temp.mpid('chan'), pg_temp.mpid('room'), 'brief');

insert into public.projects (id, owner_id, goal)
values (pg_temp.mpid('project'), pg_temp.mpid('owner'), 'Grow the newsletter');
update public.rooms set project_id = pg_temp.mpid('project') where id = pg_temp.mpid('room');

insert into public.tasks (id, project_id, title, owner_type)
values (pg_temp.mpid('task'), pg_temp.mpid('project'), 'Shoot the launch video', 'human');

insert into public.threads (id, room_id, channel_id, task_id, title)
values (pg_temp.mpid('thread'), pg_temp.mpid('room'), pg_temp.mpid('chan'),
        pg_temp.mpid('task'), 'Launch video shoot');

-- The owner is room-scoped; the node is admitted to one thread, which is the
-- only shape that may author as `'node'`.
insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
values (pg_temp.mpid('room'), pg_temp.mpid('owner'), 'user',       'room',   null, null),
       (pg_temp.mpid('room'), pg_temp.mpid('node'),  'human_node', 'thread',
        pg_temp.mpid('thread'), now() + interval '1 day');

-- Helper: the SQLSTATE a statement raises as `postgres`, or null if it succeeds.
-- The code rather than a boolean, so a typo'd column name cannot pass as an
-- enforced refusal.
create or replace function pg_temp.mperr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Helper: the same, as a given user, exactly as PostgREST would run it. The role
-- is reset on both paths.
create or replace function pg_temp.mperr_as(p_user uuid, p_sql text)
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

-- ------------------------------------------------- the column exists (1)

select extensions.has_column(
  'public', 'messages', 'persona',
  'messages carries the agent voice that wrote it'
);

-- ------------------------------------------- the constraint half, as postgres (5)

select extensions.is(
  pg_temp.mperr(format(
    'insert into public.messages (room_id, author_kind, persona, body, idempotency_key) '
    'values (%L, ''agent'', ''ads'', ''Your campaign is live.'', ''mp-ads-1'')',
    pg_temp.mpid('room'))),
  null::text,
  'a known persona on an agent row is accepted'
);

select extensions.is(
  pg_temp.mperr(format(
    'insert into public.messages (room_id, author_kind, persona, body, idempotency_key) '
    'values (%L, ''agent'', ''octopus'', ''Anything.'', ''mp-unknown-1'')',
    pg_temp.mpid('room'))),
  '23514',
  'a persona nobody defined is refused: the set is closed, and closing it here is '
  'what lets the client trust the four names it renders'
);

select extensions.is(
  pg_temp.mperr(format(
    'insert into public.messages (room_id, author_kind, persona, body, idempotency_key) '
    'values (%L, ''system'', ''ads'', ''An expert accepted the step.'', ''mp-system-1'')',
    pg_temp.mpid('room'))),
  '23514',
  'a system notice cannot wear a persona: system says what a person or the platform '
  'did, and a specialist''s name on one would claim the AI did it'
);

select extensions.is(
  pg_temp.mperr(format(
    'insert into public.messages (room_id, author_id, author_kind, persona, body, '
    'idempotency_key) values (%L, %L, ''user'', ''ads'', ''Not me.'', ''mp-user-1'')',
    pg_temp.mpid('room'), pg_temp.mpid('owner'))),
  '23514',
  'and neither can a person''s message, even written by trusted server code'
);

select extensions.is(
  pg_temp.mperr(format(
    'insert into public.messages (room_id, author_kind, body, idempotency_key) '
    'values (%L, ''agent'', ''Working on a plan.'', ''mp-legacy-1'')',
    pg_temp.mpid('room'))),
  null::text,
  'an agent row with no persona is still valid, which is why no backfill was '
  'needed: every message written before this column keeps rendering'
);

-- ------------------------------------------------ the RLS half, as a client (3)

select extensions.is(
  pg_temp.mperr_as(pg_temp.mpid('owner'), format(
    'insert into public.messages (room_id, channel_id, author_id, author_kind, body, '
    'idempotency_key) values (%L, %L, %L, ''user'', ''What is our launch plan?'', ''mp-own-1'')',
    pg_temp.mpid('room'), pg_temp.mpid('chan'), pg_temp.mpid('owner'))),
  null::text,
  'a room-scoped member can still post to the room stream: the restated predicate '
  'did not mute anybody'
);

select extensions.is(
  pg_temp.mperr_as(pg_temp.mpid('node'), format(
    'insert into public.messages (room_id, channel_id, thread_id, author_id, author_kind, '
    'body, idempotency_key) values (%L, %L, %L, %L, ''node'', ''On my way.'', ''mp-node-1'')',
    pg_temp.mpid('room'), pg_temp.mpid('chan'), pg_temp.mpid('thread'), pg_temp.mpid('node'))),
  null::text,
  'and a thread-scoped node can still author as a node inside their own thread'
);

select extensions.is(
  pg_temp.mperr_as(pg_temp.mpid('owner'), format(
    'insert into public.messages (room_id, channel_id, author_id, author_kind, persona, '
    'body, idempotency_key) values (%L, %L, %L, ''user'', ''strategist'', ''Trust me.'', '
    '''mp-forge-1'')',
    pg_temp.mpid('room'), pg_temp.mpid('chan'), pg_temp.mpid('owner'))),
  '42501',
  'but a client naming its own persona is refused by RLS, not merely ignored by '
  'the route'
);

-- --------------------------------------------- the broadcast carries it (1)

-- The trigger sends the whole `new` record, so a new column needs no trigger
-- change — but "needs no change" is a claim about a function nobody re-read, and
-- the client reads `persona` off the broadcast rather than off a fetch. Asserted
-- against the row `realtime.send` writes inside this same transaction.
select extensions.is(
  (select payload -> 'record' ->> 'persona'
     from realtime.messages
    where topic = 'chat:room:' || pg_temp.mpid('room')::text
      and extension = 'broadcast'
      and payload -> 'record' ->> 'idempotency_key' = 'mp-ads-1'
    order by inserted_at desc
    limit 1),
  'ads',
  'the realtime broadcast carries the persona, so the stream can name the voice '
  'without a second fetch'
);

select * from extensions.finish();
rollback;
