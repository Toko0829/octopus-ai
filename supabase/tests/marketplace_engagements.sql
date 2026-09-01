-- Engagement, escrow and ledger tests — covers 20260904120000 … 20260904127000.
--
-- The slice that first commits money. `marketplace_offers.sql` asserts the offer
-- lifecycle and who may read an offer; this asserts what happens when somebody
-- says yes: a deal exists, a hold is modelled against the project's authorised
-- ceiling, a balanced ledger pair is written, a thread is created, and one node
-- is admitted to it and to nothing else.
--
-- **A separate file rather than more assertions in `marketplace_offers.sql`**,
-- for the reason `node_onboarding.sql` gives about `marketplace_rls.sql`:
-- `plan(N)` is exact, and growing a suite whose subject is an earlier slice means
-- editing what it pins.
--
-- **Nothing here charges anything.** The only registered payment provider is the
-- in-repo fake; `p_charge_id` below is a literal string standing in for what it
-- would return. The counsel gate in payments-billing.md is unmoved, and
-- 20260904121000's header says why at length.
--
-- The role split follows `marketplace_offers.sql`. Constraint, trigger, map and
-- function assertions run as `postgres` deliberately: those guards must bind
-- trusted server code too, and `accept_offer` is granted to `service_role` alone.
-- RLS and privilege assertions run as `authenticated` with `request.jwt.claims`
-- set, exactly as PostgREST would, so what is tested is the policy rather than a
-- superuser bypassing it.
--
-- Three things this file pins that are **absences**, each of which somebody could
-- reasonably "fix" later without realising:
--
--   * **`held -> released` is refused**, and the wording is descriptive rather
--     than promissory. Release is what a payout does and its producer does not
--     exist, so permitting the arc would be a rule enforced over an empty set.
--     It is declared in the check constraint because the constraint is the
--     column's vocabulary; the map is what can be done today.
--   * **A member reads no ledger row at all**, and `authenticated` has no grant
--     on the table. The reader of raw entries is the Phase-3 ops console; a
--     member's view of money is the projection.
--   * **The owner still reads zero offers.** The engagement opened the
--     counterparty pair; the offer trail names everybody who was asked, including
--     the people who declined, and that is a different disclosure decision.
--
-- One trap this file is written around, recorded in supabase/README.md: a
-- function that inserts, called from the same statement that reads the table it
-- inserted into, sees the pre-statement snapshot and reads back nothing. So every
-- write and the assertion about it are separate statements.
--
-- Everything is inside a transaction that ROLLBACKs, so it is safe against a live
-- database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/marketplace_engagements.sql

begin;

select extensions.plan(70);

-- ---------------------------------------------------------------- fixtures

create temporary table egids (k text primary key, v uuid);
insert into egids (k, v) values
  ('owner',    gen_random_uuid()),
  ('stranger', gen_random_uuid()),
  ('n1',       gen_random_uuid()),
  ('n2',       gen_random_uuid()),
  ('n3',       gen_random_uuid()),
  ('hourly',   gen_random_uuid()),
  ('eur',      gen_random_uuid()),
  ('n7',       gen_random_uuid()),
  ('p1',       gen_random_uuid()),
  ('p2',       gen_random_uuid()),
  ('p3',       gen_random_uuid()),
  ('r1',       gen_random_uuid()),
  ('r2',       gen_random_uuid()),
  ('r3',       gen_random_uuid()),
  ('c1late',   gen_random_uuid()),
  ('c1first',  gen_random_uuid()),
  ('c2',       gen_random_uuid()),
  ('c3',       gen_random_uuid()),
  ('t1',       gen_random_uuid()),
  ('t2',       gen_random_uuid()),
  ('t3',       gen_random_uuid()),
  ('t4',       gen_random_uuid()),
  ('tnull',    gen_random_uuid()),
  ('texp',     gen_random_uuid()),
  ('tsettled', gen_random_uuid()),
  ('tnotoff',  gen_random_uuid()),
  ('teur',     gen_random_uuid()),
  ('thourly',  gen_random_uuid()),
  ('t7',       gen_random_uuid()),
  ('t8',       gen_random_uuid()),
  ('o1',       gen_random_uuid()),
  ('o2',       gen_random_uuid()),
  ('o3',       gen_random_uuid()),
  ('onull',    gen_random_uuid()),
  ('oexp',     gen_random_uuid()),
  ('osettled', gen_random_uuid()),
  ('onotoff',  gen_random_uuid()),
  ('oeur',     gen_random_uuid()),
  ('ohourly',  gen_random_uuid()),
  ('o7',       gen_random_uuid()),
  ('o8',       gen_random_uuid()),
  ('ospare',   gen_random_uuid());

