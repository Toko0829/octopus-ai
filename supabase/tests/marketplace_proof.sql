-- The engagement loop and the no-show path — covers 20260906120000 … 20260906124000.
--
-- Slice 6. The slice that gives `escrow_funded` an exit, and gives a step
-- somebody took and abandoned a way back to the market.
--
-- **A separate file rather than more assertions in `marketplace_engagements.sql`**,
-- for the reason that file gives about `marketplace_offers.sql`: `plan(N)` is
-- exact, and growing a suite whose subject is an earlier slice means editing what
-- it pins.
--
-- **The core loop needed no migration at all**, so most of what this file asserts
-- about it is that arcs declared by `20260813120000` are still exactly as
-- declared. That is not a filler section: `20260815220000` silently dropped eight
-- arcs while restating the map for an unrelated reason, nothing asserted they had
-- ever been there, and it went unnoticed for two weeks. The map is now rewritten
-- once per slice and this is the half that notices.
--
-- Three absences are pinned as deliberately as the presences, each of which
-- somebody could reasonably "fix" later:
--
--   * **`proof_submitted -> in_progress` is refused.** Booked to this slice and
--     decided against ([ADR-0022](../../docs/40-adr/0022-proof-is-an-artifact.md)):
--     the floor check runs before anything is written and before the task moves,
--     so a bounced hand-over leaves the step where it was, and retraction has no
--     producer at all.
--   * **`blocked -> in_progress` is refused**, on ADR-0018's grounds: nothing
--     writes `blocked` for a human step, so it is an exit from a state nothing
--     can enter.
--   * **`claimed -> matching` is still refused.** ADR-0019 named slice 6 as where
--     the reassignment question genuinely reopens; it reopened, and the arc is
--     still not needed, because the producer leaves from `escrow_funded` or
--     `in_progress` exactly as that ADR predicted.
--
-- **The most consequential assertion in this file is a negative one**: neither
-- new arc leaves from `proof_submitted` or `in_review`. A deadline that passes
-- after the work arrives is the owner's failure to review, and reassigning there
-- would take a finished person's fee and give it to a stranger.
--
-- The role split follows `marketplace_engagements.sql`. Map, constraint and
-- function assertions run as `postgres` deliberately: these guards must bind
-- trusted server code too, and both functions here are granted to `service_role`
-- alone.
--
-- One trap this file is written around, recorded in supabase/README.md: a
-- function that inserts, called from the same statement that reads the table it
-- inserted into, sees the pre-statement snapshot and reads back nothing. Every
-- write and the assertion about it are separate statements.
--
-- Everything is inside a transaction that ROLLBACKs, so it is safe against a live
-- database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/marketplace_proof.sql

begin;

select extensions.plan(35);

-- ---------------------------------------------------------------- fixtures

create temporary table pids (k text primary key, v uuid);
insert into pids (k, v) values
  ('owner',   gen_random_uuid()),
  ('node',    gen_random_uuid()),
  ('node2',   gen_random_uuid()),
  ('room',    gen_random_uuid()),
  ('chan',    gen_random_uuid()),
  ('project', gen_random_uuid()),
  ('task',    gen_random_uuid()),
  ('task2',   gen_random_uuid()),
  ('offer',   gen_random_uuid()),
  ('offer2',  gen_random_uuid());

create or replace function pg_temp.pid(text) returns uuid language sql stable as
  $$ select v from pids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.pid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@proof.invalid', '', now(), now(), now()
from (values ('owner'), ('node'), ('node2')) as t(k);

insert into public.profiles (user_id, display_name)
values (pg_temp.pid('node'), 'Node'), (pg_temp.pid('node2'), 'Node two')
on conflict (user_id) do nothing;

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
values
  (pg_temp.pid('node'),  'verified', 'available', array['US-TX'], array['en'], 400, 'task', 'USD'),
  (pg_temp.pid('node2'), 'verified', 'available', array['US-TX'], array['en'], 400, 'task', 'USD');

insert into public.rooms (id, name, owner_id)
values (pg_temp.pid('room'), 'Proof test room', pg_temp.pid('owner'));
insert into public.channels (id, room_id, name)
values (pg_temp.pid('chan'), pg_temp.pid('room'), 'brief');

insert into public.projects (id, owner_id, goal, budget_ceiling, currency)
values (pg_temp.pid('project'), pg_temp.pid('owner'), 'Grow the newsletter', 5000, 'USD');
-- The legacy room link; `accept_offer` accepts it and it needs no plan card.
update public.rooms set project_id = pg_temp.pid('project') where id = pg_temp.pid('room');

