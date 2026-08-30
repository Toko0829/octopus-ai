-- The marketing domain: RLS, privileges, the campaign machine, and the ad tree.
-- Covers 20260829120000, 20260829121000, 20260829122000, 20260829123000.
--
-- Two halves, and the split is the same one `rls_workflow.sql` makes for the same
-- two reasons.
--
-- The RLS and privilege half runs **as `authenticated` with `request.jwt.claims`
-- set**, exactly as PostgREST would. Testing it as `postgres` proves nothing,
-- because that role bypasses RLS, which is precisely how a policy bug survives
-- review.
--
-- The trigger half runs **as `postgres` on purpose**. The campaign machine and the
-- ad-tree guard are triggers, so they must bind trusted server code and superuser
-- alike. If those assertions ever start passing merely because the caller was
-- privileged, the guard has been lost.
--
-- One assertion here is the shape of an error rather than a count, and it is the
-- one worth reading twice: `channel_connections` must answer `permission denied`
-- to a client, **not zero rows**. The absence of the grant is the control. Zero
-- rows is what a broken policy looks like and an error is what a deliberate
-- refusal looks like, and this repository has already lost 47 tasks and 28
-- artifacts to those two being indistinguishable through PostgREST
-- (`20260827110000`).
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/marketing_rls.sql

begin;

select extensions.plan(42);

-- ---------------------------------------------------------------- fixtures

create temporary table mids (k text primary key, v uuid);
insert into mids (k, v) values
  ('owner',          gen_random_uuid()),
  ('member',         gen_random_uuid()),
  ('expired',        gen_random_uuid()),
  ('outsider',       gen_random_uuid()),
  ('project',        gen_random_uuid()),
  ('other_project',  gen_random_uuid()),
  ('room',           gen_random_uuid()),
  ('other_room',     gen_random_uuid()),
  ('task',           gen_random_uuid()),
  ('c1',             gen_random_uuid()),
  ('c2',             gen_random_uuid()),
  ('other_campaign', gen_random_uuid()),
  ('ae_campaign',    gen_random_uuid()),
  ('ae_adset',       gen_random_uuid()),
  ('ae_ad',          gen_random_uuid()),
  ('conn',           gen_random_uuid());

create or replace function pg_temp.mid(text) returns uuid language sql stable as
  $$ select v from mids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.mid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@marketing-test.invalid', '', now(), now(), now()
from (values ('owner'), ('member'), ('expired'), ('outsider')) as t(k);

insert into public.projects (id, owner_id, goal, status, budget_ceiling)
values (pg_temp.mid('project'), pg_temp.mid('owner'),
        'get my first 100 customers', 'active', 5000.00),
       (pg_temp.mid('other_project'), pg_temp.mid('outsider'),
        'someone else''s venture', 'active', 1000.00);

insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.mid('room'), 'Marketing room', pg_temp.mid('owner'), pg_temp.mid('project')),
       (pg_temp.mid('other_room'), 'Other room', pg_temp.mid('outsider'), pg_temp.mid('other_project'));

insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.mid('room'), pg_temp.mid('owner'),   'user',       'room', null),
       (pg_temp.mid('room'), pg_temp.mid('member'),  'human_node', 'room', now() + interval '1 day'),
       (pg_temp.mid('room'), pg_temp.mid('expired'), 'human_node', 'room', now() - interval '1 hour'),
       (pg_temp.mid('other_room'), pg_temp.mid('outsider'), 'user', 'room', null);

insert into public.tasks (id, project_id, title, owner_type, state, risk_tier)
values (pg_temp.mid('task'), pg_temp.mid('project'), 'Launch the ad campaign',
        'ai', 'pending', 'high_risk');

insert into public.campaigns (id, project_id, task_id, name, channel, state, budget_cap)
values (pg_temp.mid('c1'), pg_temp.mid('project'), pg_temp.mid('task'),
        'Cold traffic, Meta', 'meta', 'draft', 500.00),
       (pg_temp.mid('c2'), pg_temp.mid('project'), null,
        'Welcome sequence', 'email', 'draft', null);

insert into public.campaigns (id, project_id, name, channel, state)
values (pg_temp.mid('other_campaign'), pg_temp.mid('other_project'),
        'Not ours', 'google', 'draft');

-- A well-formed tree: campaign -> ad_set -> ad.
insert into public.ad_entities (id, campaign_id, project_id, parent_id, kind, state)
values (pg_temp.mid('ae_campaign'), pg_temp.mid('c1'), pg_temp.mid('project'),
        null, 'campaign', 'draft'),
       (pg_temp.mid('ae_adset'), pg_temp.mid('c1'), pg_temp.mid('project'),
        pg_temp.mid('ae_campaign'), 'ad_set', 'draft'),
       (pg_temp.mid('ae_ad'), pg_temp.mid('c1'), pg_temp.mid('project'),
        pg_temp.mid('ae_adset'), 'ad', 'draft');

insert into public.campaign_outcomes
  (campaign_id, project_id, period_start, period_end, spend, clicks, source)
