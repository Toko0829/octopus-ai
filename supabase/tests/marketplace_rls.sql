-- Marketplace domain tests — covers 20260831120000 … 20260831123000.
--
-- The slice has **no writer**, so its only caller today is this file. That is
-- what makes four tables landing ahead of their writers defensible rather than
-- dead: every constraint and both triggers are exercised here.
--
-- Two halves, split the way `marketing_rls.sql` splits them and for the same
-- reasons.
--
--   * The **RLS and privilege half** runs as `authenticated` with
--     `request.jwt.claims` set, exactly as PostgREST would. Running it as
--     `postgres` would prove nothing: that role bypasses RLS entirely, which is
--     precisely how a policy bug survives review.
--   * The **constraint and trigger half** runs as `postgres` on purpose. These are
--     checks and triggers, not policies: their whole job is to bind trusted server
--     code, since `service_role` is the only role that will ever write here. A
--     guard that only refused clients would refuse nobody who was ever going to
--     write this table.
--
-- Row visibility for the marketing tables is `marketing_rls.sql`'s and is not
-- re-asserted. Everything is inside a transaction that ROLLBACKs, so the fixtures
-- never persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/marketplace_rls.sql

begin;

select extensions.plan(46);

-- ---------------------------------------------------------------- fixtures

create temporary table npids (k text primary key, v uuid);
insert into npids (k, v) values
  ('owner',    gen_random_uuid()),
  ('nodeA',    gen_random_uuid()),
  ('nodeB',    gen_random_uuid()),
  ('expired',  gen_random_uuid()),
  ('outsider', gen_random_uuid()),
  ('room',     gen_random_uuid());

create or replace function pg_temp.npid(text) returns uuid language sql stable as
  $$ select v from npids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.npid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@marketplace.invalid', '', now(), now(), now()
from (values ('owner'), ('nodeA'), ('nodeB'), ('expired'), ('outsider')) as t(k);

insert into public.rooms (id, name, owner_id)
values (pg_temp.npid('room'), 'Marketplace test room', pg_temp.npid('owner'));

-- nodeA shares a room with the owner. That is the case worth having: the owner
-- can see this person in the member list and must still see nothing of their
-- node profile, because the counterparty policy is deliberately absent.
insert into public.room_members (room_id, user_id, role, scope, expires_at)
values (pg_temp.npid('room'), pg_temp.npid('owner'),   'user',       'room', null),
       (pg_temp.npid('room'), pg_temp.npid('nodeA'),   'human_node', 'room', now() + interval '1 day'),
       (pg_temp.npid('room'), pg_temp.npid('expired'), 'human_node', 'room', now() - interval '1 hour');

insert into public.node_profiles (user_id, kyc_status, availability, service_jurisdictions,
                                  languages, rate, rate_period)
values (pg_temp.npid('nodeA'), 'verified', 'available', array['US-TX', 'US-TX-AUSTIN'],
        array['en'], 120.00, 'hour'),
       (pg_temp.npid('nodeB'), 'unverified', 'paused', array['US'], array['en'], null, null);

insert into public.node_skills (node_id, skill_tag, verified, verified_at)
values (pg_temp.npid('nodeA'), 'paid-ads', true, now()),
       (pg_temp.npid('nodeA'), 'notary:US-TX', false, null);

insert into public.node_credentials (node_id, kind, jurisdiction, licence_number,
                                     verified, verified_at, evidence_path)
values (pg_temp.npid('nodeA'), 'notary', 'US-TX', 'TX-12345',
        true, now(), 'node-credentials/' || pg_temp.npid('nodeA') || '/notary.pdf');

insert into public.node_verifications (node_id, kind, provider, result, matched_node_id)
values (pg_temp.npid('nodeA'), 'face_search', 'fake', 'passed', pg_temp.npid('nodeB'));

-- Helper: run a count as a given user, exactly as PostgREST would.
create or replace function pg_temp.npcount_as(p_user uuid, p_sql text)
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

