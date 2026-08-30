-- The CPA ceiling column, its constraints, and the arcs the optimizer leans on.
-- Covers 20260830120000, plus the two transition facts the sweep's failure map
-- and epoch keys are built against.
--
-- **Everything here runs as `postgres` on purpose**, the `ad_entity_guard.sql`
-- split: these are constraints and triggers whose whole job is to bind trusted
-- server code, since the sweep and the ceiling route are service-role from end
-- to end. Row visibility on `campaigns` is `marketing_rls.sql`'s and is not
-- re-asserted here.
--
-- Three properties carry the file.
--
-- **A ceiling of zero is refused.** It would pause on the first recorded cent
-- whatever the conversions say, which is a kill switch wearing the shape of a
-- threshold; the contract refuses it too, and this half is what stops the two
-- drifting.
--
-- **`live -> failed` does not exist.** The sweep's failure map promises that no
-- pause failure ever closes a campaign, and this is the arc that promise leans
-- on: the doctrine is enforced by the machine, not by discipline.
--
-- **A transition writes the event the epoch counts.** The pause key's epoch is
-- the count of `paused -> live` transitions in `events`, so if the trigger ever
-- stopped writing them, a resumed campaign's second breach would replay the
-- first pause's key. The payload's `from`/`to`/`pause_reason` are asserted by
-- value because the sweep filters on exactly those keys.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/campaign_optimize.sql

begin;

select extensions.plan(18);

-- ---------------------------------------------------------------- fixtures

create temporary table coids (k text primary key, v uuid);
insert into coids (k, v) values
  ('owner',   gen_random_uuid()),
  ('project', gen_random_uuid()),
  ('c1',      gen_random_uuid()),
  ('c2',      gen_random_uuid()),
  ('c3',      gen_random_uuid());

create or replace function pg_temp.coid(text) returns uuid language sql stable as
  $$ select v from coids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.coid('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'owner@campaign-optimize-test.invalid', '', now(), now(), now());

insert into public.projects (id, owner_id, goal, status, budget_ceiling)
values (pg_temp.coid('project'), pg_temp.coid('owner'),
        'launch and grow my app', 'active', 5000.00);

-- c1 walks live -> paused -> live. c2 exists to prove live -> failed is not an
-- arc. c3 takes the ceiling constraint's edge cases so c1's state stays clean.
insert into public.campaigns (id, project_id, name, channel, state, budget_cap)
values
  (pg_temp.coid('c1'), pg_temp.coid('project'), 'Launch campaign',  'meta', 'live', 400.00),
  (pg_temp.coid('c2'), pg_temp.coid('project'), 'Second campaign',  'meta', 'live', 400.00),
  (pg_temp.coid('c3'), pg_temp.coid('project'), 'Draft campaign',   'meta', 'draft', null);

-- Helper: the SQLSTATE a statement raises, or null if it succeeds. The code
-- rather than a boolean, so a typo'd column cannot pass as an enforced refusal.
create or replace function pg_temp.coerr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ------------------------------------------------------- the column itself

select extensions.has_column('public', 'campaigns', 'cpa_ceiling',
  'campaigns.cpa_ceiling exists: the optimizer finally has an input');

select extensions.col_type_is('public', 'campaigns', 'cpa_ceiling', 'numeric(12,2)',
  'cpa_ceiling is money-shaped, matching budget_cap');

select extensions.col_is_null('public', 'campaigns', 'cpa_ceiling',
  'cpa_ceiling is nullable, and NULL abstains rather than blocks: the documented '
  'inversion of the budget columns');

-- ------------------------------------------------- the positive constraint

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set cpa_ceiling = 15.00 where id = %L', pg_temp.coid('c3'))),
  null::text,
  'a positive ceiling is accepted');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set cpa_ceiling = null where id = %L', pg_temp.coid('c3'))),
  null::text,
  'clearing the ceiling is accepted: withdrawing the instruction to judge is legal');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set cpa_ceiling = 0 where id = %L', pg_temp.coid('c3'))),
  '23514',
  'a ceiling of 0 is refused: it would pause on the first cent regardless of conversions');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set cpa_ceiling = -5.00 where id = %L', pg_temp.coid('c3'))),
  '23514',
  'a negative ceiling is refused');

-- ---------------------------------------------- the pause_reason vocabulary

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = ''kill_switch'' where id = %L',
    pg_temp.coid('c3'))),
  null::text,
  'kill_switch is a legal reason, although nothing writes it yet: the constraint '
  'enforces the design rather than today''s writers');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = ''cpa_breach'' where id = %L',
    pg_temp.coid('c3'))),
  null::text,
  'cpa_breach is a legal reason: the optimize sweep''s value');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = ''user'' where id = %L', pg_temp.coid('c3'))),
  null::text,
  'user is a legal reason');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = ''optimizer'' where id = %L',
    pg_temp.coid('c3'))),
  null::text,
  'optimizer is a legal reason');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = ''cpa-breach'' where id = %L',
    pg_temp.coid('c3'))),
  '23514',
  'a typo is refused: the panel branches on this value, so a misspelt reason would '
  'render as a paused campaign with no explanation');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set pause_reason = null where id = %L', pg_temp.coid('c3'))),
  null::text,
  'null is legal: a campaign that is not paused carries no reason');

-- --------------------------------------------- the arcs the sweep leans on

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set state = ''paused'', pause_reason = ''cpa_breach'' '
    'where id = %L', pg_temp.coid('c1'))),
  null::text,
  'live -> paused with the reason in the same update is the sweep''s write, and it is legal');

select extensions.is(
  (select count(*) from public.events
    where verb = 'campaign.transitioned'
      and subject_id = pg_temp.coid('c1')
      and payload->>'from' = 'live'
      and payload->>'to' = 'paused'
      and payload->>'pause_reason' = 'cpa_breach')::int,
  1,
  'the trigger recorded the pause with the reason, under exactly the payload keys '
  'the resume epoch filters on');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set state = ''live'', pause_reason = null where id = %L',
    pg_temp.coid('c1'))),
  null::text,
  'paused -> live with the reason cleared in the same update is the resume, and it is legal');

select extensions.is(
  (select count(*) from public.events
    where verb = 'campaign.transitioned'
      and subject_id = pg_temp.coid('c1')
      and payload->>'from' = 'paused'
      and payload->>'to' = 'live')::int,
  1,
  'the resume transition is recorded too, which is the row the pause epoch counts: '
  'lose it and a second breach replays the first pause''s key');

select extensions.is(
  pg_temp.coerr(format(
    'update public.campaigns set state = ''failed'' where id = %L', pg_temp.coid('c2'))),
  '23514',
  'live -> failed does not exist: no pause failure can close a campaign, by machine '
  'rather than by discipline');

select * from extensions.finish();

rollback;