create or replace function pg_temp.egid(text) returns uuid language sql stable as
  $$ select v from egids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.egid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@engagements.invalid', '', now(), now(), now()
from (values ('owner'), ('stranger'), ('n1'), ('n2'), ('n3'),
             ('hourly'), ('eur'), ('n7')) as t(k);

-- Claims cleared so the guard triggers file their events as `system`, which is
-- what a service_role connection actually produces.
select set_config('request.jwt.claims', '', true);

-- Six nodes. Every one is verified and available, so nothing below passes or
-- fails for an eligibility reason it was not meant to test.
insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
values
  (pg_temp.egid('n1'),     'verified', 'available', array['US-TX'], array['en'], 500.00, 'task', 'USD'),
  (pg_temp.egid('n2'),     'verified', 'available', array['US-TX'], array['en'], 500.00, 'task', 'USD'),
  (pg_temp.egid('n3'),     'verified', 'available', array['US-TX'], array['en'],   1.00, 'task', 'USD'),
  (pg_temp.egid('hourly'), 'verified', 'available', array['US-TX'], array['en'], 120.00, 'hour', 'USD'),
  (pg_temp.egid('eur'),    'verified', 'available', array['US-TX'], array['en'], 100.00, 'task', 'EUR'),
  (pg_temp.egid('n7'),     'verified', 'available', array['US-TX'], array['en'],  50.00, 'task', 'USD');

-- Three projects, because the ceiling is the thing under test and a refusal that
-- fired for the wrong reason would pass anyway. P1 is the boundary, P2 has no
-- ceiling at all, and P3 has headroom so the refusals tested there are the ones
-- they are named after.
insert into public.projects (id, owner_id, goal, status, budget_ceiling, currency)
values
  (pg_temp.egid('p1'), pg_temp.egid('owner'), 'Ship the launch', 'active', 1000.00, 'USD'),
  (pg_temp.egid('p2'), pg_temp.egid('owner'), 'Unbudgeted',      'active', null,    'USD'),
  (pg_temp.egid('p3'), pg_temp.egid('owner'), 'Plenty of room',  'active', 100000.00, 'USD');

-- Rooms linked through `rooms.project_id`, the legacy path `is_project_member`
-- still accepts. The owner is a genuine project member, which is what makes the
-- "owner reads zero offers" assertion mean something.
insert into public.rooms (id, name, owner_id, project_id)
values
  (pg_temp.egid('r1'), 'Launch',   pg_temp.egid('owner'), pg_temp.egid('p1')),
  (pg_temp.egid('r2'), 'Unfunded', pg_temp.egid('owner'), pg_temp.egid('p2')),
  (pg_temp.egid('r3'), 'Roomy',    pg_temp.egid('owner'), pg_temp.egid('p3'));

-- Two channels in R1, inserted newest-position first, so the deterministic pick
-- inside `accept_offer` is actually exercised rather than passing because there
-- was only one candidate.
insert into public.channels (id, room_id, name, position)
values
  (pg_temp.egid('c1late'),  pg_temp.egid('r1'), 'later',   5),
  (pg_temp.egid('c1first'), pg_temp.egid('r1'), 'general', 0),
  (pg_temp.egid('c2'),      pg_temp.egid('r2'), 'general', 0),
  (pg_temp.egid('c3'),      pg_temp.egid('r3'), 'general', 0);