-- Helper: the SQLSTATE a statement raises as a given user, or null if it
-- succeeds. The code rather than a boolean, so a typo'd table name cannot pass as
-- an enforced refusal. The role is reset on both paths.
create or replace function pg_temp.nperr_as(p_user uuid, p_sql text)
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

-- Helper: the SQLSTATE a statement raises as `postgres`. For the constraint and
-- trigger half, where being privileged is the point.
create or replace function pg_temp.nperr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ------------------------------------------- node_profiles visibility (5)
--
-- Four of these five answers are zero, and that is the point. This family is
-- asserted with the answers THIS table should give rather than copied from the
-- marketing suite, where a member seeing the row is the whole purpose.

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeA'), 'select count(*) from public.node_profiles'),
  1::bigint,
  'a node sees exactly one node profile: their own'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeB'), format(
    'select count(*) from public.node_profiles where user_id = %L', pg_temp.npid('nodeA'))),
  0::bigint,
  'one node cannot read another node''s profile: the pool is not a directory'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('owner'), format(
    'select count(*) from public.node_profiles where user_id = %L', pg_temp.npid('nodeA'))),
  0::bigint,
  'the owner shares a room with this node and still sees nothing of its profile: the '
  'counterparty policy is deliberately absent until engagements exist to join through'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('expired'), 'select count(*) from public.node_profiles'),
  0::bigint,
  'an expired member sees no node profile at all'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('outsider'), 'select count(*) from public.node_profiles'),
  0::bigint,
  'an outsider sees no node profile at all'
);

-- ------------------------------- node_skills / node_credentials own-row (6)

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeA'), 'select count(*) from public.node_skills'),
  2::bigint,
  'a node reads its own skills, claimed and verified alike'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeB'), 'select count(*) from public.node_skills'),
  0::bigint,
  'one node cannot read another node''s skills'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('expired'), 'select count(*) from public.node_skills'),
  0::bigint,
  'an expired member reads no skills'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeA'), 'select count(*) from public.node_credentials'),
  1::bigint,
  'a node reads its own licence'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('nodeB'), 'select count(*) from public.node_credentials'),
  0::bigint,
  'one node cannot read another node''s licence'
);

select extensions.is(
  pg_temp.npcount_as(pg_temp.npid('outsider'), 'select count(*) from public.node_credentials'),
  0::bigint,
  'an outsider reads no licence'
);

-- --------------------- node_verifications is REFUSED, not empty (4)
--
-- The grant absence IS the assertion. `42501` is insufficient_privilege, and the
-- distinction matters because zero rows is what a policy bug looks like while an
-- error is what a deliberate refusal looks like.

select extensions.is(
  pg_temp.nperr_as(pg_temp.npid('nodeA'), 'select count(*) from public.node_verifications'),
  '42501',
  'the SUBJECT of the record is refused their own verification log: the row names a third '
  'party they may duplicate, and RLS filters rows rather than columns'
);

select extensions.is(
  pg_temp.nperr_as(pg_temp.npid('outsider'), 'select count(*) from public.node_verifications'),
  '42501',
  'an outsider is refused node_verifications rather than shown zero rows'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_verifications', 'SELECT'),
  'authenticated holds no SELECT on node_verifications at all: there is no policy to bypass'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.node_verifications', 'SELECT'),
  'anon holds no SELECT on node_verifications'
);

-- ----------------------------------------- privileges, not policies (10)
--
-- RLS filters rows a grant already permits. These assert the grants themselves,
-- because a missing policy and a missing grant fail very differently.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_profiles', 'INSERT'),
  'authenticated cannot INSERT a node profile: registering as a node is a server decision'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_profiles', 'UPDATE'),
  'authenticated cannot UPDATE a node profile, diverging deliberately from profiles: '
  'kyc_status, trust_score and availability are what a fraudster would set on themselves'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_profiles', 'TRUNCATE'),
  'authenticated cannot TRUNCATE node_profiles: TRUNCATE ignores RLS'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_skills', 'TRUNCATE'),
  'authenticated cannot TRUNCATE node_skills'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_credentials', 'TRUNCATE'),
  'authenticated cannot TRUNCATE node_credentials'
);

