-- Artifacts, and the execution path that produces them.
-- Covers 20260813160000_artifacts.sql.
--
-- The path assertions run as `postgres` for the same reason `rls_workflow.sql`
-- does: they are checking that the state machine ACCEPTS the exact route the
-- executor walks, which is a property of the trigger rather than of any caller.
-- If the executor and the machine ever disagree, one of them is wrong, and it is
-- much cheaper to find out here than at `ai_running` on a live project.
--
-- Everything runs inside a transaction that ROLLBACKs.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/artifacts.sql

begin;

select extensions.plan(15);

create temporary table aids (k text primary key, v uuid);
insert into aids (k, v) values
  ('owner', gen_random_uuid()), ('outsider', gen_random_uuid()),
  ('room', gen_random_uuid()), ('msg', gen_random_uuid()), ('embed', gen_random_uuid());

create or replace function pg_temp.aid(text) returns uuid language sql stable as
  $$ select v from aids where k = $1 $$;

create or replace function pg_temp.aerr(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null; exception when others then return sqlstate; end $$;

create or replace function pg_temp.acount_as(p_user uuid, p_sql text)
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

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.aid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@artifact-test.invalid', '', now(), now(), now()
from (values ('owner'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.aid('room'), 'Artifact room', pg_temp.aid('owner'));
insert into public.room_members (room_id, user_id, role)
values (pg_temp.aid('room'), pg_temp.aid('owner'), 'user');

insert into public.messages (id, room_id, author_kind, body, idempotency_key)
values (pg_temp.aid('msg'), pg_temp.aid('room'), 'agent', 'plan', 'artifact-1');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.aid('embed'), pg_temp.aid('msg'), pg_temp.aid('room'), 'plan',
  '{"goal":"g","title":"T","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[{"title":"A","detail":"D","owner":"AI","citations":[1]}]}]}'::jsonb,
  'owner', 'approved');

create temporary table proj as select public.materialise_plan(pg_temp.aid('embed')) as id;
create temporary table tsk as select id from public.tasks where project_id = (select id from proj);

-- ------------------------------------------- the path the executor walks

select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''ready'' where id = %L', (select id from tsk))),
  null::text, 'pending -> ready'
);
select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''routing'' where id = %L', (select id from tsk))),
  null::text, 'ready -> routing'
);
select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''ai_running'' where id = %L', (select id from tsk))),
  null::text, 'routing -> ai_running'
);
select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''ai_self_check'' where id = %L', (select id from tsk))),
  null::text, 'ai_running -> ai_self_check'
);
select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''ai_running'' where id = %L', (select id from tsk))),
  null::text, 'ai_self_check -> ai_running: the bounded re-do the checker can order'
);

-- ------------------------------------------------------------- artifacts

insert into public.task_runs (task_id, agent_run_id, status, attempt)
values ((select id from tsk), 'run-a', 'running', 1);

insert into public.artifacts (task_id, project_id, kind, title, body, citations, created_by)
values ((select id from tsk), (select id from proj), 'draft', 'Positioning',
        'Narrow to founders who tried the manual approach and hit a wall.',
        '["Positioning and ICP for a solo founder"]'::jsonb, 'agent');

select extensions.is(
  pg_temp.aerr(format(
    'insert into public.artifacts (task_id, project_id) values (%L, %L)',
    (select id from tsk), (select id from proj))),
  '23514',
  'an artifact with neither body nor file is refused: a task that reported success and produced nothing'
);

select extensions.is(
  pg_temp.aerr(format(
    'insert into public.task_runs (task_id, agent_run_id, attempt) values (%L, ''run-b'', 1)',
    (select id from tsk))),
  '23505',
  'a retry cannot overwrite the attempt it is retrying'
);

-- ------------------------------------------------- approval unblocks work

update public.tasks set state = 'ai_self_check' where id = (select id from tsk);
update public.tasks set state = 'approved' where id = (select id from tsk);

select extensions.is(
  (select state::text from public.tasks where id = (select id from tsk)),
  'approved',
  'the AI path reaches APPROVED without anyone being paid'
);

select extensions.ok(
  private.task_deps_satisfied((select id from tsk)),
  'an approved task satisfies dependencies, which is what makes the graph move'
);

-- ------------------------------------------------- and then it is finished
--
-- `approved` is not terminal, and "anything non-terminal may be cancelled" is a
-- universal rule of this map, so an AI step that had produced its artifact and
-- passed its own check stayed cancellable forever. `settle_payout` gave `done` a
-- producer for the human arm in slice 7 and recorded that this arm was
-- business-projects-workflow.md's to close. `executeTask` closes it, in a second
-- conditional write rather than a migration: the arc was already legal and had
-- nobody to walk it.

select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''done'' where id = %L', (select id from tsk))),
  null::text,
  'approved -> done, which the AI arm now has a producer for'
);

select extensions.ok(
  private.task_state_is_terminal((select state from public.tasks where id = (select id from tsk))),
  'and done is terminal, so a replan can no longer cancel work the checker passed'
);

select extensions.is(
  pg_temp.aerr(format('update public.tasks set state = ''cancelled'' where id = %L', (select id from tsk))),
  '23514',
  'the kill switch is refused on a finished AI step, which is the hole this closes'
);

-- ---------------------------------------------------------------- access

select extensions.is(
  pg_temp.acount_as(pg_temp.aid('owner'), 'select count(*) from public.artifacts'),
  1::bigint,
  'the owner can read what their project produced'
);

select extensions.is(
  pg_temp.acount_as(pg_temp.aid('outsider'), 'select count(*) from public.artifacts'),
  0::bigint,
  'an outsider cannot'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.artifacts', 'INSERT'),
  'a client cannot write an artifact: it would be fabricating the evidence its task is judged on'
);

select * from extensions.finish();

rollback;