insert into public.room_members (room_id, user_id, role, scope)
values
  (pg_temp.egid('r1'), pg_temp.egid('owner'), 'user', 'room'),
  (pg_temp.egid('r2'), pg_temp.egid('owner'), 'user', 'room'),
  (pg_temp.egid('r3'), pg_temp.egid('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values
  (pg_temp.egid('t1'),       pg_temp.egid('p1'), 'Write the launch emails', 'conversion', 'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('t2'),       pg_temp.egid('p1'), 'Fill the ceiling',        'channels',   'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('t3'),       pg_temp.egid('p1'), 'One over',                'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('t4'),       pg_temp.egid('p1'), 'A second step for n1',    'strategy',   'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('tnull'),    pg_temp.egid('p2'), 'Nobody authorised this',  'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('texp'),     pg_temp.egid('p3'), 'Ran out of time',         'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('tsettled'), pg_temp.egid('p3'), 'Already declined',        'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('tnotoff'),  pg_temp.egid('p3'), 'Taken back',              'content',    'human', 'matching', '[]'::jsonb),
  (pg_temp.egid('teur'),     pg_temp.egid('p3'), 'Wrong currency',          'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('thourly'),  pg_temp.egid('p3'), 'Hourly expert',           'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('t7'),       pg_temp.egid('p3'), 'First step for n7',       'content',    'human', 'offered',  '[]'::jsonb),
  (pg_temp.egid('t8'),       pg_temp.egid('p3'), 'Second step for n7',      'content',    'human', 'offered',  '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values
  (pg_temp.egid('o1'),      pg_temp.egid('t1'),       pg_temp.egid('p1'), pg_temp.egid('n1'),     0, now() + interval '48 hours'),
  (pg_temp.egid('o2'),      pg_temp.egid('t2'),       pg_temp.egid('p1'), pg_temp.egid('n2'),     0, now() + interval '48 hours'),
  (pg_temp.egid('o3'),      pg_temp.egid('t3'),       pg_temp.egid('p1'), pg_temp.egid('n3'),     0, now() + interval '48 hours'),
  (pg_temp.egid('o8'),      pg_temp.egid('t4'),       pg_temp.egid('p1'), pg_temp.egid('n1'),     0, now() + interval '48 hours'),
  (pg_temp.egid('onull'),   pg_temp.egid('tnull'),    pg_temp.egid('p2'), pg_temp.egid('n3'),     0, now() + interval '48 hours'),
  (pg_temp.egid('onotoff'), pg_temp.egid('tnotoff'),  pg_temp.egid('p3'), pg_temp.egid('n3'),     0, now() + interval '48 hours'),
  (pg_temp.egid('oeur'),    pg_temp.egid('teur'),     pg_temp.egid('p3'), pg_temp.egid('eur'),    0, now() + interval '48 hours'),
  (pg_temp.egid('ohourly'), pg_temp.egid('thourly'),  pg_temp.egid('p3'), pg_temp.egid('hourly'), 0, now() + interval '48 hours'),
  (pg_temp.egid('o7'),      pg_temp.egid('t7'),       pg_temp.egid('p3'), pg_temp.egid('n7'),     0, now() + interval '48 hours');

-- Backdated so `offers_expiry_after_creation` is satisfied by a row that has
-- nonetheless already run out. Expiry is a timestamp compared at read time, so
-- no sweep needs to have run for this to be expired.
insert into public.offers (id, task_id, project_id, node_id, round, created_at, expires_at)
values (pg_temp.egid('oexp'), pg_temp.egid('texp'), pg_temp.egid('p3'), pg_temp.egid('n3'),
        0, now() - interval '3 days', now() - interval '1 day');

insert into public.offers (id, task_id, project_id, node_id, round, status, declined_at, expires_at)
values (pg_temp.egid('osettled'), pg_temp.egid('tsettled'), pg_temp.egid('p3'), pg_temp.egid('n2'),
        0, 'declined', now(), now() + interval '48 hours');

-- Run a count as a given user, exactly as PostgREST would. The role switch
-- happens INSIDE the function, which keeps the fixture lookups readable: the
-- outer statement stays `postgres`, so the temp tables it reads need no grants.
create or replace function pg_temp.egcount_as(p_user uuid, p_sql text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql into n;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;

-- ------------------------------------------- the escrow lifecycle map (5)
--
-- Asserted directly rather than only through the trigger, so a broken arc names
-- itself instead of surfacing as a failed write several assertions later.

select extensions.ok(
  private.escrow_transition_allowed('held', 'refunded'),
  'held -> refunded: the reconcile sweep, unwinding a hold whose step stopped'
);

-- **Descriptive, not promissory.** `released` is in the check constraint because
-- the constraint is the column''s vocabulary; it is out of the map because
-- release is what a payout does and no payout exists. A map permitting an arc
-- nothing can walk is the defect this repository has recorded five times.
select extensions.ok(
  not private.escrow_transition_allowed('held', 'released'),
  'held -> released is refused: release is a payout act and no producer exists'
);

select extensions.ok(
  not private.escrow_transition_allowed('refunded', 'held'),
  'refunded -> held is refused: a settled hold never reopens'
);
select extensions.ok(
  not private.escrow_transition_allowed('released', 'refunded'),
  'released -> refunded is refused: both settlements are terminal'
);
select extensions.ok(
  not private.escrow_transition_allowed('held', 'held'),
  'held -> held is refused, which is what the trigger WHEN clause protects'
);

-- ------------------------------------------------- the happy path (14)

select extensions.lives_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('o1'), 'ch_fake_o1'),
  'a verified, task-rated node accepts an open offer inside its budget'
);

select extensions.is(
  (select status::text from public.offers where id = pg_temp.egid('o1')),
  'accepted',
  'the offer settled to accepted, the arc 20260904124000 added'
);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.egid('t1')),
  'escrow_funded',
  'the task walked offered -> claimed -> escrow_funded in one transaction'
);

-- Two events, not one. `claimed` is transit-only, and collapsing the moves would
-- need a map change to hide an audit row (ADR-0019).
select extensions.is(
  (select count(*)::int from public.events
    where verb = 'task.transitioned' and subject_id = pg_temp.egid('t1')),
  2,
  'both task moves are audited: claimed is transit-only, not invisible'
);

select extensions.is(
  (select agreed_price from public.engagements where offer_id = pg_temp.egid('o1')),
  500.00::numeric,
  'the price is frozen from the node profile at acceptance'
);

-- The rate moves afterwards. `agreed_price` must not follow it, or a projection
-- would silently rewrite what was agreed on every render.
update public.node_profiles set rate = 900.00 where user_id = pg_temp.egid('n1');

select extensions.is(
  (select agreed_price from public.engagements where offer_id = pg_temp.egid('o1')),
  500.00::numeric,
  'and it does not follow a later rate change: raising a rate does not re-price agreed work'
);

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.egid('t1')),
  'held',
  'an escrow hold was modelled against the project ceiling'
);

