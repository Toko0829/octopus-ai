-- Model attribution tests — covers 20260913122000, which recorded which model
-- wrote an agent message and which one produced a task run.
--
-- The column carries an attribution, not a capability, so the interesting
-- assertions are again about what it CANNOT do: a model on a row no model wrote,
-- an id longer than anything a vendor ships, and a client naming one for itself.
-- That last is the same guarantee `author_kind` has had since `20260904127000`
-- and `persona` since `20260912120000`, and it is here for a sharper reason: a
-- message stamped with a model that never saw it is a forgery that reads exactly
-- like a record, and the whole point of the column is that somebody can trust it.
--
-- **What is deliberately not asserted.** There is no closed vocabulary, so no
-- assertion refuses an unknown id: `messages_model_length` is the only check on
-- the value, and a test that pinned a list here would be a test pinning a
-- decision the migration explicitly declined to take.
--
-- Two halves, split as `message_persona.sql` splits them.
--
--   * The **constraint half** runs as `postgres`, because checks bind trusted
--     server code and the secret key is the only writer that will ever set this
--     column.
--   * The **RLS half** runs as `authenticated` with `request.jwt.claims` set,
--     exactly as PostgREST would. Running it as `postgres` would prove nothing:
--     that role bypasses RLS entirely.
--
-- **The regression assertions are the point of the file**, for the reason
-- `message_persona.sql` states: `20260913122000` adds one conjunct to
-- `messages_insert_own`, `alter policy ... with check` REPLACES the expression
-- rather than appending to it, and a conjunct dropped in the retyping fails
-- nothing unless somebody asserts the capability it protects. Assertions 7 and 8
-- are those.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/message_model.sql

begin;

select extensions.plan(12);

-- ---------------------------------------------------------------- fixtures

create temporary table mmids (k text primary key, v uuid);
insert into mmids (k, v) values
  ('owner',  gen_random_uuid()),
  ('node',   gen_random_uuid()),
  ('room',   gen_random_uuid()),
  ('chan',   gen_random_uuid()),
  ('project',gen_random_uuid()),
  ('task',   gen_random_uuid()),
  ('thread', gen_random_uuid());

create or replace function pg_temp.mmid(text) returns uuid language sql stable as
  $$ select v from mmids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.mmid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@models.invalid', '', now(), now(), now()
from (values ('owner'), ('node')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.mmid('room'), 'Model test room', pg_temp.mmid('owner'));

insert into public.channels (id, room_id, name)
values (pg_temp.mmid('chan'), pg_temp.mmid('room'), 'brief');

insert into public.projects (id, owner_id, goal)
values (pg_temp.mmid('project'), pg_temp.mmid('owner'), 'Grow the newsletter');
update public.rooms set project_id = pg_temp.mmid('project') where id = pg_temp.mmid('room');

insert into public.tasks (id, project_id, title, owner_type)
values (pg_temp.mmid('task'), pg_temp.mmid('project'), 'Write the launch page', 'ai');

insert into public.threads (id, room_id, channel_id, task_id, title)
values (pg_temp.mmid('thread'), pg_temp.mmid('room'), pg_temp.mmid('chan'),
        pg_temp.mmid('task'), 'Launch page');

-- The owner is room-scoped; the node is admitted to one thread, which is the
-- only shape that may author as `'node'`.
insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
values (pg_temp.mmid('room'), pg_temp.mmid('owner'), 'user',       'room',   null, null),
       (pg_temp.mmid('room'), pg_temp.mmid('node'),  'human_node', 'thread',
        pg_temp.mmid('thread'), now() + interval '1 day');

-- Helper: the SQLSTATE a statement raises as `postgres`, or null if it succeeds.
-- The code rather than a boolean, so a typo'd column name cannot pass as an
-- enforced refusal.
create or replace function pg_temp.mmerr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Helper: the same, as a given user, exactly as PostgREST would run it. The role
-- is reset on both paths.
create or replace function pg_temp.mmerr_as(p_user uuid, p_sql text)
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
  'public', 'messages', 'model',
  'messages carries the model that wrote it'
);

-- ------------------------------------------- the constraint half, as postgres (5)

select extensions.is(
  pg_temp.mmerr(format(
    'insert into public.messages (room_id, author_kind, persona, model, body, idempotency_key) '
    'values (%L, ''agent'', ''strategist'', ''claude-sonnet-5'', ''Here is the plan.'', ''mm-plan-1'')',
    pg_temp.mmid('room'))),
  null::text,
  'an agent row records the model that wrote it'
);

