-- Node onboarding tests — covers 20260902120000 … 20260902122000.
--
-- The writers `marketplace_rls.sql` said did not exist. That file asserts the
-- guards a domain with no writer can have; this one asserts the two functions
-- that finally write, and the lifecycle map that arrived with them.
--
-- **A separate file rather than more assertions in `marketplace_rls.sql`**, whose
-- `plan(46)` is exact and whose subject is deliberately "these tables have no
-- writer". Growing that file would have meant editing a suite whose point is
-- what it pins about an earlier slice.
--
-- Everything here runs as `postgres`, and that is the right role rather than a
-- shortcut. Both functions are granted to `service_role` alone and the trigger
-- they pass through binds every role including that one, so a suite running as
-- `authenticated` would be testing a path nobody will ever take. The privilege
-- assertions at the end are the exception that proves it: they check that the
-- client roles still cannot reach any of this, which is a statement about
-- grants rather than about behaviour.
--
-- One trap this file is written around, recorded in supabase/README.md:63. A
-- function that inserts, called from the same statement that reads the table it
-- inserted into, sees the pre-statement snapshot and reads back nothing. So
-- every write and the assertion about it are **separate statements**, which is
-- what `select extensions.is(...)` per assertion gives for free.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/node_onboarding.sql

begin;

select extensions.plan(36);

-- ---------------------------------------------------------------- fixtures

create temporary table noids (k text primary key, v uuid);
insert into noids (k, v) values
  ('invited',  gen_random_uuid()),
  ('refused',  gen_random_uuid()),
  ('boss',     gen_random_uuid()),
  ('stranger', gen_random_uuid());

create or replace function pg_temp.noid(text) returns uuid language sql stable as
  $$ select v from noids where k = $1 $$;

-- `handle_new_user` provisions the profile, so these four exist at role 'user'.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.noid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@onboarding.invalid', '', now(), now(), now()
from (values ('invited'), ('refused'), ('boss'), ('stranger')) as t(k);

update public.profiles set role = 'ops' where user_id = pg_temp.noid('boss');

-- Claims cleared so the audit trigger files these as `system`, which is what a
-- service_role connection actually produces.
select set_config('request.jwt.claims', '', true);