select extensions.is(
  (select idempotency_key from public.escrow_holds where task_id = pg_temp.egid('t1')),
  'escrow:' || pg_temp.egid('o1')::text,
  'keyed on the offer, so a later cascade round is a different key rather than a collision'
);

select extensions.is(
  (select amount from public.escrow_holds where task_id = pg_temp.egid('t1')),
  500.00::numeric,
  'for the price that was agreed, not for the rate on the profile'
);

-- **The balance invariant, asserted on rows rather than on the constructor.**
-- The TypeScript half is pinned in packages/payments/src/ledger.test.ts, and the
-- pair existing in two languages is taken on ADR-0011's terms: both sides assert
-- the same property, so drift fails a test.
select extensions.is(
  (select sum(debit) = sum(credit)
     from public.ledger_entries
    where ref_id = (select id from public.escrow_holds where task_id = pg_temp.egid('t1'))),
  true,
  'the ledger pair balances: debits equal credits for this hold'
);

select extensions.is(
  (select string_agg(account, ',' order by account)
     from public.ledger_entries
    where ref_id = (select id from public.escrow_holds where task_id = pg_temp.egid('t1'))),
  'escrow,owner_funds',
  'and it is exactly two entries, one per account'
);

select extensions.is(
  (select count(*)::int from public.threads where task_id = pg_temp.egid('t1')),
  1,
  'the task got its thread, which 20260901120000 shipped a table for and no writer'
);

-- The room has two channels and the thread must land in the same one on every
-- replay, or a crashed accept would put it somewhere else on the retry.
select extensions.is(
  (select channel_id from public.threads where task_id = pg_temp.egid('t1')),
  pg_temp.egid('c1first'),
  'in the room''s first channel by position, which is a deterministic pick rather than a guess'
);