select extensions.is(
  pg_temp.mmerr(format(
    'insert into public.messages (room_id, author_kind, model, body, idempotency_key) '
    'values (%L, ''system'', ''claude-sonnet-5'', ''An expert accepted the step.'', ''mm-system-1'')',
    pg_temp.mmid('room'))),
  '23514',
  'a system notice cannot claim a model: system says what a person or the platform '
  'did, and no model wrote any of it'
);

select extensions.is(
  pg_temp.mmerr(format(
    'insert into public.messages (room_id, author_id, author_kind, model, body, '
    'idempotency_key) values (%L, %L, ''user'', ''gpt-5.4'', ''Not me.'', ''mm-user-1'')',
    pg_temp.mmid('room'), pg_temp.mmid('owner'))),
  '23514',
  'and neither can a person''s message, even written by trusted server code'
);

select extensions.is(
  pg_temp.mmerr(format(
    'insert into public.messages (room_id, author_kind, model, body, idempotency_key) '
    'values (%L, ''agent'', %L, ''Long.'', ''mm-long-1'')',
    pg_temp.mmid('room'), repeat('m', 121))),
  '23514',
  'an id longer than any vendor ships is refused: the set is open, the length is not, '
  'and this is the bound that keeps an unbounded string out of a chat bubble'
);

select extensions.is(
  pg_temp.mmerr(format(
    'insert into public.messages (room_id, author_kind, persona, body, idempotency_key) '
    'values (%L, ''agent'', ''strategist'', ''Working on a plan.'', ''mm-notice-1'')',
    pg_temp.mmid('room'))),
  null::text,
  'an agent row with no model is still valid, which is both why no backfill was needed '
  'and how apps/api writes its own notices: only text a model wrote carries one'
);

-- ------------------------------------------------ the RLS half, as a client (3)

select extensions.is(
  pg_temp.mmerr_as(pg_temp.mmid('owner'), format(
    'insert into public.messages (room_id, channel_id, author_id, author_kind, body, '
    'idempotency_key) values (%L, %L, %L, ''user'', ''What is our launch plan?'', ''mm-own-1'')',
    pg_temp.mmid('room'), pg_temp.mmid('chan'), pg_temp.mmid('owner'))),
  null::text,
  'a room-scoped member can still post to the room stream: the restated predicate '
  'did not mute anybody'
);

select extensions.is(
  pg_temp.mmerr_as(pg_temp.mmid('node'), format(
    'insert into public.messages (room_id, channel_id, thread_id, author_id, author_kind, '
    'body, idempotency_key) values (%L, %L, %L, %L, ''node'', ''On my way.'', ''mm-node-1'')',
    pg_temp.mmid('room'), pg_temp.mmid('chan'), pg_temp.mmid('thread'), pg_temp.mmid('node'))),
  null::text,
  'and a thread-scoped node can still author as a node inside their own thread'
);

select extensions.is(
  pg_temp.mmerr_as(pg_temp.mmid('owner'), format(
    'insert into public.messages (room_id, channel_id, author_id, author_kind, model, '
    'body, idempotency_key) values (%L, %L, %L, ''user'', ''claude-opus-5'', ''Trust me.'', '
    '''mm-forge-1'')',
    pg_temp.mmid('room'), pg_temp.mmid('chan'), pg_temp.mmid('owner'))),
  '42501',
  'but a client stamping its own model is refused by RLS, not merely ignored by the '
  'route: a fabricated attribution beside a real audit trail reads exactly like a record'
);

-- --------------------------------------------- the broadcast carries it (1)

-- The trigger sends the whole `new` record, so a new column needs no trigger
-- change — but "needs no change" is a claim about a function nobody re-read, and
-- the client reads the model off the broadcast rather than off a fetch. Asserted
-- against the row `realtime.send` writes inside this same transaction.
select extensions.is(
  (select payload -> 'record' ->> 'model'
     from realtime.messages
    where topic = 'chat:room:' || pg_temp.mmid('room')::text
      and extension = 'broadcast'
      and payload -> 'record' ->> 'idempotency_key' = 'mm-plan-1'
    order by inserted_at desc
    limit 1),
  'claude-sonnet-5',
  'the realtime broadcast carries the model, so the stream can name it without a '
  'second fetch'
);

-- ------------------------------------------------ the executor's arm (2)

-- Columns only. `task_runs` has no client policy and no client grant, so there is
-- no authorisation question to ask of it here: the assertion that matters is that
-- the columns `finishRun` writes actually exist, which is the failure a route
-- test with a stubbed client cannot catch.
select extensions.has_column(
  'public', 'task_runs', 'provider',
  'task_runs records which provider answered an attempt'
);

select extensions.has_column(
  'public', 'task_runs', 'model',
  'task_runs records which model answered it, so a re-delivered artifact can be '
  'attributed to the run that produced it'
);

select * from extensions.finish();
rollback;
