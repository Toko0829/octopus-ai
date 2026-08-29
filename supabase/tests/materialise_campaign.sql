-- materialise_campaign: an approved campaign card becomes one authorised campaign.
-- Covers 20260829140000_materialise_campaign.sql.
--
-- **The assertions worth reading first are the spend ones.** This is the first
-- writer in the repository whose failure mode is a number rather than a row, and
-- the boundary is asserted in both directions on purpose: `>` and not `>=` means
-- landing exactly on the ceiling is authorised, and an off-by-one here either
-- refuses what the owner allowed or commits one unit more than they did. The same
-- boundary is pinned in TypeScript by `packages/marketing/src/spend.test.ts`,
-- because the arithmetic exists twice (the API refuses readably, this refuses
-- authoritatively under a row lock) and two implementations that drift apart must
-- fail a test rather than disagree quietly in production.
--
-- Every path that raises is also checked for leaving NOTHING behind. The reason
-- this is one database function rather than a sequence of supabase-js calls is
-- atomicity: a campaign row written after a task was moved, or a task moved for a
-- campaign that never existed, is a project in a state nobody authorised.
--
-- The fixtures build projects by inserting them against real plan cards rather
-- than by calling `materialise_plan`, because the only thing the tenancy check
-- needs is for `projects.source_embed_id` to resolve to a room. Tasks are
-- inserted directly at `needs_user`: `tasks_guard_transition` is BEFORE UPDATE,
-- so an insert chooses its own starting state and the guard still binds every
-- move afterwards.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/materialise_campaign.sql

begin;

select extensions.plan(41);

-- ---------------------------------------------------------------- fixtures

create temporary table cids (k text primary key, v uuid);
insert into cids (k, v) values
  ('owner', gen_random_uuid()),
  ('room', gen_random_uuid()),
  ('other_room', gen_random_uuid()),
  -- One plan card per project, because projects.source_embed_id is unique and the
  -- tenancy check resolves a project to a room through it.
  ('pc_main', gen_random_uuid()), ('pm_main', gen_random_uuid()),
  ('pc_spend', gen_random_uuid()), ('pm_spend', gen_random_uuid()),
  ('pc_term', gen_random_uuid()), ('pm_term', gen_random_uuid()),
  ('pc_nullcap', gen_random_uuid()), ('pm_nullcap', gen_random_uuid()),
  ('pc_noceil', gen_random_uuid()), ('pm_noceil', gen_random_uuid()),
  ('pc_done', gen_random_uuid()), ('pm_done', gen_random_uuid()),
  ('pc_other', gen_random_uuid()), ('pm_other', gen_random_uuid()),
  ('p_main', gen_random_uuid()),
  ('p_spend', gen_random_uuid()),
  ('p_term', gen_random_uuid()),
  ('p_nullcap', gen_random_uuid()),
  ('p_noceil', gen_random_uuid()),
  ('p_done', gen_random_uuid()),
  ('p_other', gen_random_uuid()),
  ('t_main', gen_random_uuid()),
  ('t_done', gen_random_uuid()),
  ('t_other', gen_random_uuid()),
  -- Campaign cards, one message and one embed each.
  ('m_good', gen_random_uuid()),      ('c_good', gen_random_uuid()),
  ('m_notask', gen_random_uuid()),    ('c_notask', gen_random_uuid()),
  ('m_taskdone', gen_random_uuid()),  ('c_taskdone', gen_random_uuid()),
  ('m_cross', gen_random_uuid()),     ('c_cross', gen_random_uuid()),
  ('m_nocap', gen_random_uuid()),     ('c_nocap', gen_random_uuid()),
  ('m_negcap', gen_random_uuid()),    ('c_negcap', gen_random_uuid()),
  ('m_badchan', gen_random_uuid()),   ('c_badchan', gen_random_uuid()),
  ('m_noname', gen_random_uuid()),    ('c_noname', gen_random_uuid()),
  ('m_noceil', gen_random_uuid()),    ('c_noceil', gen_random_uuid()),
  ('m_curr', gen_random_uuid()),      ('c_curr', gen_random_uuid()),
  ('m_done', gen_random_uuid()),      ('c_done', gen_random_uuid()),
  ('m_othertask', gen_random_uuid()), ('c_othertask', gen_random_uuid()),
  ('m_exact', gen_random_uuid()),     ('c_exact', gen_random_uuid()),
  ('m_over', gen_random_uuid()),      ('c_over', gen_random_uuid()),
  ('m_term', gen_random_uuid()),      ('c_term', gen_random_uuid()),
  ('m_nullcap', gen_random_uuid()),   ('c_nullcap', gen_random_uuid());

