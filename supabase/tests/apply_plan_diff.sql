-- apply_plan_diff: approving a diff card changes the running plan.
-- Covers 20260828140000_apply_plan_diff.sql (and 20260828130000's component).
--
-- The assertions worth reading first are the ones about work that is already
-- done. A diff is written against the project as it was, and by the time somebody
-- approves it a step may have been approved, failed or cancelled. Every one of
-- those paths is checked for raising AND for leaving nothing behind, because a
-- diff that half-applied would leave a project in a state nobody reviewed, which
-- is worse than one that refused.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/apply_plan_diff.sql

begin;

select extensions.plan(27);

-- ---------------------------------------------------------------- fixtures

create temporary table dids (k text primary key, v uuid);
insert into dids (k, v) values
  ('owner', gen_random_uuid()),
  ('room', gen_random_uuid()),
  ('other_room', gen_random_uuid()),
  ('m_plan', gen_random_uuid()),
  ('e_plan', gen_random_uuid()),
  ('m_add', gen_random_uuid()),
  ('e_add', gen_random_uuid()),
  ('m_cancel', gen_random_uuid()),
  ('e_cancel', gen_random_uuid()),
  ('m_modify', gen_random_uuid()),
  ('e_modify', gen_random_uuid()),
  ('m_stale', gen_random_uuid()),
  ('e_stale', gen_random_uuid()),
  ('m_foreign', gen_random_uuid()),
  ('e_foreign', gen_random_uuid()),
  ('m_badop', gen_random_uuid()),
  ('e_badop', gen_random_uuid()),
  ('m_badref', gen_random_uuid()),
  ('e_badref', gen_random_uuid());

create or replace function pg_temp.did(text) returns uuid language sql stable as
  $$ select v from dids where k = $1 $$;

create or replace function pg_temp.derr(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $f$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.did('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'replan@test.invalid', '', now(), now(), now());

insert into public.rooms (id, name, owner_id) values
  (pg_temp.did('room'), 'Replan room', pg_temp.did('owner')),
  (pg_temp.did('other_room'), 'Another room', pg_temp.did('owner'));

insert into public.messages (id, room_id, author_kind, body, idempotency_key) values
  (pg_temp.did('m_plan'),    pg_temp.did('room'),       'agent', 'plan',   'rp-plan'),
  (pg_temp.did('m_add'),     pg_temp.did('room'),       'agent', 'diff',   'rp-add'),
  (pg_temp.did('m_cancel'),  pg_temp.did('room'),       'agent', 'diff',   'rp-cancel'),
  (pg_temp.did('m_modify'),  pg_temp.did('room'),       'agent', 'diff',   'rp-modify'),
  (pg_temp.did('m_stale'),   pg_temp.did('room'),       'agent', 'diff',   'rp-stale'),
  (pg_temp.did('m_foreign'), pg_temp.did('other_room'), 'agent', 'diff',   'rp-foreign'),
  (pg_temp.did('m_badop'),   pg_temp.did('room'),       'agent', 'diff',   'rp-badop'),
  (pg_temp.did('m_badref'),  pg_temp.did('room'),       'agent', 'diff',   'rp-badref');

-- A running project, built the way a real one is: through the plan card, so
-- `projects.source_embed_id` resolves to this room and the tenancy check has
-- something true to check.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.did('e_plan'), pg_temp.did('m_plan'), pg_temp.did('room'), 'plan', $j$
{
  "goal": "get my first paying customers",
  "title": "Launch plan",
  "summary": "Three steps.",
  "citations": [],
  "stages": [
    {"stage":"strategy","steps":[
      {"id":"positioning","title":"Sharpen positioning","detail":"Narrow it.",
       "owner":"AI","citations":[],"riskTier":"reversible"}]},
    {"stage":"content","steps":[
      {"id":"ad-copy","title":"Draft the ad copy","detail":"From the positioning.",
       "owner":"AI","citations":[],"riskTier":"reversible","dependsOn":["positioning"]}]},
    {"stage":"channels","steps":[
      {"id":"budget","title":"Approve the budget","detail":"Decide the number.",
       "owner":"YOU","citations":[],"riskTier":"high_risk"}]}
  ]
}
$j$::jsonb, 'owner', 'approved');

create temporary table proj as
  select public.materialise_plan(pg_temp.did('e_plan')) as project_id;

create or replace function pg_temp.dtask(p_title text) returns uuid language sql stable as $f$
  select id from public.tasks
  where project_id = (select project_id from proj) and title = p_title
$f$;

-- The cards are built AFTER the project exists, because a diff references tasks
-- by the UUID they were given. That is the shape of the real thing too: `/replan`
-- is handed the current DAG and answers against it.

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_add'), pg_temp.did('m_add'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Add a landing page and a test, both after the copy.',
    'ops', jsonb_build_array(
      jsonb_build_object(
        'op', 'add_step', 'stage', 'conversion', 'id', 'landing',
        'title', 'Write the landing page', 'detail', 'Match the ad promise.',
        'owner', 'AI', 'citations', jsonb_build_array(), 'riskTier', 'reversible',
        'acceptanceCriteria', jsonb_build_array('restates the ad promise'),
        'dependsOn', jsonb_build_array(pg_temp.dtask('Draft the ad copy')::text)
      ),
      jsonb_build_object(
        'op', 'add_step', 'stage', 'measurement', 'id', 'measure',
        'title', 'Report on the test', 'detail', 'Name the conversion event.',
        'owner', 'AI', 'citations', jsonb_build_array(), 'riskTier', 'reversible',
        'dependsOn', jsonb_build_array('landing')
      )
    )
  ),
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_cancel'), pg_temp.did('m_cancel'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Not doing paid ads this quarter.',
    'ops', jsonb_build_array(
      jsonb_build_object('op', 'cancel_task', 'taskId', pg_temp.dtask('Draft the ad copy')::text,
                         'reason', 'not doing paid ads this quarter')
    )
  ),
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_modify'), pg_temp.did('m_modify'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Sharpen what the positioning step has to produce.',
    'ops', jsonb_build_array(
      jsonb_build_object(
        'op', 'modify_task', 'taskId', pg_temp.dtask('Sharpen positioning')::text,
        'detail', 'Narrow to one situation and name who it is not for.',
        'acceptanceCriteria', jsonb_build_array('names the situation', 'states who it is not for'),
        -- Present in the payload and expected to be IGNORED. A diff that could
        -- move a step from YOU to AI, or lower its tier, would route an
        -- authorisation decision through the op that looks least like one.
        'owner', 'AI',
        'riskTier', 'read_only',
        'state', 'approved'
      )
    )
  ),
  'owner', 'approved');