/** SQLSTATE of a failing statement, or null when it succeeded. */
create or replace function pg_temp.noerr(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end;
$$;

-- ------------------------------------------------- the map, on its own terms
--
-- Asserted directly rather than only through the trigger, so a broken arc names
-- itself instead of surfacing as a failed write three assertions later.

select extensions.ok(
  private.node_kyc_transition_allowed('unverified', 'pending'),
  'a node can submit: unverified -> pending'
);

select extensions.ok(
  private.node_kyc_transition_allowed('pending', 'verified'),
  'a check that passed verifies them: pending -> verified'
);

select extensions.ok(
  private.node_kyc_transition_allowed('pending', 'rejected'),
  'a check that failed refuses them: pending -> rejected'
);

select extensions.ok(
  private.node_kyc_transition_allowed('pending', 'unverified'),
  'a check that could not decide returns them to the start with a way forward: '
  'pending -> unverified, which is why this is not the same arc as rejected'
);

select extensions.ok(
  private.node_kyc_transition_allowed('rejected', 'pending'),
  'a refusal is appealable by resubmitting: rejected -> pending, so nothing here is terminal'
);

select extensions.ok(
  not private.node_kyc_transition_allowed('unverified', 'verified'),
  'nobody is verified without being checked: submission has to precede a decision, '
  'and that is enforced in Postgres rather than in the order the route happens to work'
);

select extensions.ok(
  not private.node_kyc_transition_allowed('verified', 'suspended'),
  'suspension has no arc, because it has no writer until an ops console exists: '
  'a map permitting an unmakeable transition is the task_deps defect'
);

select extensions.ok(
  not private.node_kyc_transition_allowed('suspended', 'verified'),
  'and no way back out of it either, for the same reason'
);

select extensions.ok(
  not private.node_kyc_transition_allowed('verified', 'pending'),
  'a verified node cannot re-submit: re-verification and renewal are an ops concern '
  'with no writer, so they get their arc from the slice that first performs one'
);

select extensions.ok(
  not private.node_kyc_transition_allowed('rejected', 'verified'),
  'and a refusal cannot be reversed in place, only appealed through pending'
);

-- ------------------------------------------------------------- invite_node

select extensions.is(
  pg_temp.noerr(format(
    'select public.invite_node(%L, array[''US-TX''], array[''en''])', pg_temp.noid('invited'))),
  null,
  'invite_node creates a node'
);

select extensions.is(
  (select kyc_status::text || '/' || availability::text
   from public.node_profiles where user_id = pg_temp.noid('invited')),
  'unverified/paused',
  'an invited node starts unverified and paused: an invitation is not a verification'
);

select extensions.is(
  (select role::text from public.profiles where user_id = pg_temp.noid('invited')),
  'human_node',
  'and is promoted, which is profiles.role''s first writer since 20260724000000. The guard '
  'from 20260831110000 does not fire because auth.uid() is null under service_role'
);

select extensions.is(
  (select count(*) from public.events
   where verb = 'node.invited' and subject_id = pg_temp.noid('invited')),
  1::bigint,
  'the invitation is audited in its own right: it changes no kyc_status, so without this '
  'row the act of admitting somebody to paid work would leave no trail at all'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.invite_node(%L, array[''FR''], array[''fr''])', pg_temp.noid('invited'))),
  null,
  'a re-invite is not an error: an operator re-running after a network failure gets the same row'
);

select extensions.is(
  (select array_to_string(service_jurisdictions, ',')
   from public.node_profiles where user_id = pg_temp.noid('invited')),
  'US-TX',
  'and does not clobber what the node has since set on their own surface'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.invite_node(%L, array[''US''], array[''en''])', pg_temp.noid('boss'))),
  '42501',
  'an invite never demotes: an ops account is refused rather than turned into a node, '
  'because a promotion that runs backwards is a privilege bug wearing an onboarding shape'
);

select extensions.is(
  pg_temp.noerr(
    'select public.invite_node(''00000000-0000-0000-0000-0000000000ff'', array[''US''], array[''en''])'),
  'P0002',
  'an invitation attaches to an account and never creates one'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.invite_node(%L, array[]::text[], array[''en''])', pg_temp.noid('refused'))),
  '22023',
  'a node who serves nowhere can never be matched, so inviting one is refused rather than '
  'stored: that is the cold-start dead end this ordering exists to avoid'
);

-- ---------------------------------------------------------- decide_node_kyc

select extensions.is(
  pg_temp.noerr(format(
    'select public.decide_node_kyc(%L, ''fake'', ''[{"kind":"document","result":"passed"}]''::jsonb, ''k0'')',
    pg_temp.noid('invited'))),
  '23514',
  'a node who never submitted cannot be verified: the decision passes through the map, '
  'so the route''s ordering is enforced by Postgres and not merely observed by it'
);

update public.node_profiles set kyc_status = 'pending' where user_id = pg_temp.noid('invited');

select extensions.is(
  public.decide_node_kyc(pg_temp.noid('invited'), 'fake',
    '[{"kind":"document","result":"passed"},{"kind":"liveness","result":"passed"},
      {"kind":"sanctions_pep","result":"passed"}]'::jsonb, 'k1')::text,
  'verified',
  'three passing checks verify a node'
);

select extensions.is(
  (select count(*) from public.node_verifications where node_id = pg_temp.noid('invited')),
  3::bigint,
  'one row per check, appended'
);

select extensions.is(
  public.decide_node_kyc(pg_temp.noid('invited'), 'fake',
    '[{"kind":"document","result":"passed"},{"kind":"liveness","result":"passed"},
      {"kind":"sanctions_pep","result":"passed"}]'::jsonb, 'k1')::text,
  'verified',
  'a replay converges on the same verdict, because it is derived from the recorded rows '
  'rather than from the payload: the table has no UPDATE, so the read has to be the truth'
);

select extensions.is(
  (select count(*) from public.node_verifications where node_id = pg_temp.noid('invited')),
  3::bigint,
  'and appends nothing, because insert ... on conflict do nothing is the only idiom '
  'service_role has here'
);

select extensions.is(
  (select count(*) from public.events
   where verb = 'node.kyc_status_changed' and subject_id = pg_temp.noid('invited')),
  2::bigint,
  'two transitions, two audit rows, and the replay wrote no third: the trigger''s when clause '
  'is what stops an event describing a transition that did not happen'
);

select extensions.is(
  pg_temp.noerr(format(
    'update public.node_profiles set availability = ''available'' where user_id = %L',
    pg_temp.noid('invited'))),
  null,
  'a verified node can put themselves in the pool'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.decide_node_kyc(%L, ''fake'', ''[{"kind":"vibes","result":"passed"}]''::jsonb, ''k9'')',
    pg_temp.noid('invited'))),
  '22P02',
  'an unknown check kind raises rather than being skipped: a payload can arrive from an older '
  'service or a hand edit, and guessing is how a verification nobody performed gets recorded'
);

