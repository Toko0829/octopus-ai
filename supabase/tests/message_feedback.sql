-- Message-label tests — covers 20260913124000, which gave `feedback_events` a
-- second subject so a prose answer can be rated.
--
-- The table has had exactly one subject since `20260812130000`, and every reader
-- of it assumes a card. This suite asserts the second subject works, that the
-- first one still does, and that widening the verdict vocabulary did not widen
-- who may write one.
--
-- Two halves, split as `message_persona.sql` and `message_model.sql` split them.
--
--   * The **constraint half** runs as `postgres`, because checks bind trusted
--     server code and the secret key is the only writer this table has.
--   * The **RLS half** runs as `authenticated` with `request.jwt.claims` set,
--     exactly as PostgREST would. Running it as `postgres` would prove nothing:
--     that role bypasses RLS entirely.
--
-- **Assertion 9 is the regression one and the reason the file is worth its
-- length.** `20260913124000` drops and recreates `feedback_events_verdict_check`,
-- and a recreated check is a retyped predicate: the two card verdicts this table
-- was built for are in the new list only because somebody typed them again. A
-- dropped one fails nothing until the next plan approval, in a path with its own
-- error handling that deliberately logs rather than raises, so the label would
-- simply stop being written and the flywheel would go quiet without a single
-- test going red.
--
-- **Assertion 8 pins a deletion, not a cascade.** `message_id` is
-- `on delete set null` rather than `cascade` on purpose: `subject` holds what was
-- actually judged, captured at decision time, so the label survives its subject
-- and stays readable. A cascade here would delete evidence whenever somebody
-- tidied a room.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/message_feedback.sql

begin;

select extensions.plan(9);

-- ---------------------------------------------------------------- fixtures

create temporary table mfids (k text primary key, v uuid);
insert into mfids (k, v) values
  ('owner',    gen_random_uuid()),
  ('outsider', gen_random_uuid()),
  ('room',     gen_random_uuid()),
  ('chan',     gen_random_uuid()),
  ('answer',   gen_random_uuid()),
  ('doomed',   gen_random_uuid()),
  ('card',     gen_random_uuid()),
  ('embed',    gen_random_uuid());

create or replace function pg_temp.mfid(text) returns uuid language sql stable as
  $$ select v from mfids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.mfid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@labels.invalid', '', now(), now(), now()