-- Names a step that will be `approved` by the time it is applied.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_stale'), pg_temp.did('m_stale'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Cancel the budget step and add a cheaper one.',
    'ops', jsonb_build_array(
      jsonb_build_object(
        'op', 'add_step', 'stage', 'channels', 'id', 'cheap',
        'title', 'Run a smaller test', 'detail', 'Half the budget.',
        'owner', 'AI', 'citations', jsonb_build_array()
      ),
      jsonb_build_object('op', 'cancel_task', 'taskId', pg_temp.dtask('Approve the budget')::text,
                         'reason', 'too expensive')
    )
  ),
  'owner', 'approved');

-- A card posted in a room that does not own this project.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_foreign'), pg_temp.did('m_foreign'), pg_temp.did('other_room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Cancel someone else''s work.',
    'ops', jsonb_build_array(
      jsonb_build_object('op', 'cancel_task', 'taskId', pg_temp.dtask('Sharpen positioning')::text,
                         'reason', 'from another room')
    )
  ),
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_badop'), pg_temp.did('m_badop'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Something new.',
    'ops', jsonb_build_array(jsonb_build_object('op', 'delete_project'))
  ),
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (
  pg_temp.did('e_badref'), pg_temp.did('m_badref'), pg_temp.did('room'), 'replan',
  jsonb_build_object(
    'projectId', (select project_id from proj),
    'summary', 'Add a step that waits on nothing real.',
    'ops', jsonb_build_array(
      jsonb_build_object(
        'op', 'add_step', 'stage', 'content', 'id', 'orphan',
        'title', 'Orphan step', 'detail', 'D', 'owner', 'AI',
        'citations', jsonb_build_array(),
        'dependsOn', jsonb_build_array('nothing-by-this-name')
      )
    )
  ),
  'owner', 'approved');