create or replace function pg_temp.cid(text) returns uuid language sql stable as
  $$ select v from cids where k = $1 $$;

-- Returns the SQLSTATE a statement raises, or null. The code rather than a
-- boolean, so a typo'd identifier cannot masquerade as a guard firing.
create or replace function pg_temp.cerr(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.cid('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'campaign@test.invalid', '', now(), now(), now());

insert into public.rooms (id, name, owner_id) values
  (pg_temp.cid('room'), 'Campaign room', pg_temp.cid('owner')),
  (pg_temp.cid('other_room'), 'Another room', pg_temp.cid('owner'));

insert into public.messages (id, room_id, author_kind, body, idempotency_key) values
  (pg_temp.cid('pm_main'),    pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-main'),
  (pg_temp.cid('pm_spend'),   pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-spend'),
  (pg_temp.cid('pm_term'),    pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-term'),
  (pg_temp.cid('pm_nullcap'), pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-nullcap'),
  (pg_temp.cid('pm_noceil'),  pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-noceil'),
  (pg_temp.cid('pm_done'),    pg_temp.cid('room'),       'agent', 'plan', 'cam-pm-done'),
  (pg_temp.cid('pm_other'),   pg_temp.cid('other_room'), 'agent', 'plan', 'cam-pm-other');

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values
  (pg_temp.cid('pc_main'),    pg_temp.cid('pm_main'),    pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_spend'),   pg_temp.cid('pm_spend'),   pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_term'),    pg_temp.cid('pm_term'),    pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_nullcap'), pg_temp.cid('pm_nullcap'), pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_noceil'),  pg_temp.cid('pm_noceil'),  pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_done'),    pg_temp.cid('pm_done'),    pg_temp.cid('room'),       'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved'),
  (pg_temp.cid('pc_other'),   pg_temp.cid('pm_other'),   pg_temp.cid('other_room'), 'plan', '{"title":"P","summary":"S","citations":[],"stages":[]}'::jsonb, 'owner', 'approved');

insert into public.projects (id, owner_id, goal, status, source_embed_id, budget_ceiling, currency) values
  (pg_temp.cid('p_main'),    pg_temp.cid('owner'), 'main',    'active',    pg_temp.cid('pc_main'),    1000.00, 'USD'),
  (pg_temp.cid('p_spend'),   pg_temp.cid('owner'), 'spend',   'active',    pg_temp.cid('pc_spend'),   1000.00, 'USD'),
  (pg_temp.cid('p_term'),    pg_temp.cid('owner'), 'term',    'active',    pg_temp.cid('pc_term'),    1000.00, 'USD'),
  (pg_temp.cid('p_nullcap'), pg_temp.cid('owner'), 'nullcap', 'active',    pg_temp.cid('pc_nullcap'), 1000.00, 'USD'),
  -- Nothing authorised, which is what NULL means here and never "unlimited".
  (pg_temp.cid('p_noceil'),  pg_temp.cid('owner'), 'noceil',  'active',    pg_temp.cid('pc_noceil'),  null,    'USD'),
  (pg_temp.cid('p_done'),    pg_temp.cid('owner'), 'done',    'completed', pg_temp.cid('pc_done'),    1000.00, 'USD'),
  (pg_temp.cid('p_other'),   pg_temp.cid('owner'), 'other',   'active',    pg_temp.cid('pc_other'),   1000.00, 'USD');

-- Inserted straight at needs_user, which is where the router parks a high-risk
-- step and therefore the only state a campaign card is ever approved against.
insert into public.tasks (id, project_id, title, detail, stage, owner_type, risk_tier, state, position) values
  (pg_temp.cid('t_main'),  pg_temp.cid('p_main'),  'Turn the campaign on', 'Go live.', 'channels', 'ai', 'high_risk', 'needs_user', 0),
  -- Already closed, standing in for the owner having answered its question card
  -- while the campaign card sat unapproved.
  (pg_temp.cid('t_done'),  pg_temp.cid('p_main'),  'Already handled',      'Done.',    'channels', 'ai', 'high_risk', 'approved',   1),
  (pg_temp.cid('t_other'), pg_temp.cid('p_other'), 'Someone else''s step', 'Theirs.',  'channels', 'ai', 'high_risk', 'needs_user', 0);

-- Siblings that must not count against the ceiling, written directly because the
-- point is the arithmetic rather than how they were authorised.
insert into public.campaigns (project_id, name, channel, state, budget_cap, currency) values
  -- Cancelled: terminal, so it holds none of the ceiling.
  (pg_temp.cid('p_term'), 'Stopped', 'meta', 'cancelled', 900.00, 'USD'),
  -- Null cap: contributes nothing rather than poisoning the sum with a NULL.
  (pg_temp.cid('p_nullcap'), 'Unpriced', 'email', 'ready', null, 'USD');

insert into public.messages (id, room_id, author_kind, body, idempotency_key) values
  (pg_temp.cid('m_good'),      pg_temp.cid('room'),       'agent', 'campaign', 'cam-good'),
  (pg_temp.cid('m_notask'),    pg_temp.cid('room'),       'agent', 'campaign', 'cam-notask'),
  (pg_temp.cid('m_taskdone'),  pg_temp.cid('room'),       'agent', 'campaign', 'cam-taskdone'),
  (pg_temp.cid('m_cross'),     pg_temp.cid('room'),       'agent', 'campaign', 'cam-cross'),
  (pg_temp.cid('m_nocap'),     pg_temp.cid('room'),       'agent', 'campaign', 'cam-nocap'),
  (pg_temp.cid('m_negcap'),    pg_temp.cid('room'),       'agent', 'campaign', 'cam-negcap'),
  (pg_temp.cid('m_badchan'),   pg_temp.cid('room'),       'agent', 'campaign', 'cam-badchan'),
  (pg_temp.cid('m_noname'),    pg_temp.cid('room'),       'agent', 'campaign', 'cam-noname'),
  (pg_temp.cid('m_noceil'),    pg_temp.cid('room'),       'agent', 'campaign', 'cam-noceil'),
  (pg_temp.cid('m_curr'),      pg_temp.cid('room'),       'agent', 'campaign', 'cam-curr'),
  (pg_temp.cid('m_done'),      pg_temp.cid('room'),       'agent', 'campaign', 'cam-done'),
  (pg_temp.cid('m_othertask'), pg_temp.cid('room'),       'agent', 'campaign', 'cam-othertask'),
  (pg_temp.cid('m_exact'),     pg_temp.cid('room'),       'agent', 'campaign', 'cam-exact'),
  (pg_temp.cid('m_over'),      pg_temp.cid('room'),       'agent', 'campaign', 'cam-over'),
  (pg_temp.cid('m_term'),      pg_temp.cid('room'),       'agent', 'campaign', 'cam-term'),
  (pg_temp.cid('m_nullcap'),   pg_temp.cid('room'),       'agent', 'campaign', 'cam-nullcap');

-- The happy path card. `acted_by` is set because it is what decides `created_by`,
-- and a campaign attributed to the agent when a person authorised it would put an
-- untrue sentence in the audit trail.
insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state, acted_by, acted_at)
values (pg_temp.cid('c_good'), pg_temp.cid('m_good'), pg_temp.cid('room'), 'campaign',
  jsonb_build_object(
    'projectId', pg_temp.cid('p_main'),
    'taskId', pg_temp.cid('t_main'),
    'name', 'Meta prospecting, cold audiences',
    'objective', 'First 100 customers',
    'channel', 'meta',
    'budgetCap', 400,
    'currency', 'USD',
    'summary', 'Meta carries cold reach for a creator launch.',
    'citations', '[]'::jsonb
  ), 'owner', 'approved', pg_temp.cid('owner'), now());

insert into public.action_embeds (id, message_id, room_id, component, payload, required_role, state)
values
  (pg_temp.cid('c_notask'), pg_temp.cid('m_notask'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', 'No step behind it',
     'channel', 'email', 'budgetCap', 0, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_taskdone'), pg_temp.cid('m_taskdone'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'taskId', pg_temp.cid('t_done'),
     'name', 'Step already closed', 'channel', 'google', 'budgetCap', 10, 'currency', 'USD',
     'summary', 'S'), 'owner', 'approved'),

  -- Posted in `room`, naming a project whose plan card lives in `other_room`.
  (pg_temp.cid('c_cross'), pg_temp.cid('m_cross'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_other'), 'name', 'Reaching across',
     'channel', 'meta', 'budgetCap', 100, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_nocap'), pg_temp.cid('m_nocap'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', 'Unpriced',
     'channel', 'meta', 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_negcap'), pg_temp.cid('m_negcap'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', 'Negative',
     'channel', 'meta', 'budgetCap', -1, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_badchan'), pg_temp.cid('m_badchan'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', 'Elsewhere',
     'channel', 'tiktok', 'budgetCap', 100, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_noname'), pg_temp.cid('m_noname'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', '   ',
     'channel', 'meta', 'budgetCap', 100, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_noceil'), pg_temp.cid('m_noceil'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_noceil'), 'name', 'Unauthorised project',
     'channel', 'meta', 'budgetCap', 1, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_curr'), pg_temp.cid('m_curr'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'name', 'Wrong money',
     'channel', 'meta', 'budgetCap', 100, 'currency', 'EUR', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_done'), pg_temp.cid('m_done'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_done'), 'name', 'Too late',
     'channel', 'meta', 'budgetCap', 100, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_othertask'), pg_temp.cid('m_othertask'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_main'), 'taskId', pg_temp.cid('t_other'),
     'name', 'Borrowed step', 'channel', 'meta', 'budgetCap', 100, 'currency', 'USD',
     'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_exact'), pg_temp.cid('m_exact'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_spend'), 'name', 'Exactly the ceiling',
     'channel', 'meta', 'budgetCap', 1000, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_over'), pg_temp.cid('m_over'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_spend'), 'name', 'One cent over',
     'channel', 'meta', 'budgetCap', 0.01, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_term'), pg_temp.cid('m_term'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_term'), 'name', 'Past a cancelled sibling',
     'channel', 'meta', 'budgetCap', 400, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved'),

  (pg_temp.cid('c_nullcap'), pg_temp.cid('m_nullcap'), pg_temp.cid('room'), 'campaign',
   jsonb_build_object('projectId', pg_temp.cid('p_nullcap'), 'name', 'Past an unpriced sibling',
     'channel', 'meta', 'budgetCap', 400, 'currency', 'USD', 'summary', 'S'), 'owner', 'approved');

-- ------------------------------------------------------------- the happy path

-- Materialised into a temp table first. Calling the function inside a WHERE
-- clause reads a statement snapshot that predates its own insert and returns
-- nothing, which reads as the function having done nothing at all.
create temporary table built as
  select public.materialise_campaign(pg_temp.cid('c_good')) as campaign_id;

select extensions.is(
  (select count(*) from public.campaigns where id = (select campaign_id from built)),
  1::bigint,
  'an approved card produces exactly one campaign'
);

select extensions.is(
  (select state::text from public.campaigns where id = (select campaign_id from built)),
  'ready',
  'the campaign lands at ready: approved by the owner, not yet sent'
);

select extensions.is(
  (select budget_cap from public.campaigns where id = (select campaign_id from built)),
  400.00::numeric,
  'the cap is the number the owner typed onto the card'
);

select extensions.is(
  (select currency from public.campaigns where id = (select campaign_id from built)),
  'USD',
  'the currency is carried, since the ceiling arithmetic is meaningless without one'
);

select extensions.is(
  (select channel::text from public.campaigns where id = (select campaign_id from built)),
  'meta',
  'the channel survives the card'
);

select extensions.is(
  (select name from public.campaigns where id = (select campaign_id from built)),
  'Meta prospecting, cold audiences',
  'the name is the card''s, not a restatement'
);

select extensions.is(
  (select objective from public.campaigns where id = (select campaign_id from built)),
  'First 100 customers',
  'the objective is carried when the card has one'
);

select extensions.is(
  (select created_by::text from public.campaigns where id = (select campaign_id from built)),
  'user',
  'a campaign a person approved is attributed to a person, from acted_by'
);

select extensions.is(
  (select source_embed_id from public.campaigns where id = (select campaign_id from built)),
  pg_temp.cid('c_good'),
  'the campaign remembers the card that authorised it, which is what makes a retry idempotent'
);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.cid('t_main')),
  'approved',
  'authorising the campaign closes the step it delivers, so its dependents can become ready'
);

