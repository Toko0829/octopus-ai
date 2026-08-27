-- Workflow DAG: RLS, privileges, the state machine, and acyclicity.
-- Covers 20260813120000_workflow_dag.sql.
--
-- Two kinds of assertion live here, and the second kind is the unusual one.
--
-- The RLS and privilege tests follow rls_membership.sql: become the role PostgREST
-- would use, supply the JWT claims GoTrue would have issued, and count rows.
-- Testing as `postgres` proves nothing there, because that role bypasses RLS.
--
-- The state-machine and acyclicity tests run as `postgres` ON PURPOSE, and that is
-- the point of them. These guards are triggers, so they apply to trusted server
-- code and to superuser alike. A state machine enforced only in the runner is a
-- state machine the next runner does not inherit, and ADR-0001 already documents
-- changing runners. If these ever start passing because the caller was privileged,
-- the guard has been lost.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/rls_workflow.sql

begin;

select extensions.plan(33);

-- ---------------------------------------------------------------- fixtures

create temporary table wids (k text primary key, v uuid);
insert into wids (k, v) values
  ('owner',    gen_random_uuid()),
  ('member',   gen_random_uuid()),
  ('expired',  gen_random_uuid()),
  ('outsider', gen_random_uuid()),
  ('project',  gen_random_uuid()),
  ('other_project', gen_random_uuid()),
  ('room',     gen_random_uuid()),
  ('other_room', gen_random_uuid()),
  ('t1',       gen_random_uuid()),
  ('t2',       gen_random_uuid()),
  ('t3',       gen_random_uuid()),
  ('other_task', gen_random_uuid());

create or replace function pg_temp.wid(text) returns uuid language sql stable as
  $$ select v from wids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.wid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@workflow-test.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('expired'), ('outsider')) as t(k);

insert into public.projects (id, owner_id, goal, status)
values (pg_temp.wid('project'), pg_temp.wid('owner'),
        'launch my app and get me to my first 100 customers', 'active'),
       (pg_temp.wid('other_project'), pg_temp.wid('outsider'),
        'someone else''s venture', 'active');

-- The room is what carries membership; the project is visible through it.
insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.wid('room'), 'Workflow room', pg_temp.wid('owner'), pg_temp.wid('project')),
       (pg_temp.wid('other_room'), 'Other room', pg_temp.wid('outsider'),
        pg_temp.wid('other_project'));

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.wid('room'), pg_temp.wid('owner'),   'user',       'room', null),
       (pg_temp.wid('room'), pg_temp.wid('member'),  'human_node', 'room', now() + interval '1 day'),
       (pg_temp.wid('room'), pg_temp.wid('expired'), 'human_node', 'room', now() - interval '1 hour'),
       (pg_temp.wid('other_room'), pg_temp.wid('outsider'), 'user', 'room', null);

-- A three-node graph: t2 depends hard on t1, t3 depends soft on t1.
insert into public.tasks (id, project_id, title, owner_type, state, stage, position)
values (pg_temp.wid('t1'), pg_temp.wid('project'), 'Sharpen positioning', 'ai',    'pending', 'strategy', 0),
       (pg_temp.wid('t2'), pg_temp.wid('project'), 'Write the landing page', 'ai', 'pending', 'conversion', 1),
       (pg_temp.wid('t3'), pg_temp.wid('project'), 'Draft launch posts', 'ai',     'pending', 'content', 2);

insert into public.tasks (id, project_id, title, owner_type, state)
values (pg_temp.wid('other_task'), pg_temp.wid('other_project'), 'Not ours', 'ai', 'pending');

insert into public.task_deps (task_id, depends_on_task_id, dep_kind)
values (pg_temp.wid('t2'), pg_temp.wid('t1'), 'hard'),
       (pg_temp.wid('t3'), pg_temp.wid('t1'), 'soft');

insert into public.task_runs (task_id, agent_run_id, status, attempt)
values (pg_temp.wid('t1'), 'run-1', 'running', 1);

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.wcount_as(p_user uuid, p_sql text)
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

-- Helper: the SQLSTATE a statement raises, or null if it succeeds.
--
-- Deliberately returns the code rather than a boolean. "It threw something" would
-- also pass for a typo'd table name, which would make a guard look enforced when
-- the test never reached it.
create or replace function pg_temp.errcode_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ---------------------------------------------------------------- projects

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('owner'), 'select count(*) from public.projects'),
  1::bigint,
  'owner sees their project, through the room that points at it'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('member'), 'select count(*) from public.projects'),
  1::bigint,
  'an unexpired node sees the project it is engaged on'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('expired'), 'select count(*) from public.projects'),
  0::bigint,
  'an EXPIRED node sees no project: time-boxed access expires for work as well as chat'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('outsider'), 'select count(*) from public.projects'),
  1::bigint,
  'an outsider sees only their own project, never ours'
);

