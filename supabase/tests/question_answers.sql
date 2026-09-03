-- question_answers: an answer on a question card is one statement.
-- Covers 20260910120000_answer_question_slot.sql.
--
-- The assertions worth reading first are the two about a closed card. Answers
-- used to arrive as chat messages that a run consumed with a conditional update;
-- now they arrive as embed actions, and the property that made the old path safe
-- (two writers racing on one card cannot both win) has to hold on the new one.
-- Both functions therefore return null, rather than writing, on any card that is
-- not pending.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/question_answers.sql

begin;

select extensions.plan(12);

-- ---------------------------------------------------------------- fixtures

create temporary table qids (k text primary key, v uuid);
insert into qids (k, v) values
  ('owner', gen_random_uuid()),
  ('room', gen_random_uuid()),
  ('m_open', gen_random_uuid()),
  ('e_open', gen_random_uuid()),
  ('m_closed', gen_random_uuid()),
  ('e_closed', gen_random_uuid()),
  ('m_tasks', gen_random_uuid()),
  ('e_tasks', gen_random_uuid()),
  ('task_a', gen_random_uuid()),
  ('task_b', gen_random_uuid()),
  ('task_x', gen_random_uuid());

create or replace function pg_temp.qid(text) returns uuid language sql stable as
  $$ select v from qids where k = $1 $$;

create or replace function pg_temp.qerr(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $f$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.qid('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'question@test.invalid', '', now(), now(), now());

insert into public.rooms (id, name, owner_id)
values (pg_temp.qid('room'), 'Question room', pg_temp.qid('owner'));

insert into public.messages (id, room_id, author_kind, body, idempotency_key) values
  (pg_temp.qid('m_open'),   pg_temp.qid('room'), 'agent', 'questions', 'qa-open'),
  (pg_temp.qid('m_closed'), pg_temp.qid('room'), 'agent', 'questions', 'qa-closed'),
  (pg_temp.qid('m_tasks'),  pg_temp.qid('room'), 'agent', 'questions', 'qa-tasks');

-- An open intake card with one inferred slot, the shape intake writes.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.qid('e_open'), pg_temp.qid('m_open'), pg_temp.qid('room'), 'question',
  jsonb_build_object(
    'awaiting', 'answers', 'goal', 'get my first 100 customers',
    'questions', jsonb_build_array(jsonb_build_object('slot', 'icp', 'question', 'Who is it for?')),
    'slots', jsonb_build_array(jsonb_build_object('key', 'icp', 'value', 'founders', 'source', 'inferred')),
    'round', 0, 'answers', '[]'::jsonb, 'stalls', 0, 'taskIds', '[]'::jsonb),
  'owner', 'pending');

-- The same card, already answered.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.qid('e_closed'), pg_temp.qid('m_closed'), pg_temp.qid('room'), 'question',
  jsonb_build_object(
    'awaiting', 'answers', 'goal', 'g', 'questions', '[]'::jsonb, 'slots', '[]'::jsonb,
    'round', 0, 'answers', '[]'::jsonb, 'stalls', 0, 'taskIds', '[]'::jsonb),
  'owner', 'answered');

-- A card the plan raised about two steps.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.qid('e_tasks'), pg_temp.qid('m_tasks'), pg_temp.qid('room'), 'question',
  jsonb_build_object(
    'awaiting', 'task_answers', 'goal', '', 'questions', '[]'::jsonb, 'slots', '[]'::jsonb,
    'round', 0, 'answers', '[]'::jsonb, 'stalls', 0,
    'taskIds', jsonb_build_array(pg_temp.qid('task_a')::text, pg_temp.qid('task_b')::text)),
  'owner', 'pending');

-- ---------------------------------------------------------------- slots

select extensions.is(
  (select s ->> 'source'
     from jsonb_array_elements(
       public.answer_question_slot(pg_temp.qid('e_open'), 'icp', '  solo founders in the US ') -> 'slots') s
    where s ->> 'key' = 'icp'),
  'stated',
  'answering a slot writes it as stated, replacing the inference'
);

select extensions.is(
  (select s ->> 'value' from jsonb_array_elements(
     (select payload -> 'slots' from public.action_embeds where id = pg_temp.qid('e_open'))) s
    where s ->> 'key' = 'icp'),
  'solo founders in the US',
  'the value is stored trimmed'
);

select extensions.is(
  (select count(*) from jsonb_array_elements(
     public.answer_question_slot(pg_temp.qid('e_open'), 'icp', 'creators') -> 'slots') s
    where s ->> 'key' = 'icp'),
  1::bigint,
  'answering the same slot twice keeps one entry'
);

select extensions.is(
  (select count(*) from jsonb_array_elements(
     public.answer_question_slot(pg_temp.qid('e_open'), 'budget_band', '500_2k') -> 'slots')),
  2::bigint,
  'a second slot is appended beside the first'
);

select extensions.is(
  (select payload ->> 'goal' from public.action_embeds where id = pg_temp.qid('e_open')),
  'get my first 100 customers',
  'nothing outside slots is touched'
);

select extensions.is(
  pg_temp.qerr($$ select public.answer_question_slot(pg_temp.qid('e_open'), 'colour', 'teal') $$),
  '23514',
  'a slot the playbook does not define raises rather than being stored'
);

select extensions.is(
  pg_temp.qerr($$ select public.answer_question_slot(pg_temp.qid('e_open'), 'offer', '   ') $$),
  '23514',
  'an empty answer raises'
);

select extensions.is(
  public.answer_question_slot(pg_temp.qid('e_closed'), 'icp', 'anyone'),
  null::jsonb,
  'a card that is not pending takes no answer and returns null'
);

-- ---------------------------------------------------------------- tasks

select extensions.is(
  public.answer_question_task(pg_temp.qid('e_tasks'), pg_temp.qid('task_a'), 'Two thousand a month.')
    -> 'taskAnswers' ->> pg_temp.qid('task_a')::text,
  'Two thousand a month.',
  'a task answer is recorded under its task id'
);

select extensions.is(
  public.answer_question_task(pg_temp.qid('e_tasks'), pg_temp.qid('task_x'), 'x'),
  null::jsonb,
  'a task the card never asked about is refused with null, not written'
);

select extensions.is(
  public.answer_question_task(pg_temp.qid('e_open'), pg_temp.qid('task_a'), 'x'),
  null::jsonb,
  'an intake card takes no task answer'
);

-- ---------------------------------------------------------------- privileges

select extensions.ok(
  not has_function_privilege('authenticated', 'public.answer_question_slot(uuid, text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.answer_question_task(uuid, uuid, text)', 'EXECUTE'),
  'a client cannot answer directly: the owner check is on the route, so the route is the only caller'
);

select * from extensions.finish();

rollback;