-- ------------------------------------------------------------- adding steps

create temporary table added as
  select public.apply_plan_diff(pg_temp.did('e_add')) as project_id;

select extensions.is(
  (select project_id from added),
  (select project_id from proj),
  'applying a diff returns the project it changed'
);

select extensions.is(
  (select count(*) from public.tasks where project_id = (select project_id from proj)),
  5::bigint,
  'the two added steps join the three the plan created, rather than replacing them'
);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.dtask('Write the landing page')),
  'pending',
  'an added step starts PENDING, exactly as a planned one does'
);

select extensions.is(
  (select acceptance_criteria from public.tasks
     where id = pg_temp.dtask('Write the landing page')),
  '["restates the ad promise"]'::jsonb,
  'an added step carries its acceptance criteria'
);

-- Position matters: an added step goes after everything the plan laid out, so a
-- reader sees the project in the order it actually grew.
select extensions.ok(
  (select position from public.tasks where id = pg_temp.dtask('Write the landing page'))
    > (select max(position) from public.tasks
        where project_id = (select project_id from proj)
          and title in ('Sharpen positioning', 'Draft the ad copy', 'Approve the budget')),
  'added steps are positioned after the steps that were already there'
);

select extensions.ok(
  exists (select 1 from public.task_deps
           where task_id = pg_temp.dtask('Write the landing page')
             and depends_on_task_id = pg_temp.dtask('Draft the ad copy')),
  'a diff can make an added step depend on a task that already existed'
);

select extensions.ok(
  exists (select 1 from public.task_deps
           where task_id = pg_temp.dtask('Report on the test')
             and depends_on_task_id = pg_temp.dtask('Write the landing page')),
  'and on another step the same diff added, by its card-local id'
);

select extensions.ok(
  not private.task_deps_satisfied(pg_temp.dtask('Write the landing page')),
  'an added step waits for what it consumes, like any other'
);

select extensions.is(
  (select ops from public.plan_diffs where embed_id = pg_temp.did('e_add')),
  2,
  'the card is recorded as applied, with how many ops it carried'
);

select extensions.is(
  (select count(*) from public.events
     where verb = 'task.replan_added' and project_id = (select project_id from proj)),
  2::bigint,
  'each added step is its own audit entry'
);

-- --------------------------------------------------------------- idempotency

select extensions.is(
  public.apply_plan_diff(pg_temp.did('e_add')),
  (select project_id from proj),
  'a second call returns the project rather than applying the diff again'
);

select extensions.is(
  (select count(*) from public.tasks where project_id = (select project_id from proj)),
  5::bigint,
  'and adds no second copy of the steps: the approve route guards the embed, this guards the work'
);

-- ------------------------------------------------------------------ cancelling

create temporary table cancelled as
  select public.apply_plan_diff(pg_temp.did('e_cancel')) as project_id;

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.dtask('Draft the ad copy')),
  'cancelled',
  'a cancel op moves the step through the state machine like any other transition'
);

select extensions.is(
  (select payload->>'reason' from public.events
     where verb = 'task.replan_cancelled'
       and subject_id = pg_temp.dtask('Draft the ad copy')),
  'not doing paid ads this quarter',
  'the reason is recorded, because a transition event cannot say why'
);