select extensions.is(
  (select role::text || '/' || scope || '/' ||
          case when expires_at is null then 'no-deadline' else 'boxed' end
     from public.room_members
    where room_id = pg_temp.egid('r1') and user_id = pg_temp.egid('n1')),
  'human_node/thread/no-deadline',
  'the node is admitted thread-scoped with expires_at null: revocation is explicit, not a clock'
);

-- ---------------------------------------------- the events an INSERT owes (2)
--
-- Transition triggers fire on UPDATE only, so three of the four things this
-- function created would otherwise have no trail at all.

select extensions.is(
  (select string_agg(verb, ',' order by verb) from public.events
    where project_id = pg_temp.egid('p1')
      and verb in ('engagement.created', 'thread.created', 'node.admitted')),
  'engagement.created,node.admitted,thread.created',
  'the three creations each wrote their own event, because no trigger fires on an insert'
);

select extensions.is(
  (select (payload->>'ceiling')::numeric from public.events
    where verb = 'engagement.created'
      and subject_id = (select id from public.engagements where offer_id = pg_temp.egid('o1'))),
  1000.00::numeric,
  'and engagement.created carries the arithmetic that authorised it, reconstructible from the row'
);

-- ------------------------------------------------------ replay (3)

create temporary table egreplay as
  select public.accept_offer(pg_temp.egid('o1'), 'ch_fake_o1') as id;

select extensions.is(
  (select id from egreplay),
  (select id from public.engagements where offer_id = pg_temp.egid('o1')),
  'a replayed accept returns the engagement it already made'
);

select extensions.is(
  (select count(*)::int from public.engagements where offer_id = pg_temp.egid('o1')),
  1,
  'and inserts no second engagement: engagements.offer_id is the whole idempotency contract'
);

select extensions.is(
  (select count(*)::int from public.escrow_holds where task_id = pg_temp.egid('t1')),
  1,
  'and no second hold, so the ceiling is not committed twice'
);

-- ---------------------------------------- the ceiling, in both directions (4)
--
-- ADR-0020: the ceiling now has two committer classes, and this is the SQL half
-- of the boundary that `spend.test.ts` asserts in TypeScript. 500 is already
-- held, so 500 more lands exactly on 1000 and one unit past it does not.

select extensions.lives_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('o2'), 'ch_fake_o2'),
  'a second acceptance landing exactly on the ceiling is authorised, with a sibling hold present'
);

select extensions.is(
  (select coalesce(sum(amount), 0) from public.escrow_holds
    where project_id = pg_temp.egid('p1') and state = 'held'),
  1000.00::numeric,
  'the whole ceiling is now held in escrow'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('o3'), 'ch_fake_o3'),
  '23514',
  null,
  'and one unit past it is refused: > and not >=, the boundary both suites pin'
);

select extensions.is(
  (select count(*)::int from public.engagements where offer_id = pg_temp.egid('o3')),
  0,
  'a refused acceptance leaves no engagement behind: the whole transaction unwinds'
);

-- ------------------------------- every other refusal leaves nothing behind (12)

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('onull'), 'ch_x'),
  '23514',
  null,
  'a project with no authorised ceiling cannot fund anybody'
);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.egid('tnull')),
  'offered',
  'and the step is left exactly where it was'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('oexp'), 'ch_x'),
  '23514',
  null,
  'an expired offer is refused on Postgres''s clock, not on the caller''s'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('osettled'), 'ch_x'),
  '23514',
  null,
  'a settled offer is refused: a settlement never reopens'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('onotoff'), 'ch_x'),
  '23514',
  null,
  'a task that left the market underneath the offer cannot be claimed'
);

select extensions.is(
  (select count(*)::int from public.escrow_holds where task_id = pg_temp.egid('tnotoff')),
  0,
  'and no hold was created for it, because the offer flip and the task move are one transaction'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('oeur'), 'ch_x'),
  '23514',
  null,
  'a node priced in another currency is refused: summing EUR against a USD ceiling means nothing'
);

select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('ohourly'), 'ch_x'),
  '23514',
  null,
  'an hourly rate is refused: a hold is a total and there is no hours field to fund one against'
);