values (pg_temp.mid('c1'), pg_temp.mid('project'),
        now() - interval '2 days', now() - interval '1 day', 42.50, 310, 'pull_metrics'),
       (pg_temp.mid('c1'), pg_temp.mid('project'),
        now() - interval '1 day', now(), 51.00, 402, 'pull_metrics');

-- A connection in the owner's own room, holding a worthless fake token. It exists
-- so the refusal below is a refusal to read a row that is genuinely there.
insert into public.channel_connections
  (id, room_id, connected_by, provider, channel, external_account_id, granted_scopes, access_token)
values (pg_temp.mid('conn'), pg_temp.mid('room'), pg_temp.mid('owner'),
        'fake', 'meta', 'act_000', array['ads_management'], 'fake-token-not-a-secret');

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.mcount_as(p_user uuid, p_sql text)
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

-- Helper: the SQLSTATE a statement raises when run as a given user, or null if it
-- succeeds. Returns the code rather than a boolean for `errcode_of`'s reason: "it
-- threw something" would also pass for a typo'd table name, which would make a
-- refusal look enforced when the test never reached it.
create or replace function pg_temp.merrcode_as(p_user uuid, p_sql text)
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

create or replace function pg_temp.merrcode_of(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- --------------------------------------------------------------- campaigns

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('owner'), 'select count(*) from public.campaigns'),
  2::bigint,
  'owner sees every campaign in their project and none from another'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('member'), 'select count(*) from public.campaigns'),
  2::bigint,
  'an unexpired node sees the campaigns of the project it is engaged on'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('expired'), 'select count(*) from public.campaigns'),
  0::bigint,
  'an EXPIRED node sees no campaign: time-boxed access expires for spend as well as chat'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('outsider'), 'select count(*) from public.campaigns'),
  1::bigint,
  'an outsider sees only their own campaign, never ours'
);

-- ------------------------------------------------------------- ad_entities

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('owner'), 'select count(*) from public.ad_entities'),
  3::bigint,
  'owner sees the whole ad tree of their campaign'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('outsider'), 'select count(*) from public.ad_entities'),
  0::bigint,
  'an outsider sees no ad entities: what somebody is targeting is itself information'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('expired'), 'select count(*) from public.ad_entities'),
  0::bigint,
  'an expired node sees no ad entities'
);

-- -------------------------------------------------------- campaign_outcomes

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('owner'), 'select count(*) from public.campaign_outcomes'),
  2::bigint,
  'owner reads their own performance: this is the table the person paying looks at'
);

select extensions.is(
  pg_temp.mcount_as(pg_temp.mid('outsider'), 'select count(*) from public.campaign_outcomes'),
  0::bigint,
  'an outsider sees no outcomes'
);

-- ----------------------------------------------------- channel_connections
--
-- The grant absence IS the assertion. `42501` is insufficient_privilege.

select extensions.is(
  pg_temp.merrcode_as(pg_temp.mid('owner'),
    'select count(*) from public.channel_connections'),
  '42501',
  'a client is REFUSED channel_connections rather than shown zero rows, and the owner '
  'of the very room is refused too: the table holds tokens and RLS filters rows, not columns'
);

select extensions.is(
  pg_temp.merrcode_as(pg_temp.mid('outsider'),
    'select count(*) from public.channel_connections'),
  '42501',
  'an outsider is refused the same way, so the refusal is not a policy that could be widened'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.channel_connections', 'SELECT'),
  'authenticated holds no SELECT on channel_connections'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.channel_connections', 'SELECT'),
  'anon holds no SELECT on channel_connections'
);

-- ------------------------------------------------- privileges (not RLS)
--
-- TRUNCATE is checked on all four explicitly. `grant all` includes it, it is not
-- row-level, and it ignores RLS entirely, so a role holding it can empty a table
-- whatever the policies say. That is the defect `20260812120100` closed for `anon`
-- and it arrives by a new door every time somebody adds a table.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.campaigns', 'TRUNCATE'),
  'authenticated cannot TRUNCATE campaigns'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.channel_connections', 'TRUNCATE'),
  'authenticated cannot TRUNCATE channel_connections'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.ad_entities', 'TRUNCATE'),
  'authenticated cannot TRUNCATE ad_entities'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.campaign_outcomes', 'TRUNCATE'),
  'authenticated cannot TRUNCATE campaign_outcomes'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.campaigns', 'INSERT'),
  'authenticated cannot INSERT a campaign: campaigns are server-written'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.campaigns', 'UPDATE'),
  'authenticated cannot UPDATE a campaign: a client could otherwise raise its own budget_cap'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.campaign_outcomes', 'UPDATE'),
  'campaign_outcomes is append-only even for trusted code: a rewritable training signal is not evidence'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.campaign_outcomes', 'DELETE'),
  'an outcome cannot be deleted, including by the server that wrote it'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.campaign_outcomes', 'TRUNCATE'),
  'service_role cannot TRUNCATE the outcomes either, which is the revoke people forget'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.campaigns', 'SELECT'),
  'anon has no read access to marketing data'
);