-- The property somebody will eventually want to "fix", so it is asserted rather
-- than left implicit. `task_deps_satisfied` counts a dependency satisfied at
-- `approved` or later, and `cancelled` is neither.
select extensions.ok(
  not private.task_deps_satisfied(pg_temp.dtask('Write the landing page')),
  'cancelling a step does NOT release what was waiting on it: the output will never exist'
);

-- ------------------------------------------------------------------ modifying

create temporary table modified as
  select public.apply_plan_diff(pg_temp.did('e_modify')) as project_id;

select extensions.is(
  (select detail from public.tasks where id = pg_temp.dtask('Sharpen positioning')),
  'Narrow to one situation and name who it is not for.',
  'a modify op corrects the detail'
);

select extensions.is(
  (select acceptance_criteria from public.tasks
     where id = pg_temp.dtask('Sharpen positioning')),
  '["names the situation", "states who it is not for"]'::jsonb,
  'and the acceptance criteria'
);

-- The safety property, and the reason the update statement names three columns
-- rather than taking a payload. The card above asks for all three of these.
select extensions.is(
  (select owner_type::text from public.tasks where id = pg_temp.dtask('Sharpen positioning')),
  'ai',
  'a modify cannot change who runs a step, even when the payload says so'
);

select extensions.is(
  (select risk_tier::text from public.tasks where id = pg_temp.dtask('Sharpen positioning')),
  'reversible',
  'nor how risky it is: lowering a tier through an edit is the authorisation bypass'
);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.dtask('Sharpen positioning')),
  'pending',
  'nor its state: a step cannot be marked done by describing it differently'
);

-- ------------------------------------------------- stale diffs, and cleanliness

update public.tasks set state = 'ready' where id = pg_temp.dtask('Approve the budget');
update public.tasks set state = 'routing' where id = pg_temp.dtask('Approve the budget');
update public.tasks set state = 'needs_user' where id = pg_temp.dtask('Approve the budget');
update public.tasks set state = 'approved' where id = pg_temp.dtask('Approve the budget');

select extensions.is(
  pg_temp.derr(format('select public.apply_plan_diff(%L)', pg_temp.did('e_stale'))),
  '23514',
  'a diff naming work that has since been approved raises rather than skipping that op'
);

-- The atomicity claim. That card's FIRST op is an add, which succeeds, and its
-- second is the stale cancel. If the rollback were not real the project would now
-- hold a step from a diff nobody applied.
select extensions.is(
  (select count(*) from public.tasks
     where project_id = (select project_id from proj) and title = 'Run a smaller test'),
  0::bigint,
  'and the add that came before it in the same diff is gone too: all of it, or none of it'
);

select extensions.is(
  pg_temp.derr(format('select public.apply_plan_diff(%L)', pg_temp.did('e_foreign'))),
  '42501',
  'a card posted in another room cannot change this project, whatever its payload says'
);

select extensions.is(
  pg_temp.derr(format('select public.apply_plan_diff(%L)', pg_temp.did('e_badop'))),
  '22023',
  'an op we cannot read raises rather than being skipped as a no-op'
);

select extensions.is(
  pg_temp.derr(format('select public.apply_plan_diff(%L)', pg_temp.did('e_badref'))),
  '22023',
  'a dependency naming no step of this project raises, as it does when a plan is materialised'
);

select extensions.is(
  (select count(*) from public.plan_diffs
     where embed_id in (pg_temp.did('e_stale'), pg_temp.did('e_foreign'),
                        pg_temp.did('e_badop'), pg_temp.did('e_badref'))),
  0::bigint,
  'no failed diff is recorded as applied, so a retry is still possible'
);

-- ---------------------------------------------------------------- privileges

select extensions.ok(
  not has_function_privilege('authenticated', 'public.apply_plan_diff(uuid)', 'EXECUTE'),
  'a client cannot apply a diff: approving is checked server-side, not called directly'
);

select * from extensions.finish();

rollback;