select extensions.is(
  (select count(*) from public.events
    where subject_id = (select campaign_id from built) and verb = 'campaign.materialised'),
  1::bigint,
  'the authorisation of money writes an event, which the UPDATE-only campaign trigger cannot'
);

select extensions.is(
  (select payload->>'task_closed' from public.events
    where subject_id = (select campaign_id from built) and verb = 'campaign.materialised'),
  'true',
  'the event records that this approval is what closed the step'
);

select extensions.is(
  (select payload->>'committed_before' from public.events
    where subject_id = (select campaign_id from built) and verb = 'campaign.materialised'),
  '0.00',
  'the event records what was already committed, so the ceiling decision is auditable afterwards'
);

-- --------------------------------------------------------------- idempotency

create temporary table again as
  select public.materialise_campaign(pg_temp.cid('c_good')) as campaign_id;

select extensions.is(
  (select campaign_id from again),
  (select campaign_id from built),
  'a retry after a failed commit returns the same campaign rather than authorising a second one'
);

select extensions.is(
  (select count(*) from public.campaigns where source_embed_id = pg_temp.cid('c_good')),
  1::bigint,
  'and writes no second row'
);

select extensions.is(
  (select count(*) from public.events
    where subject_id = (select campaign_id from built) and verb = 'campaign.materialised'),
  1::bigint,
  'and no second event, so the audit trail does not double-count an authorisation'
);

