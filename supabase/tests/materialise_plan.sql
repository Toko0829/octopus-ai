-- materialise_plan: approving a card becomes a project and its tasks.
-- Covers 20260813140000_materialise_plan.sql.
--
-- The assertions worth reading first are the failure ones. Every path that raises
-- is also checked for leaving NOTHING behind, because the reason this is one
-- database function rather than a sequence of supabase-js calls is atomicity: a
-- project created without its tasks is a project the scheduler would call
-- finished. If these ever pass while `projects_created` is non-zero, the guarantee
-- has been lost even though the error is still raised.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/materialise_plan.sql

begin;

select extensions.plan(25);

-- ---------------------------------------------------------------- fixtures

create temporary table mids (k text primary key, v uuid);
insert into mids (k, v) values
  ('owner', gen_random_uuid()),
  ('room', gen_random_uuid()),
  ('ownerless', gen_random_uuid()),
  ('m_good', gen_random_uuid()),
  ('m_titleonly', gen_random_uuid()),
  ('m_badowner', gen_random_uuid()),
  ('m_badrisk', gen_random_uuid()),
  ('m_empty', gen_random_uuid()),
  ('m_ownerless', gen_random_uuid()),
  ('e_good', gen_random_uuid()),
  ('e_titleonly', gen_random_uuid()),
  ('e_badowner', gen_random_uuid()),
  ('e_badrisk', gen_random_uuid()),
  ('e_empty', gen_random_uuid()),
  ('e_ownerless', gen_random_uuid());

create or replace function pg_temp.mid(text) returns uuid language sql stable as
  $$ select v from mids where k = $1 $$;

-- Returns the SQLSTATE a statement raises, or null. The code rather than a
-- boolean, so a typo'd identifier cannot masquerade as a guard firing.
create or replace function pg_temp.merr(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.mid('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'materialise@test.invalid', '', now(), now(), now());

insert into public.rooms (id, name, owner_id)
values (pg_temp.mid('room'), 'Plan room', pg_temp.mid('owner')),
       -- Nullable owner is the safe default from 20260812130000: a room nobody
       -- owns is a room nobody can approve in.
       (pg_temp.mid('ownerless'), 'Ownerless room', null);

insert into public.messages (id, room_id, author_kind, body, idempotency_key) values
  (pg_temp.mid('m_good'),      pg_temp.mid('room'),      'agent', 'plan', 'mat-good'),
  (pg_temp.mid('m_titleonly'), pg_temp.mid('room'),      'agent', 'plan', 'mat-titleonly'),
  (pg_temp.mid('m_badowner'),  pg_temp.mid('room'),      'agent', 'plan', 'mat-badowner'),
  (pg_temp.mid('m_badrisk'),   pg_temp.mid('room'),      'agent', 'plan', 'mat-badrisk'),
  (pg_temp.mid('m_empty'),     pg_temp.mid('room'),      'agent', 'plan', 'mat-empty'),
  (pg_temp.mid('m_ownerless'), pg_temp.mid('ownerless'), 'agent', 'plan', 'mat-ownerless');

-- The realistic case: six stages, two of them legitimately empty, owners across
-- all three kinds. Empty stages are meaningful output (the corpus had nothing in
-- scope) and must produce no tasks rather than placeholder ones.
--
-- The last step is the one this suite exists to defend after 20260816120000: an
-- AI-owned step that spends money. The planner is allowed to propose exactly
-- that, and the router is required to refuse it, so the tier has to survive the
-- trip from card to row or the refusal never happens.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_good'), pg_temp.mid('m_good'), pg_temp.mid('room'), 'plan', $j$
{
  "goal": "launch my focus app and get me to my first 100 customers",
  "title": "Full-funnel launch plan",
  "summary": "Four stages covered, conversion and measurement left empty.",
  "citations": [{"sourceId":"c1","label":"Positioning and ICP for a solo founder"}],
  "stages": [
    {"stage":"strategy","steps":[
      {"title":"Sharpen positioning","detail":"Narrow to a situation.","owner":"AI","citations":[1],
       "riskTier":"reversible","acceptanceCriteria":["names the situation it wins in","states who it is not for"]},
      {"title":"Pick the price","detail":"Decide the number.","owner":"YOU","citations":[],
       "riskTier":"reversible"}]},
    {"stage":"content","steps":[
      {"title":"Write three pieces","detail":"One idea each.","owner":"AI","citations":[1],
       "riskTier":"reversible"}]},
    {"stage":"creative","steps":[
      {"title":"Direct the creative","detail":"Taste call.","owner":"HUMAN","citations":[],
       "riskTier":"reversible"}]},
    {"stage":"channels","steps":[
      {"title":"Turn the campaign on","detail":"Go live within the budget band.","owner":"AI","citations":[1],
       "riskTier":"high_risk"}]},
    {"stage":"conversion","steps":[]},
    {"stage":"measurement","steps":[]}
  ]
}
$j$::jsonb, 'owner', 'approved');

-- A card written before the payload carried a goal.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_titleonly'), pg_temp.mid('m_titleonly'), pg_temp.mid('room'), 'plan',
  '{"title":"Plan title stands in","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[{"title":"X","detail":"D","owner":"AI","citations":[]}]}]}'::jsonb,
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_badowner'), pg_temp.mid('m_badowner'), pg_temp.mid('room'), 'plan',
  '{"title":"T","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[{"title":"X","detail":"D","owner":"ROBOT","citations":[]}]}]}'::jsonb,
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_badrisk'), pg_temp.mid('m_badrisk'), pg_temp.mid('room'), 'plan',
  '{"title":"T","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[{"title":"X","detail":"D","owner":"AI","citations":[],"riskTier":"probably_fine"}]}]}'::jsonb,
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_empty'), pg_temp.mid('m_empty'), pg_temp.mid('room'), 'plan',
  '{"title":"T","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[]}]}'::jsonb,
  'owner', 'approved');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values (pg_temp.mid('e_ownerless'), pg_temp.mid('m_ownerless'), pg_temp.mid('ownerless'), 'plan',
  '{"title":"T","summary":"S","citations":[],"stages":[{"stage":"strategy","steps":[{"title":"X","detail":"D","owner":"AI","citations":[]}]}]}'::jsonb,
  'owner', 'approved');