select extensions.is(
  (select count(*)::int from public.room_members where user_id = pg_temp.egid('hourly')),
  0,
  'and nobody was admitted to anything on the way to that refusal'
);

select extensions.lives_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('o7'), 'ch_fake_o7'),
  'a node takes their first step in a room they were not yet a member of'
);

-- ADR-0017's ceiling: `room_members` is keyed on (room_id, user_id), so one
-- person holds at most one membership per room and therefore one thread in it.
-- A real product limit, refused with a sentence rather than absorbed silently.
select extensions.throws_ok(
  format('select public.accept_offer(%L, %L)', pg_temp.egid('o8'), 'ch_x'),
  '23514',
  null,
  'the same node cannot take a second step in a room they already hold a thread in'
);

select extensions.is(
  (select count(*)::int from public.engagements where offer_id = pg_temp.egid('o8')),
  0,
  'and that refusal, like every other, left nothing behind'
);

-- ------------------------------------------- structural constraints (5)

-- A second live engagement on one task. The offer is a fresh row so the insert
-- fails on the partial unique index rather than on the offer key.
insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values (pg_temp.egid('ospare'), pg_temp.egid('t1'), pg_temp.egid('p1'),
        pg_temp.egid('n3'), 1, now() + interval '48 hours');

select extensions.throws_ok(
  format($q$insert into public.engagements (task_id, project_id, node_id, offer_id, agreed_price, currency)
            values (%L, %L, %L, %L, 100.00, 'USD')$q$,
         pg_temp.egid('t1'), pg_temp.egid('p1'), pg_temp.egid('n3'), pg_temp.egid('ospare')),
  '23505',
  null,
  'one live engagement per task: partial unique, so a reassignment can still create a second row'
);

select extensions.throws_ok(
  format($q$update public.engagements set agreed_price = 1.00 where offer_id = %L$q$,
         pg_temp.egid('o1')),
  '23514',
  null,
  'agreed_price is written once: the number escrow was funded against cannot move'
);

select extensions.throws_ok(
  format($q$update public.engagements set node_id = %L where offer_id = %L$q$,
         pg_temp.egid('n3'), pg_temp.egid('o1')),
  '23514',
  null,
  'and so is who is being paid'
);

select extensions.throws_ok(
  format($q$insert into public.engagements
            (task_id, project_id, node_id, offer_id, agreed_price, currency, ended_at)
            values (%L, %L, %L, %L, 100.00, 'USD', now())$q$,
         pg_temp.egid('t2'), pg_temp.egid('p1'), pg_temp.egid('n3'), pg_temp.egid('ospare')),
  '23514',
  null,
  'an ended engagement with no outcome is a deal nobody can explain'
);

select extensions.throws_ok(
  format($q$insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
            values ('escrow', 5.00, 5.00, 'USD', 'escrow_hold', %L)$q$, pg_temp.egid('t1')),
  '23514',
  null,
  'a ledger entry is a debit or a credit and never both'
);

-- --------------------------------------- the escrow arcs, through the guard (4)

select extensions.throws_ok(
  format($q$update public.escrow_holds set state = 'released' where task_id = %L$q$,
         pg_temp.egid('t2')),
  '23514',
  null,
  'the guard refuses held -> released even as postgres, because a trigger is not a grant'
);

select extensions.lives_ok(
  format($q$update public.escrow_holds set state = 'refunded' where task_id = %L$q$,
         pg_temp.egid('t2')),
  'held -> refunded is allowed, and the reconcile sweep is its producer'
);

select extensions.is(
  (select count(*)::int from public.events
    where verb = 'escrow.transitioned'
      and subject_id = (select id from public.escrow_holds where task_id = pg_temp.egid('t2'))),
  1,
  'exactly one audit event per transition, written by the trigger rather than by the caller'
);

select extensions.throws_ok(
  format($q$update public.escrow_holds set state = 'held' where task_id = %L$q$,
         pg_temp.egid('t2')),
  '23514',
  null,
  'and a refunded hold cannot be re-held: that would be a second hold, with its own key'
);

-- ------------------------------------------------- privileges (8)