-- ------------------------------------------------------------ what it refuses

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('pc_main'))),
  '22023',
  'a plan card is refused rather than read as a campaign'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', gen_random_uuid())),
  'P0002',
  'a card that does not exist raises no_data_found'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_cross'))),
  '42501',
  'a card cannot authorise spend against another room''s project, which the action route cannot catch'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_nocap'))),
  '23514',
  'a card with no cap is refused: approved-with-nothing-authorised is not a state'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_negcap'))),
  '23514',
  'a negative cap is refused rather than clamped'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_badchan'))),
  '22023',
  'an unknown channel raises with the value rather than surfacing as a cast error'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_noname'))),
  '22023',
  'a blank name is refused, since a campaign nobody can identify cannot be paused by name later'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_noceil'))),
  '23514',
  'a project with no ceiling authorises nothing, which is what NULL means and never unlimited'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_curr'))),
  '23514',
  'a currency the project does not use is refused, because summing it against the ceiling means nothing'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_done'))),
  '23514',
  'a finished project does not start campaigns'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_othertask'))),
  '22023',
  'a card cannot close a step belonging to a different project'
);

-- ------------------------------------------------------- the spend boundary

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_exact'))),
  null,
  'landing exactly on the ceiling is authorised: the comparison is > and not >='
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_over'))),
  '23514',
  'and one cent past it is refused, which is the other half of the same boundary'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_term'))),
  null,
  'a cancelled sibling holds none of the ceiling, so its cap does not block new work'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_nullcap'))),
  null,
  'a sibling with no cap contributes nothing rather than turning the sum into NULL'
);