select extensions.ok(
  not has_table_privilege('authenticated', 'public.node_verifications', 'TRUNCATE'),
  'authenticated cannot TRUNCATE node_verifications'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.node_verifications', 'UPDATE'),
  'service_role cannot UPDATE a verification: a record trusted code can rewrite is not '
  'evidence, and a re-check is a new row'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.node_verifications', 'DELETE'),
  'service_role cannot DELETE a verification'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.node_verifications', 'TRUNCATE'),
  'service_role cannot TRUNCATE the verifications either, which is the revoke people forget'
);

select extensions.ok(
  not has_table_privilege('anon', 'public.node_profiles', 'SELECT'),
  'anon has no read access to the marketplace'
);

-- ------------------------------------------ constraints, as postgres (13)
--
-- The helpers above reset `role` but deliberately leave `request.jwt.claims`
-- alone, so clear them here: the audit trigger reads `auth.uid()` to decide
-- whether an actor was a person or the system, and a stale claim from the
-- visibility section would record the wrong one.
select set_config('request.jwt.claims', '', true);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_profiles (user_id, kyc_status, availability) values (%L, ''unverified'', ''available'')',
    pg_temp.npid('outsider'))),
  '23514',
  'an unverified node cannot be in the matching pool: the database refuses it rather than '
  'the matcher, which is the one eligibility rule with no second layer behind it'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_profiles (user_id, kyc_status, availability) values (%L, ''verified'', ''available'')',
    pg_temp.npid('outsider'))),
  null::text,
  'a verified node CAN be available: the constraint refuses the pairing, not the state'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set kyc_status = ''suspended'' where user_id = %L',
    pg_temp.npid('nodeB'))),
  '23514',
  'a suspension is refused. NOTE, since 20260902120000 this passes for a second reason and '
  'the first is now unreachable: no arc in the lifecycle map reaches suspended at all, '
  'because suspension has no writer until an ops console exists, so the trigger raises '
  'before node_profiles_suspended_has_reason is ever evaluated. Both raise 23514. The '
  'constraint regains its own coverage in the slice that first suspends somebody'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set trust_score = 1.5 where user_id = %L',
    pg_temp.npid('nodeB'))),
  '23514',
  'a trust score outside its own scale is refused: it would silently reorder the pool'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set trust_score = null where user_id = %L',
    pg_temp.npid('nodeB'))),
  null::text,
  'a null trust score is accepted: cold start is null, never zero, because zero would mean '
  'measured and worthless'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set rate = 90.00 where user_id = %L',
    pg_temp.npid('nodeB'))),
  '23514',
  'a rate with no period is refused: 90.00 is unusable by the comparison the match rests on'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set rate = 0, rate_period = ''hour'' where user_id = %L',
    pg_temp.npid('nodeB'))),
  '23514',
  'a rate of zero is refused: it is a kill switch wearing the shape of a price'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set service_jurisdictions = array[''texas''] where user_id = %L',
    pg_temp.npid('nodeB'))),
  '23514',
  'a free-text jurisdiction is refused: containment is a prefix test and ''texas'' has no prefix'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_profiles set service_jurisdictions = array[''US-TX-AUSTIN''] where user_id = %L',
    pg_temp.npid('nodeB'))),
  null::text,
  'a three-segment code is accepted: US-TX-AUSTIN is inside US-TX is inside US'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_skills (node_id, skill_tag) values (%L, ''Legal Filing'')',
    pg_temp.npid('nodeB'))),
  '23514',
  'a prose skill tag is refused: a taxonomy that accepts anything filters nothing'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_skills (node_id, skill_tag) values (%L, ''legal-filing:US-TX'')',
    pg_temp.npid('nodeB'))),
  null::text,
  'a jurisdiction-qualified skill tag is accepted'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_skills (node_id, skill_tag) values (%L, ''paid-ads'')',
    pg_temp.npid('nodeA'))),
  '23505',
  'a node cannot claim the same skill twice'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_credentials (node_id, kind, jurisdiction, verified) values (%L, ''lawyer'', ''US-TX'', true)',
    pg_temp.npid('nodeB'))),
  '23514',
  'a verified licence with no dated evidence is refused: verified-not-self-attested is a '
  'module rule, and a boolean with nothing behind it is self-attestation with extra steps'
);