from (values ('owner'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.mfid('room'), 'Label test room', pg_temp.mfid('owner'));

insert into public.channels (id, room_id, name)
values (pg_temp.mfid('chan'), pg_temp.mfid('room'), 'brief');

-- Only the owner is a member. The outsider is a real user with no membership,
-- which is what makes the "reads 0" assertion a policy result rather than an
-- empty table.
insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
values (pg_temp.mfid('room'), pg_temp.mfid('owner'), 'user', 'room', null, null);

-- The subject: an ungrounded answer. Agent-authored, carrying a model, no card
-- attached, which is exactly the shape the route requires before it will accept a
-- label.
insert into public.messages (id, room_id, channel_id, author_kind, persona, model,
                             body, idempotency_key)
values (pg_temp.mfid('answer'), pg_temp.mfid('room'), pg_temp.mfid('chan'), 'agent',
        'strategist', 'claude-opus-5',
        'I do not have sources for this one, so what follows is general practice.',
        'mf-answer-1'),
       (pg_temp.mfid('doomed'), pg_temp.mfid('room'), pg_temp.mfid('chan'), 'agent',
        'strategist', 'gpt-5.4', 'This one gets deleted.', 'mf-doomed-1'),
       (pg_temp.mfid('card'), pg_temp.mfid('room'), pg_temp.mfid('chan'), 'agent',
        'strategist', 'gpt-5.4', 'Here is the plan.', 'mf-card-1');

insert into public.action_embeds (id, message_id, room_id, component, payload)
values (pg_temp.mfid('embed'), pg_temp.mfid('card'), pg_temp.mfid('room'), 'plan',
        '{"goal": "Grow the newsletter", "steps": []}'::jsonb);

-- Helper: the SQLSTATE a statement raises as `postgres`, or null if it succeeds.
create or replace function pg_temp.mferr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- Helper: the same, as a given user, exactly as PostgREST would run it. The role
-- is reset on both paths.
create or replace function pg_temp.mferr_as(p_user uuid, p_sql text)
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

-- Helper: how many rows a given user can see, as PostgREST would ask.
create or replace function pg_temp.mfcount_as(p_user uuid)
returns int language plpgsql as $$
declare n int;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  select count(*) into n from public.feedback_events;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

-- ------------------------------------------------- the column exists (1)

select extensions.has_column(
  'public', 'feedback_events', 'message_id',
  'a verdict can name a message, not only a card'
);

-- ------------------------------------------- the constraint half, as postgres (3)

select extensions.is(
  pg_temp.mferr(format(
    'insert into public.feedback_events (room_id, message_id, actor_id, verdict, note, subject) '
    'values (%L, %L, %L, ''helpful'', ''Gave me somewhere to start.'', '
    '''{"body": "general practice", "model": "claude-opus-5"}''::jsonb)',
    pg_temp.mfid('room'), pg_temp.mfid('answer'), pg_temp.mfid('owner'))),
  null::text,
  'the owner can label a prose answer helpful, which is the whole point: the one '
  'tier whose quality rests on the model had no way to be judged'
);

select extensions.is(
  pg_temp.mferr(format(
    'insert into public.feedback_events (room_id, message_id, actor_id, verdict, subject) '
    'values (%L, %L, %L, ''meh'', ''{}''::jsonb)',
    pg_temp.mfid('room'), pg_temp.mfid('answer'), pg_temp.mfid('owner'))),
  '23514',
  'and a verdict outside the four is refused: the vocabulary was widened by two, '
  'not opened'
);

select extensions.is(
  pg_temp.mferr(format(
    'insert into public.feedback_events (room_id, embed_id, actor_id, verdict, subject) '
    'values (%L, %L, %L, ''approved'', ''{"goal": "Grow the newsletter"}''::jsonb)',
    pg_temp.mfid('room'), pg_temp.mfid('embed'), pg_temp.mfid('owner'))),
  null::text,
  'a card verdict still validates: the check was dropped and retyped, and the two '
  'values this table was built for are in the new list only because somebody typed '
  'them again'
);

-- ------------------------------------------------ the RLS half, as a client (4)

select extensions.is(
  pg_temp.mfcount_as(pg_temp.mfid('owner')),
  2,
  'a member reads the labels written in their own room'
);

select extensions.is(
  pg_temp.mfcount_as(pg_temp.mfid('outsider')),
  0,
  'and a non-member reads none of them, because feedback_events_select_member is '
  'the only permissive policy on the table'
);

select extensions.is(
  pg_temp.mferr_as(pg_temp.mfid('owner'), format(
    'insert into public.feedback_events (room_id, message_id, actor_id, verdict, subject) '
    'values (%L, %L, %L, ''helpful'', ''{}''::jsonb)',
    pg_temp.mfid('room'), pg_temp.mfid('answer'), pg_temp.mfid('owner'))),
  '42501',
  'but even the owner cannot write one directly: the label is the server''s record '
  'of a decision it saw, and a client that could file its own could file one under '
  'somebody else''s name'
);

select extensions.is(
  pg_temp.mferr_as(pg_temp.mfid('owner'), format(
    'update public.feedback_events set verdict = ''not_helpful'' where room_id = %L',
    pg_temp.mfid('room'))),
  '42501',
  'and cannot rewrite one after the fact: a changed mind is a second row, which is '
  'what append-only buys on a table whose whole content is evidence'
);

-- --------------------------------------- the label outlives its subject (1)

-- `on delete set null` rather than `cascade`. Asserted by deleting the message
-- and counting what is left, because the difference between the two is invisible
-- until somebody tidies a room and finds the flywheel shorter than it was.
insert into public.feedback_events (room_id, message_id, actor_id, verdict, subject)
values (pg_temp.mfid('room'), pg_temp.mfid('doomed'), pg_temp.mfid('owner'), 'not_helpful',
        '{"body": "This one gets deleted.", "model": "gpt-5.4"}'::jsonb);

delete from public.messages where id = pg_temp.mfid('doomed');

select extensions.is(
  (select count(*)::int from public.feedback_events
    where message_id is null
      and subject ->> 'model' = 'gpt-5.4'
      and verdict = 'not_helpful'),
  1,
  'deleting the message leaves its label behind with a null subject id: `subject` '
  'holds what was actually judged, so the row is still readable evidence'
);

select * from extensions.finish();
rollback;