-- ------------------------------------------------------------------ atomicity

select extensions.is(
  (select count(*) from public.campaigns where project_id = pg_temp.cid('p_other')),
  0::bigint,
  'the cross-room refusal left no campaign behind'
);

select extensions.is(
  (select count(*) from public.campaigns where project_id = pg_temp.cid('p_noceil')),
  0::bigint,
  'the no-ceiling refusal left no campaign behind'
);

select extensions.is(
  (select count(*) from public.campaigns where project_id = pg_temp.cid('p_spend')),
  1::bigint,
  'the over-ceiling refusal left nothing behind, so only the exact-ceiling campaign exists'
);

-- The assertion that found the defect this function shipped once. The errcode
-- check above says the guard fires; this says what happens when it does not. The
-- first version used `<>` against a `jsonb_typeof` that is NULL for an absent
-- key, so the comparison was NULL, the guard never fired, and a campaign was
-- created at `ready` holding `budget_cap = NULL`: authorised, with nothing
-- authorised, which is the exact state the cap exists to make impossible.
select extensions.is(
  (select count(*) from public.campaigns where source_embed_id = pg_temp.cid('c_nocap')),
  0::bigint,
  'a card with no cap creates no campaign at all, rather than one authorising nothing'
);

-- ------------------------------------------------------------- the step edges