select extensions.ok(
  not has_table_privilege('service_role', 'public.ledger_entries', 'UPDATE'),
  'not even service_role may update a ledger entry: append-only that binds only clients is not append-only'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.ledger_entries', 'DELETE'),
  'nor delete one'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.ledger_entries', 'SELECT'),
  'and a client has no grant on the ledger at all: the reader is the ops console, not a member'
);
select extensions.is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'ledger_entries'),
  0,
  'ledger_entries has RLS enabled and no policy, the events posture: deliberately unreadable'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.escrow_holds', 'DELETE'),
  'an escrow hold is never deleted, including by service_role: the ledger reconciles against it'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.engagements', 'DELETE'),
  'nor is an engagement: the deal trail is what a dispute reads'
);
select extensions.ok(
  has_table_privilege('service_role', 'public.engagements', 'UPDATE'),
  'service_role may update one, because ending a deal is an update and the guard constrains it'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.engagements', 'INSERT'),
  'a client cannot write an engagement: accepting runs through accept_offer with the secret key'
);

-- --------------------------------------------- RLS, as the client roles (5)

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('n1'), format(
    'select count(*) from public.engagements where task_id = %L', pg_temp.egid('t1'))),
  1::bigint,
  'a node reads their own engagement'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), format(
    'select count(*) from public.engagements where task_id = %L', pg_temp.egid('t1'))),
  1::bigint,
  'and the owner reads it too: this row is the deliberate opening of who took my step'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('stranger'), 'select count(*) from public.engagements'),
  0::bigint,
  'a stranger reads none'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), format(
    'select count(*) from public.escrow_holds where task_id = %L', pg_temp.egid('t1'))),
  1::bigint,
  'the owner reads the hold against their own project, which is how the panel shows committed budget'
);

-- **Still zero, and the message says why it stays zero.** The engagement opened
-- the counterparty pair; an offer names everybody who was ASKED, including the
-- people who said no, and publishing that trail is a different decision. What
-- the owner gets instead is the engagement projection.
select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), 'select count(*) from public.offers'),
  0::bigint,
  'and still reads zero offers: the engagement projection is what names their expert, not the offer trail'
);

-- ------------------------------------------------ the counterparty pair (5)

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.egid('n1'))),
  1::bigint,
  'a live engagement lets the owner read their expert''s profile: the pair 20260901122000 closed'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('n1'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.egid('owner'))),
  1::bigint,
  'and lets the expert read the person they are working for, which is the other half of it'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), format(
    'select count(*) from public.node_profiles where user_id = %L', pg_temp.egid('n1'))),
  0::bigint,
  'node_profiles stays closed: a rate card and a jurisdiction list are not facts about this deal'
);

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('stranger'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.egid('n1'))),
  0::bigint,
  'and it opens for nobody else: an engagement is not a directory entry'
);

-- Ending the deal closes the pair again, with no second copy of any expiry rule:
-- `ended_at is null` is the entire time-box.
update public.engagements set ended_at = now(), outcome = 'completed'
 where offer_id = pg_temp.egid('o1');

select extensions.is(
  pg_temp.egcount_as(pg_temp.egid('owner'), format(
    'select count(*) from public.profiles where user_id = %L', pg_temp.egid('n1'))),
  0::bigint,
  'ending the engagement closes the pair again: ended_at is null is the whole time-box'
);

-- ------------------------------------- the write-once ending, once ended (3)

select extensions.is(
  (select count(*)::int from public.events
    where verb = 'engagement.ended'
      and subject_id = (select id from public.engagements where offer_id = pg_temp.egid('o1'))),
  1,
  'ending wrote its own event from inside the guard, so it cannot be forgotten by a caller'
);

select extensions.throws_ok(
  format($q$update public.engagements set outcome = 'cancelled' where offer_id = %L$q$,
         pg_temp.egid('o1')),
  '23514',
  null,
  'an outcome is written once: completed does not become cancelled after the fact'
);

select extensions.throws_ok(
  format($q$update public.engagements set ended_at = null, outcome = null where offer_id = %L$q$,
         pg_temp.egid('o1')),
  '23514',
  null,
  'and an ended engagement cannot be reopened: a refund has already reversed it'
);

select * from extensions.finish();

rollback;