-- ------------------------------- node_verifications constraints, as postgres (2)

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_verifications (node_id, kind, provider, result, matched_node_id) values (%L, ''document'', ''fake'', ''passed'', %L)',
    pg_temp.npid('nodeA'), pg_temp.npid('nodeB'))),
  '23514',
  'only a face search can name a third party: a document check that accuses somebody else '
  'is a category error, refused by the table'
);

select extensions.is(
  pg_temp.nperr(format(
    'insert into public.node_verifications (node_id, kind, provider, result, matched_node_id) values (%L, ''face_search'', ''fake'', ''failed'', %L)',
    pg_temp.npid('nodeA'), pg_temp.npid('nodeA'))),
  '23514',
  'a face search cannot match its own subject: everybody duplicates themselves'
);

-- ---------------------------------------------- triggers, as postgres (2)

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_credentials set verified = false where node_id = %L',
    pg_temp.npid('nodeA'))),
  '23514',
  'un-verifying a licence is refused: it would erase that we ever asserted somebody was a '
  'notary, with nothing left pointing at why'
);

select extensions.is(
  pg_temp.nperr(format(
    'update public.node_credentials set revoked_at = now() where node_id = %L',
    pg_temp.npid('nodeA'))),
  null::text,
  'revoking the same licence is accepted: revocation is a separate, dated fact'
);

-- -------------------------------------------------- the audit trigger (2)

select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.npid('nodeB') and verb = 'node.kyc_status_changed'),
  0::bigint,
  'no KYC event before the status moves'
);

-- One status change, then one unrelated edit. Only the first should be audited.
--
-- The arc is `unverified -> pending` rather than `unverified -> verified`, and
-- it was changed by `20260902120000`. That migration put the lifecycle map into
-- this same trigger, and no arc goes straight from unverified to verified:
-- submission has to precede a decision. The subject of this assertion is
-- untouched, because it was never about which arc was taken. It is about the
-- trigger's WHEN clause firing once for a status change and not at all for an
-- unrelated edit, and it still is.
update public.node_profiles set kyc_status = 'pending' where user_id = pg_temp.npid('nodeB');
update public.node_profiles set languages = array['en', 'ka'] where user_id = pg_temp.npid('nodeB');

select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.npid('nodeB') and verb = 'node.kyc_status_changed'),
  1::bigint,
  'the KYC change is audited exactly once and the unrelated edit is not: the trigger''s '
  'WHEN clause earns its place, or every rate change would claim a status moved'
);

-- ------------------------------ the task machine, deliberately unchanged (2)
--
-- Slice 1 restores no arc. `20260815220000` silently dropped eight of them with
-- nothing asserting they had ever been there, so pinning the absence is what
-- makes any later decision about them read as dated rather than as drift.
--
-- **Corrected in slice 4 rather than left to read as a promise.** This message
-- used to say the arc "is restored in slice 4, with the matcher that can produce
-- it". Slice 4 built the matcher and decided against restoring it
-- ([ADR-0018](../../docs/40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)):
-- an exhausted cascade returns the step to its owner at `escalated`, because
-- `failed` is terminal and would strand work the owner can still take. The
-- verdict this asserts is unchanged; only the reason is, and leaving the old
-- wording would have left a test file promising something nobody intends to do.

select extensions.ok(
  not private.task_transition_allowed('matching', 'failed'),
  'matching -> failed is still refused, and stays that way: exhaustion returns the step '
  'to its owner rather than into a terminal state (ADR-0018)'
);

select extensions.ok(
  private.task_transition_allowed('escalated', 'matching'),
  'escalated -> matching is still allowed: the marketplace exit has been in the machine '
  'since 20260813120000 and this slice does not touch it'
);

select * from extensions.finish();

rollback;