select extensions.is(
  (select count(*) from public.campaigns where source_embed_id = pg_temp.cid('c_notask')
     or source_embed_id = pg_temp.cid('c_taskdone')),
  0::bigint,
  'neither task-edge card has been committed yet, so the two assertions below measure their own calls'
);

select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_notask'))),
  null,
  'a card naming no step still authorises a campaign, since task_id is nullable by design'
);

-- The case that must not raise. The step moved while the card sat there, and
-- raising would strand the approval: the card already reads approved, so every
-- retry meets the same state and the campaign the owner authorised never exists.
select extensions.is(
  pg_temp.cerr(format('select public.materialise_campaign(%L)', pg_temp.cid('c_taskdone'))),
  null,
  'a step that closed while the card waited does not strand the approval'
);

select extensions.is(
  (select payload->>'task_closed' from public.events
    where verb = 'campaign.materialised'
      and subject_id = (select id from public.campaigns where source_embed_id = pg_temp.cid('c_taskdone'))),
  'false',
  'and the event says the approval did not close it, so a skipped transition is visible rather than silent'
);

-- ------------------------------------------------------------------ privilege

select extensions.ok(
  not has_function_privilege('authenticated', 'public.materialise_campaign(uuid)', 'EXECUTE'),
  'a client cannot call the writer directly: containment here is the grant, not the schema'
);

select extensions.ok(
  has_function_privilege('service_role', 'private.campaign_state_is_terminal(public.campaign_state)', 'EXECUTE'),
  'service_role can execute the terminal-state helper, without which every commit fails at the spend check'
);

select * from extensions.finish();

rollback;