insert into public.tasks (id, project_id, title, owner_type, state, acceptance_criteria)
values
  (pg_temp.pid('task'),  pg_temp.pid('project'), 'Abandoned step', 'human', 'offered',
   '["Under 60 seconds"]'::jsonb),
  (pg_temp.pid('task2'), pg_temp.pid('project'), 'Delivered step', 'human', 'offered',
   '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at, work_deadline_hours)
values
  (pg_temp.pid('offer'),  pg_temp.pid('task'),  pg_temp.pid('project'), pg_temp.pid('node'),  0,
   now() + interval '48 hours', 72),
  (pg_temp.pid('offer2'), pg_temp.pid('task2'), pg_temp.pid('project'), pg_temp.pid('node2'), 0,
   now() + interval '48 hours', 168);

-- --------------------------------------------- the deadline column (4)

select extensions.has_column('public', 'offers', 'work_deadline_hours',
  'an offer carries how long the work gets, so the node sees it before they agree');

select extensions.col_not_null('public', 'offers', 'work_deadline_hours',
  'and it is not null: "no deadline" is the state this domain does not have, since it is the '
  'one that produced escrow_funded with no exit');

select extensions.throws_ok(
  format($$ insert into public.offers (task_id, project_id, node_id, round, expires_at, work_deadline_hours)
            values (%L, %L, %L, 9, now() + interval '48 hours', 0) $$,
         pg_temp.pid('task'), pg_temp.pid('project'), gen_random_uuid()),
  '23514', null,
  'a zero deadline is refused at the table, a kill switch wearing the shape of a threshold');

select extensions.throws_ok(
  format($$ insert into public.offers (task_id, project_id, node_id, round, expires_at, work_deadline_hours)
            values (%L, %L, %L, 8, now() + interval '48 hours', -1) $$,
         pg_temp.pid('task'), pg_temp.pid('project'), gen_random_uuid()),
  '23514', null, 'and so is a negative one');

-- ------------------------------------- the transition map, both ways (14)
--
-- The presences first, because a narrowing one conjunct too far reads as
-- "nothing works" rather than as a security change.

select extensions.ok(private.task_transition_allowed('escrow_funded', 'in_progress'),
  'a funded step can be started, which had no producer for two slices');

select extensions.ok(private.task_transition_allowed('in_progress', 'proof_submitted'),
  'started work can be handed over');

select extensions.ok(private.task_transition_allowed('proof_submitted', 'in_review'),
  'a hand-over can be opened for review');

select extensions.ok(private.task_transition_allowed('in_review', 'approved'),
  'and approved');

select extensions.ok(private.task_transition_allowed('in_review', 'rejected'),
  'or sent back');

select extensions.ok(private.task_transition_allowed('rejected', 'in_progress'),
  'and work sent back can be picked up again, through the same route that starts it');

select extensions.ok(private.task_transition_allowed('escrow_funded', 'matching'),
  'a step accepted and never started goes back to the market (20260906123000)');

select extensions.ok(private.task_transition_allowed('in_progress', 'matching'),
  'and so does one that was started and abandoned');

-- The absences, each of which somebody could reasonably restore later.

select extensions.ok(not private.task_transition_allowed('proof_submitted', 'matching'),
  'but NOT one that was handed over: a deadline passing after delivery is the owner failure to '
  'review, and reassigning would give a finished person fee to a stranger');

select extensions.ok(not private.task_transition_allowed('in_review', 'matching'),
  'nor one the owner is deciding on');

select extensions.ok(not private.task_transition_allowed('proof_submitted', 'in_progress'),
  'proof_submitted to in_progress stays dropped (ADR-0022): the floor check refuses before '
  'anything is written and before the task moves, so a bounce needs no arc');

select extensions.ok(not private.task_transition_allowed('blocked', 'in_progress'),
  'blocked to in_progress stays dropped: nothing writes blocked for a human step, so it would '
  'be an exit from a state nothing can enter');

select extensions.ok(not private.task_transition_allowed('claimed', 'matching'),
  'claimed to matching is still dropped (ADR-0019). Slice 6 is where that question reopened, '
  'and the producer leaves from escrow_funded or in_progress exactly as the ADR predicted');

-- **Split, and half of it inverted, because slice 8 changed the fact.** This was
-- one four-way conjunction asserting that neither `failed` nor `disputed` was
-- reachable from the two working states. The `failed` half is unchanged and
-- still right. The `disputed` half stopped being true when `20260908120000`
-- restored the arcs and `20260908124000` gave them a producer, so it is
-- **inverted rather than deleted** (`20260904121000:113-119`): an assertion that
-- pinned a decision should still be here saying the decision was taken.
--
-- The conjunction had to be split to do it. That is the cost of asserting four
-- facts in one `ok`, recorded here rather than repeated: a conjunction cannot be
-- half-inverted, so the whole thing has to be rewritten the first time any part
-- of it changes.

select extensions.ok(
  not private.task_transition_allowed('escrow_funded', 'failed')
  and not private.task_transition_allowed('in_progress', 'failed'),
  'no path to failed from the working states: failed is terminal and blocks dependents (ADR-0018)');

select extensions.ok(
  private.task_transition_allowed('escrow_funded', 'disputed')
  and private.task_transition_allowed('in_progress', 'disputed'),
  'both working states now reach disputed, because slice 8 built the ops console that can move a '
  'task out of it. Before that console existed these arcs were deliberately absent, which is the '
  'escalated defect this repository refuses to reproduce');

-- ------------------------------------- acceptance freezes the deadline (3)

create temporary table accepted as
  select public.accept_offer(pg_temp.pid('offer'), 'ch_fake_proof_a') as engagement_id;

select extensions.isnt(
  (select deadline_at from public.engagements where offer_id = pg_temp.pid('offer')),
  null::timestamptz,
  'engagements.deadline_at has a writer, after two slices as a column with none');

select extensions.ok(
  (select deadline_at from public.engagements where offer_id = pg_temp.pid('offer'))
    between now() + interval '71 hours' and now() + interval '73 hours',
  'and it is the offer own 72 hours rather than a constant baked into the function, so a later '
  'change to the policy cannot shorten time somebody already has');

select extensions.is(
  (select expires_at from public.room_members
    where user_id = pg_temp.pid('node') and room_id = pg_temp.pid('room')),
  null::timestamptz,
  'the membership is still admitted with expires_at null: a deadline must not cut a node out of '
  'their own thread at the moment they most need to say why they are late');

-- --------------------------------- reassigning an abandoned step (8)

create temporary table reassigned as
  select public.reassign_engagement((select engagement_id from accepted)) as id;

select extensions.is(
  (select state from public.tasks where id = pg_temp.pid('task')),
  'matching'::public.task_state,
  'the abandoned step goes back to the market rather than to escalated or failed');

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.pid('task')),
  'refunded',
  'and its hold is refunded, so the ceiling stops counting money nobody is going to earn');