-- ------------------------------------------------------------- the happy path

create temporary table built as
  select public.materialise_plan(pg_temp.mid('e_good')) as project_id;

select extensions.is(
  (select goal from public.projects where id = (select project_id from built)),
  'launch my focus app and get me to my first 100 customers',
  'the project carries the goal in the person''s words, not the model''s restatement'
);

select extensions.is(
  (select status::text from public.projects where id = (select project_id from built)),
  'active',
  'the project is active: planning is what just finished'
);

select extensions.is(
  (select count(*) from public.tasks where project_id = (select project_id from built)),
  5::bigint,
  'one task per step, and the two empty stages produce none'
);

select extensions.is(
  (select string_agg(owner_type::text, ',' order by position)
     from public.tasks where project_id = (select project_id from built)),
  'ai,user,ai,human,ai',
  'AI / YOU / HUMAN map to ai / user / human, in plan order'
);

select extensions.is(
  (select string_agg(stage, ',' order by position)
     from public.tasks where project_id = (select project_id from built)),
  'strategy,strategy,content,creative,channels',
  'each task remembers the funnel stage it came from'
);

select extensions.is(
  (select citations from public.tasks
     where project_id = (select project_id from built) and position = 0),
  '{1}'::int[],
  'citations survive onto the task: rule 10 applies to the work, not just the prose'
);

select extensions.is(
  (select string_agg(risk_tier::text, ',' order by position)
     from public.tasks where project_id = (select project_id from built)),
  'reversible,reversible,reversible,reversible,high_risk',
  'the risk tier survives the card: without it the router''s first rule reads a default and never fires'
);

-- The case the whole change exists for. The planner is allowed to propose an
-- AI-owned step that spends money; what must not happen is that step reaching the
-- scheduler labelled safe. Asserted on the row rather than through the router,
-- because the router is already tested and the row is the part that was missing.
select extensions.ok(
  exists (select 1 from public.tasks
           where project_id = (select project_id from built)
             and owner_type = 'ai' and risk_tier = 'high_risk'),
  'an AI-owned high-risk step is stored as high_risk, which is what makes the router refuse it'
);

select extensions.is(
  (select acceptance_criteria from public.tasks
     where project_id = (select project_id from built) and position = 0),
  '["names the situation it wins in","states who it is not for"]'::jsonb,
  'acceptance criteria are stored as an array, which is what the maker-checker will read'
);

select extensions.is(
  (select acceptance_criteria from public.tasks
     where project_id = (select project_id from built) and position = 1),
  '[]'::jsonb,
  'a step with no criteria stores an empty array, not an empty object'
);

select extensions.is(
  (select count(distinct state::text) from public.tasks where project_id = (select project_id from built)),
  1::bigint,
  'every task starts in one state'
);