-- ------------------------------------------------------------------- tasks

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('owner'), 'select count(*) from public.tasks'),
  3::bigint,
  'owner sees every task in their project and none from another'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('expired'), 'select count(*) from public.tasks'),
  0::bigint,
  'an expired node sees no tasks at all'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('outsider'), 'select count(*) from public.tasks'),
  1::bigint,
  'an outsider sees only their own project''s task'
);

-- --------------------------------------------------------------- task_deps

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('owner'), 'select count(*) from public.task_deps'),
  2::bigint,
  'owner sees the edges of their own graph'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('outsider'), 'select count(*) from public.task_deps'),
  0::bigint,
  'an outsider sees no edges: the graph shape is itself information'
);

-- --------------------------------------------------------------- task_runs

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('owner'), 'select count(*) from public.task_runs'),
  1::bigint,
  'owner sees the run history for their tasks'
);

select extensions.is(
  pg_temp.wcount_as(pg_temp.wid('expired'), 'select count(*) from public.task_runs'),
  0::bigint,
  'an expired node sees no run history'
);

-- ----------------------------------------------------- the state machine
--
-- Run as postgres. These guards must bind trusted code, not merely clients.

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set state = ''ready'' where id = %L', pg_temp.wid('t1'))),
  null::text,
  'pending -> ready is allowed'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set state = ''approved'' where id = %L', pg_temp.wid('t1'))),
  '23514',
  'ready -> approved is refused: skipping the machine is how an unrun task gets paid for'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set state = ''routing'' where id = %L', pg_temp.wid('t1'))),
  null::text,
  'ready -> routing is allowed'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set title = ''renamed'' where id = %L', pg_temp.wid('t1'))),
  null::text,
  'an update that does not change state is not treated as a transition to itself'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set state = ''cancelled'' where id = %L', pg_temp.wid('t3'))),
  null::text,
  'the kill switch reaches any non-terminal state'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'update public.tasks set state = ''ready'' where id = %L', pg_temp.wid('t3'))),
  '23514',
  'terminal means terminal: a cancelled task cannot be resurrected'
);

select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.wid('t1') and verb = 'task.transitioned'),
  2::bigint,
  'every state change wrote an audit event, and the title change did not'
);

-- ------------------------------------------------------- acyclicity

select extensions.is(
  pg_temp.errcode_of(format(
    'insert into public.task_deps (task_id, depends_on_task_id) values (%L, %L)',
    pg_temp.wid('t1'), pg_temp.wid('t2'))),
  '23514',
  'a cycle is refused: the scheduler cannot answer "is this READY" inside one'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'insert into public.task_deps (task_id, depends_on_task_id) values (%L, %L)',
    pg_temp.wid('t1'), pg_temp.wid('t1'))),
  '23514',
  'a task cannot depend on itself'
);

select extensions.is(
  pg_temp.errcode_of(format(
    'insert into public.task_deps (task_id, depends_on_task_id) values (%L, %L)',
    pg_temp.wid('t2'), pg_temp.wid('other_task'))),
  '23503',
  'an edge cannot cross projects: one tenant must not be able to block another'
);

-- ------------------------------------------------- the READY predicate

select extensions.ok(
  not private.task_deps_satisfied(pg_temp.wid('t2')),
  't2 is not ready while its hard dependency is unfinished'
);

update public.tasks set state = 'ai_running' where id = pg_temp.wid('t1');
update public.tasks set state = 'ai_self_check' where id = pg_temp.wid('t1');
update public.tasks set state = 'approved' where id = pg_temp.wid('t1');

select extensions.ok(
  private.task_deps_satisfied(pg_temp.wid('t2')),
  't2 becomes ready at APPROVED, not at PAID: work unblocks on acceptance, not on a bank transfer'
);

-- t3's edge is soft, and t3 was cancelled above, but the predicate is about its
-- dependencies rather than its own state.
select extensions.ok(
  private.task_deps_satisfied(pg_temp.wid('t3')),
  'a SOFT dependency never blocks: it is an ordering preference, not a gate'
);

-- ------------------------------------------------- privileges (not RLS)

select extensions.ok(
  not has_function_privilege('authenticated', 'private.task_deps_satisfied(uuid)', 'EXECUTE'),
  'the READY predicate is not callable from a client: it was published at /rest/v1/rpc once already'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.tasks', 'INSERT'),
  'authenticated cannot INSERT a task: the DAG is written by the orchestrator, not by callers'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.tasks', 'UPDATE'),
  'authenticated cannot UPDATE a task: a client could otherwise approve its own work'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.projects', 'UPDATE'),
  'authenticated cannot raise its own budget_ceiling'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.tasks', 'TRUNCATE'),
  'authenticated cannot TRUNCATE tasks: TRUNCATE ignores RLS entirely'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.events', 'SELECT'),
  'the audit log has no client reader yet: members see its projection in chat'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.events', 'UPDATE'),
  'events is append-only even for trusted code: a rewritable audit log is not evidence'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.events', 'DELETE'),
  'events cannot be deleted, including by the server that wrote them'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.projects', 'SELECT'),
  'anon has no read access to workflow data'
);

select * from extensions.finish();

rollback;