-- The unhappy paths, on a second node so the counts above stay readable.
select public.invite_node(pg_temp.noid('refused'), array['US'], array['en']);
update public.node_profiles set kyc_status = 'pending' where user_id = pg_temp.noid('refused');

select extensions.is(
  public.decide_node_kyc(pg_temp.noid('refused'), 'fake',
    '[{"kind":"document","result":"failed"},{"kind":"liveness","result":"passed"}]'::jsonb, 'k2')::text,
  'rejected',
  'one failed check refuses the node, whatever else passed'
);

select extensions.is(
  pg_temp.noerr(format(
    'update public.node_profiles set availability = ''available'' where user_id = %L',
    pg_temp.noid('refused'))),
  '23514',
  'and a refused node cannot put themselves in the pool: available_requires_kyc is the one '
  'eligibility rule with no second layer behind it'
);

update public.node_profiles set kyc_status = 'pending' where user_id = pg_temp.noid('refused');

select extensions.is(
  public.decide_node_kyc(pg_temp.noid('refused'), 'fake',
    '[{"kind":"document","result":"inconclusive"}]'::jsonb, 'k3')::text,
  'unverified',
  'a provider that could not decide returns them to the start rather than refusing them: '
  'our own uncertainty must not read as an accusation'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.decide_node_kyc(%L, ''fake'', ''[]''::jsonb, ''k4'')', pg_temp.noid('refused'))),
  '22023',
  'no checks is not a verdict: an empty array cannot be allowed to derive verified from an absence'
);

select extensions.is(
  pg_temp.noerr(format(
    'select public.decide_node_kyc(%L, ''fake'', ''[{"kind":"document","result":"passed"}]''::jsonb, ''k5'')',
    pg_temp.noid('stranger'))),
  'P0002',
  'and a user who was never invited has no record to decide about'
);

-- ------------------------------------------------- the guards still holding
--
-- The writers landed with no grant changes at all, which is the property worth
-- pinning: `marketplace_rls.sql` should still be 46/46 after this migration.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_profiles', 'INSERT'),
  'a writer arrived and registering as a node is still a server decision'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_verifications', 'SELECT'),
  'the subject of a verification record is still refused it, because it can name a third party'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.node_verifications', 'UPDATE'),
  'and service_role still cannot rewrite one, which is what forced the append-only design'
);

select extensions.ok(
  not has_function_privilege('authenticated', 'public.invite_node(uuid, text[], text[])', 'EXECUTE'),
  'invite_node is reachable by service_role alone: there is no self-service path to becoming a node'
);

select * from extensions.finish();
rollback;