select extensions.is(
  (select state::text from public.tasks
     where project_id = (select project_id from built) and position = 0),
  'pending',
  'tasks start PENDING: marking one READY is the scheduler''s job, and it does not exist yet'
);

select extensions.is(
  (select project_id from public.rooms where id = pg_temp.mid('room')),
  (select project_id from built),
  'the room is linked to the project it produced'
);

select extensions.is(
  (select count(*) from public.events
     where verb = 'project.materialised' and subject_id = (select project_id from built)),
  1::bigint,
  'materialising is recorded in the audit log'
);

-- ---------------------------------------------------------------- idempotency

select extensions.is(
  public.materialise_plan(pg_temp.mid('e_good')),
  (select project_id from built),
  'a second call returns the same project rather than building another'
);

select extensions.is(
  (select count(*) from public.projects where source_embed_id = pg_temp.mid('e_good')),
  1::bigint,
  'one card, one project, however many times the call is retried'
);

-- ------------------------------------------------------------------ fallback
--
-- Materialised into a table first, deliberately. Calling the function inside the
-- WHERE clause of a select against `projects` returns NULL: the statement's
-- snapshot is taken before it runs, so the row the function inserts mid-scan is
-- not visible to that same scan. It looks like the function returned nothing.

create temporary table legacy as
  select public.materialise_plan(pg_temp.mid('e_titleonly')) as project_id;

select extensions.is(
  (select goal from public.projects where id = (select project_id from legacy)),
  'Plan title stands in',
  'a card written before payload.goal existed falls back to the title'
);

-- Absent is not the same as wrong. This card predates the field entirely, and it
-- must land exactly where it already landed rather than failing to materialise.
select extensions.is(
  (select string_agg(risk_tier::text, ',' order by position)
     from public.tasks where project_id = (select project_id from legacy)),
  'reversible',
  'a card with no risk tier defaults to reversible: an old card still approves'
);

-- ------------------------------------------------------- failures, and cleanliness

select extensions.is(
  pg_temp.merr(format('select public.materialise_plan(%L)', pg_temp.mid('e_badowner'))),
  '22023',
  'an unrecognised owner raises rather than defaulting: defaulting would route a human task to the AI'
);

select extensions.is(
  pg_temp.merr(format('select public.materialise_plan(%L)', pg_temp.mid('e_badrisk'))),
  '22023',
  'a risk tier we cannot read raises: a step we cannot classify is not a step we may call safe'
);

select extensions.is(
  pg_temp.merr(format('select public.materialise_plan(%L)', pg_temp.mid('e_empty'))),
  '23514',
  'a plan with no steps is refused: a project with no tasks can never advance'
);

select extensions.is(
  pg_temp.merr(format('select public.materialise_plan(%L)', pg_temp.mid('e_ownerless'))),
  '23502',
  'a room with no owner cannot produce a project'
);

select extensions.is(
  pg_temp.merr(format('select public.materialise_plan(%L)', gen_random_uuid())),
  'P0002',
  'a missing embed raises rather than silently building nothing'
);

-- The atomicity claim, stated as an assertion rather than as a comment. Three of
-- the four failing calls insert a `projects` row and only then raise (bad owner
-- and bad risk tier fail inside the task loop, empty plan fails after it), so if
-- the statement-level rollback were not real those rows would still be here.
--
-- **Scoped to this suite's own cards rather than counting the table.** It used to
-- assert `count(*) from public.projects = 2`, which is a claim about the whole
-- database and not about anything this test did. It passed for as long as the
-- database happened to hold no projects and broke the moment a real one existed,
-- reporting `have: 3, want: 2` about a row the suite never touched. A test that
-- silently depends on the rest of the database being empty is a test that starts
-- lying the day the product is used, and pgTAP is not in CI to catch it.
select extensions.is(
  (select count(*) from public.projects
     where source_embed_id in (
       pg_temp.mid('e_badowner'),
       pg_temp.mid('e_badrisk'),
       pg_temp.mid('e_empty'),
       pg_temp.mid('e_ownerless')
     )),
  0::bigint,
  'five failed calls left no partial projects behind: all of it, or none of it'
);

-- ---------------------------------------------------------------- privileges

select extensions.ok(
  not has_function_privilege('authenticated', 'public.materialise_plan(uuid)', 'EXECUTE'),
  'a client cannot materialise a plan: approving is checked server-side, not called directly'
);

select * from extensions.finish();

rollback;