select extensions.is(
  (select sum(debit) - sum(credit) from public.ledger_entries
    where ref_id = (select id from public.escrow_holds where task_id = pg_temp.pid('task'))),
  0::numeric,
  'the four entries about that hold sum to zero, so settled is a fact a reader derives rather '
  'than a column they trust');

select extensions.is(
  (select outcome from public.engagements where offer_id = pg_temp.pid('offer')),
  'reassigned',
  'the engagement ends as reassigned, which the check constraint has carried since '
  '20260904120000 with no producer');

select extensions.isnt(
  (select expires_at from public.room_members
    where user_id = pg_temp.pid('node') and room_id = pg_temp.pid('room')),
  null::timestamptz,
  'and the node thread access is revoked, stamped rather than deleted so the roster still '
  'records that this person was here');

select extensions.is(
  (select count(*)::int from public.events
    where verb = 'engagement.reassigned'
      and subject_id = (select engagement_id from accepted)),
  1,
  'one engagement.reassigned event carries what the decision rested on');

-- Replay. Idempotency is checked before validation, the accept_offer ordering.
create temporary table replayed as
  select public.reassign_engagement((select engagement_id from accepted)) as id;

select extensions.is(
  (select count(*)::int from public.ledger_entries
    where ref_id = (select id from public.escrow_holds where task_id = pg_temp.pid('task'))),
  4,
  'a replay writes no second reversing pair');

select extensions.is(
  (select id from replayed), (select engagement_id from accepted),
  'and returns the same engagement rather than raising, so a crashed pass converges');

-- ------------------------- the node who delivered wins the race (2)

create temporary table accepted2 as
  select public.accept_offer(pg_temp.pid('offer2'), 'ch_fake_proof_b') as engagement_id;

update public.tasks set state = 'in_progress' where id = pg_temp.pid('task2');
update public.tasks set state = 'proof_submitted' where id = pg_temp.pid('task2');

select extensions.throws_ok(
  format($$ select public.reassign_engagement(%L) $$, (select engagement_id from accepted2)),
  '23514', null,
  'a step handed over between the sweep read and the call is refused, and the raise unwinds the '
  'whole transaction: they delivered, so they win');

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.pid('task2')),
  'held',
  'so the delivering node escrow is untouched, which is the property that makes the race safe '
  'rather than merely unlikely');

-- ---------------------------------------------------- privileges (3)

select extensions.ok(
  not has_function_privilege('authenticated', 'public.reassign_engagement(uuid)', 'EXECUTE'),
  'a client cannot reassign an engagement: it is a clock decision, and a button would let '
  'either party end the other deal');

select extensions.ok(
  not has_function_privilege('anon', 'public.reassign_engagement(uuid)', 'EXECUTE'),
  'and neither can an unauthenticated caller');

select extensions.ok(
  has_function_privilege('service_role', 'public.reassign_engagement(uuid)', 'EXECUTE'),
  'the sweep can, and it is the only caller');

select * from extensions.finish();

rollback;