-- --------------------------------------------- the campaign state machine
--
-- Run as postgres. These guards must bind trusted code, not merely clients.

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''live'' where id = %L', pg_temp.mid('c1'))),
  '23514',
  'draft -> live is refused: claiming live before the platform confirmed puts an '
  'untrue sentence in the audit trail'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''ready'' where id = %L', pg_temp.mid('c1'))),
  null::text,
  'draft -> ready is allowed'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''publishing'' where id = %L', pg_temp.mid('c1'))),
  null::text,
  'ready -> publishing is allowed'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''live'' where id = %L', pg_temp.mid('c1'))),
  null::text,
  'publishing -> live is allowed once the platform has confirmed'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''cancelled'' where id = %L', pg_temp.mid('c1'))),
  '23514',
  'live -> cancelled is refused: a spending campaign is paused first, so stopping the '
  'money and closing the record stay two acts with two events'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''paused'', pause_reason = ''kill_switch'' where id = %L',
    pg_temp.mid('c1'))),
  null::text,
  'the kill switch reaches a live campaign'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set pause_reason = ''user'' where id = %L', pg_temp.mid('c1'))),
  null::text,
  'an update that does not change state is not treated as a transition to itself'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''cancelled'' where id = %L', pg_temp.mid('c1'))),
  null::text,
  'paused -> cancelled is allowed'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'update public.campaigns set state = ''live'' where id = %L', pg_temp.mid('c1'))),
  '23514',
  'terminal means terminal: a cancelled campaign cannot start spending again'
);

select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.mid('c1') and verb = 'campaign.transitioned'),
  5::bigint,
  'every state change wrote an audit event, and the pause_reason edit did not'
);

-- ------------------------------------------------------- the ad tree

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.ad_entities (campaign_id, project_id, parent_id, kind) '
    'values (%L, %L, %L, ''ad'')',
    pg_temp.mid('c1'), pg_temp.mid('project'), pg_temp.mid('ae_campaign'))),
  '23514',
  'an ad cannot hang off a campaign: skipping the ad set skips the targeting it carries'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.ad_entities (campaign_id, project_id, parent_id, kind) '
    'values (%L, %L, %L, ''ad_set'')',
    pg_temp.mid('c2'), pg_temp.mid('project'), pg_temp.mid('ae_campaign'))),
  '23503',
  'a parent in another campaign is refused: a campaign you cannot pause as a whole '
  'is not a unit of anything'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.ad_entities (campaign_id, project_id, kind) values (%L, %L, ''ad_set'')',
    pg_temp.mid('c1'), pg_temp.mid('project'))),
  '23514',
  'an ad_set with no parent is refused by the check constraint'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.ad_entities (campaign_id, project_id, parent_id, kind) '
    'values (%L, %L, %L, ''campaign'')',
    pg_temp.mid('c1'), pg_temp.mid('project'), pg_temp.mid('ae_adset'))),
  '23514',
  'a campaign-kind entity cannot have a parent: the root of the tree is the root'
);

-- --------------------------------------------------- outcome idempotency

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.campaign_outcomes '
    '(campaign_id, project_id, period_start, period_end, spend, source) '
    'select campaign_id, project_id, period_start, period_end, spend, source '
    'from public.campaign_outcomes where campaign_id = %L limit 1',
    pg_temp.mid('c1'))),
  '23505',
  'the same period pulled twice is refused: a doubled spend is the number the '
  'optimizer reads when it decides whether to pause'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.campaign_outcomes '
    '(campaign_id, project_id, period_start, period_end, spend, source) '
    'select campaign_id, project_id, period_start, period_end, spend, ''manual'' '
    'from public.campaign_outcomes where campaign_id = %L limit 1',
    pg_temp.mid('c1'))),
  null::text,
  'a manual correction for the same period is a NEW row, so both numbers survive'
);

-- --------------------------------------------------- the source guard

-- `20260829160000`, landing with the metrics sweep on the ordering this domain
-- already follows. `source` is part of the unique key rather than a label, so an
-- unrecognised value collides with nothing and would silently append a second
-- copy of a window on every pass.

select extensions.ok(
  exists (
    select 1 from pg_constraint
    where conname = 'campaign_outcomes_source_check'
      and conrelid = 'public.campaign_outcomes'::regclass
  ),
  'campaign_outcomes constrains its source rather than documenting it in a comment'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.campaign_outcomes '
    '(campaign_id, project_id, period_start, period_end, spend, source) '
    'values (%L, %L, now() - interval ''3 days'', now() - interval ''2 days'', 1.00, ''metrics'')',
    pg_temp.mid('c1'), pg_temp.mid('project'))),
  '23514',
  'a source the writers do not use is refused: it would not collide with anything '
  'and would double a measured period'
);

select extensions.is(
  pg_temp.merrcode_of(format(
    'insert into public.campaign_outcomes '
    '(campaign_id, project_id, period_start, period_end, spend, source) '
    'values (%L, %L, now() - interval ''4 days'', now() - interval ''3 days'', 1.00, ''manual'')',
    pg_temp.mid('c1'), pg_temp.mid('project'))),
  null::text,
  'both documented values are accepted, including the one whose writer has not landed yet'
);

select * from extensions.finish();

rollback;
