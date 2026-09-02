-- marketplace_payout.sql — the money leaves escrow, and the properties that stop
-- it leaving twice or leaving for the wrong person.
--
-- Subject: `20260907120000` … `20260907123000` (slice 7). Its siblings
-- `marketplace_engagements.sql` and `marketplace_proof.sql` cover the slices
-- before it; the escrow map's `held -> released` assertion lives there and was
-- **inverted** rather than duplicated here, because two files asserting one arc
-- is two files to keep in step.
--
-- What this file pins, and every item is something whose violation is money:
--
--   * **A hold settles exactly once, in exactly one direction.** Released and
--     refunded are both terminal and neither reaches the other. A released hold
--     that could be refunded would take back money somebody earned; a refunded
--     one that could be released would pay for work that was cancelled.
--   * **`settle_payout` is all-or-nothing.** Its own header argues why every
--     partial state is a defect somebody would reconcile by hand, so the
--     assertions here drive real failures — a task that moved, a hold already
--     refunded — and check that **nothing** moved afterwards.
--   * **The ceiling stops counting a released hold**, which is the number an
--     owner reads and the thing ADR-0020 says four places must agree on.
--   * **A settled hold's four ledger entries sum to zero on every account**,
--     which is what makes "settled" derivable rather than a column to trust.
--   * **`done` has a producer**, for the first time in this schema. The AI arm
--     has one too now, in `executeTask`; this file pins only that `approved`
--     itself stays non-terminal, because the payout sweep reads it.
--   * **`completed_engagements` moves**, because slice 8 ranks on it.
--   * **The node reads their own payout and nobody else's**, and `payouts` is
--     append-and-settle even for `service_role`.
--   * **A completed deal keeps the counterparty pair open**, and a reassigned one
--     does not. Paying somebody must not be what erases their name.
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
--   psql "$DATABASE_URL" -f supabase/tests/marketplace_payout.sql

begin;

select extensions.plan(38);

-- ---------------------------------------------------------------- fixtures

create temporary table poids (k text primary key, v uuid);
insert into poids (k, v) values
  ('owner',    gen_random_uuid()),
  ('stranger', gen_random_uuid()),
  -- **Four nodes, one per step, and that is forced rather than tidy.**
  -- `room_members` is keyed on `(room_id, user_id)`
  -- ([ADR-0017](../../docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md)),
  -- so a node works one step of a project at a time and `accept_offer` refuses
  -- the second acceptance. A fixture reusing one node would fail on its second
  -- accept, which is slice 5 working rather than this suite being wrong.
  ('n1',       gen_random_uuid()),
  ('n2',       gen_random_uuid()),
  ('n3',       gen_random_uuid()),
  ('n4',       gen_random_uuid()),
  ('p1',       gen_random_uuid()),
  ('r1',       gen_random_uuid()),
  ('c1',       gen_random_uuid()),
  -- The step that gets paid, end to end.
  ('tpay',     gen_random_uuid()),
  ('opay',     gen_random_uuid()),
  -- A step whose hold was refunded underneath it, so the settlement must refuse.
  ('tgone',    gen_random_uuid()),
  ('ogone',    gen_random_uuid()),
  -- A step that was cancelled while the transfer was in flight.
  ('tcancel',  gen_random_uuid()),
  ('ocancel',  gen_random_uuid()),
  -- Another node's step, so "reads their own" has something to not read, and so
  -- an ending that did NOT deliver has somewhere to happen.
  ('tother',   gen_random_uuid()),
  ('oother',   gen_random_uuid());

create or replace function pg_temp.poid(text) returns uuid language sql stable as
  $$ select v from poids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.poid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@payout.invalid', '', now(), now(), now()
from (values ('owner'), ('stranger'), ('n1'), ('n2'), ('n3'), ('n4')) as t(k);

-- Claims cleared so the guard triggers file their events as `system`, which is
-- what a service_role connection actually produces.
select set_config('request.jwt.claims', '', true);

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
values
  (pg_temp.poid('n1'), 'verified', 'available', array['US-TX'], array['en'], 400.00, 'task', 'USD'),
  (pg_temp.poid('n2'), 'verified', 'available', array['US-TX'], array['en'], 250.00, 'task', 'USD'),
  (pg_temp.poid('n3'), 'verified', 'available', array['US-TX'], array['en'], 300.00, 'task', 'USD'),
  (pg_temp.poid('n4'), 'verified', 'available', array['US-TX'], array['en'], 200.00, 'task', 'USD');

insert into public.projects (id, owner_id, goal, status, budget_ceiling, currency)
values (pg_temp.poid('p1'), pg_temp.poid('owner'), 'Ship the launch', 'active', 5000.00, 'USD');

insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.poid('r1'), 'Launch', pg_temp.poid('owner'), pg_temp.poid('p1'));

insert into public.channels (id, room_id, name, position)
values (pg_temp.poid('c1'), pg_temp.poid('r1'), 'general', 0);

insert into public.room_members (room_id, user_id, role, scope)
values (pg_temp.poid('r1'), pg_temp.poid('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values
  (pg_temp.poid('tpay'),    pg_temp.poid('p1'), 'Shoot the launch video', 'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.poid('tgone'),   pg_temp.poid('p1'), 'Refunded underneath',    'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.poid('tcancel'), pg_temp.poid('p1'), 'Cancelled mid-flight',   'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.poid('tother'),  pg_temp.poid('p1'), 'Somebody else''s step',  'content', 'human', 'offered', '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values
  (pg_temp.poid('opay'),    pg_temp.poid('tpay'),    pg_temp.poid('p1'), pg_temp.poid('n1'), 0, now() + interval '48 hours'),
  (pg_temp.poid('ogone'),   pg_temp.poid('tgone'),   pg_temp.poid('p1'), pg_temp.poid('n3'), 0, now() + interval '48 hours'),
  (pg_temp.poid('ocancel'), pg_temp.poid('tcancel'), pg_temp.poid('p1'), pg_temp.poid('n4'), 0, now() + interval '48 hours'),
  (pg_temp.poid('oother'),  pg_temp.poid('tother'),  pg_temp.poid('p1'), pg_temp.poid('n2'), 0, now() + interval '48 hours');

-- Run a count as a given user, exactly as PostgREST would. The role switch
-- happens INSIDE the function, which keeps the fixture lookups readable.
create or replace function pg_temp.pocount_as(p_user uuid, p_sql text)
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

-- Accept all four, which funds four holds and writes four balanced ledger pairs.
-- `accept_offer` is slice 5's and is exercised in its own suite; here it is the
-- fixture builder, because a hand-built hold would not be the thing the payout
-- actually releases.
select public.accept_offer(pg_temp.poid('opay'),    'ch_fake_opay');
select public.accept_offer(pg_temp.poid('ogone'),   'ch_fake_ogone');
select public.accept_offer(pg_temp.poid('ocancel'), 'ch_fake_ocancel');
select public.accept_offer(pg_temp.poid('oother'),  'ch_fake_oother');

-- Walk each step to `approved` the way slice 6's routes do, one arc at a time, so
-- every transition guard fires rather than a fixture writing an unreachable state.
update public.tasks set state = 'in_progress'    where project_id = pg_temp.poid('p1');
update public.tasks set state = 'proof_submitted' where project_id = pg_temp.poid('p1');
update public.tasks set state = 'in_review'      where project_id = pg_temp.poid('p1');
update public.tasks set state = 'approved'       where project_id = pg_temp.poid('p1');

-- ------------------------------------------- the payout lifecycle map (5)
--
-- Asserted directly rather than only through the trigger, so a broken arc names
-- itself instead of surfacing as a failed write several assertions later.

select extensions.ok(
  private.payout_transition_allowed('pending', 'paid'),
  'pending -> paid: settle_payout, once the provider has answered'
);

-- **Descriptive, not promissory**, and it is deliberately the shape
-- `20260904121000` gave `released` — which `20260907120000` has just closed one
-- table over. Nothing here decides that a payout for approved work will never
-- happen: every failure retries at tick cadence, because a terminal row against
-- work somebody did, in a build with no ops console that could un-terminal it, is
-- the worse outcome.
select extensions.ok(
  not private.payout_transition_allowed('pending', 'failed'),
  'pending -> failed is refused: nothing closes a payout for work already approved'
);
select extensions.ok(
  not private.payout_transition_allowed('paid', 'pending'),
  'paid -> pending is refused: a settled payout never reopens'
);
select extensions.ok(
  not private.payout_transition_allowed('paid', 'failed'),
  'paid -> failed is refused: paid is terminal'
);
select extensions.ok(
  not private.payout_transition_allowed('pending', 'pending'),
  'pending -> pending is refused, which is what the trigger WHEN clause protects'
);

-- ------------------------------------------------ the happy path (13)

-- What the ceiling counts before anything is released, so the assertion after the
-- payout is a change rather than a value.
create temporary table pobefore as
select coalesce(sum(amount), 0)::numeric as committed
from public.escrow_holds
where project_id = pg_temp.poid('p1') and state = 'held';

insert into public.payouts
  (id, engagement_id, node_id, project_id, task_id, amount, platform_fee, currency, idempotency_key)
select gen_random_uuid(), e.id, e.node_id, e.project_id, e.task_id,
       e.agreed_price, 0, e.currency, 'payout:' || e.id
from public.engagements e where e.task_id = pg_temp.poid('tpay');

update public.tasks set state = 'payout_pending' where id = pg_temp.poid('tpay');

select public.settle_payout(
  (select id from public.payouts where task_id = pg_temp.poid('tpay')),
  'tr_fake_payout_test'
);

select extensions.is(
  (select state from public.tasks where id = pg_temp.poid('tpay')),
  'done'::public.task_state,
  'the step reaches done, which nothing in this schema had ever produced before'
);

select extensions.ok(
  private.task_state_is_terminal(
    (select state from public.tasks where id = pg_temp.poid('tpay'))),
  'and done is terminal, so a kill switch can no longer cancel work somebody was paid for'
);

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.poid('tpay')),
  'released',
  'the hold is released, the arc 20260907120000 permitted and this function produces'
);

select extensions.is(
  (select state from public.payouts where task_id = pg_temp.poid('tpay')),
  'paid',
  'the payout is paid'
);

select extensions.is(
  (select transfer_id from public.payouts where task_id = pg_temp.poid('tpay')),
  'tr_fake_payout_test',
  'and it records the provider''s reference, which is what makes the settlement provable'
);

select extensions.is(
  (select platform_fee from public.payouts where task_id = pg_temp.poid('tpay')),
  0::numeric,
  'nothing is retained: escrow held the price the offer showed the node (ADR-0024)'
);

select extensions.is(
  (select outcome from public.engagements where task_id = pg_temp.poid('tpay')),
  'completed',
  'the deal ends as completed, which had no producer until this function'
);

select extensions.is(
  (select completed_engagements from public.node_profiles where user_id = pg_temp.poid('n1')),
  1,
  'and the node''s completed count moves, which is what slice 8 ranks on'
);

-- **The four entries about this hold sum to zero on every account.** Two from
-- `accept_offer` and two from the release. This is the property that makes
-- "settled" a fact a reader derives rather than a column they trust, and it is
-- why the release pair carries the HOLD's ref rather than the payout's.
select extensions.is(
  (select count(*)::int from public.ledger_entries
    where ref_type = 'escrow_hold'
      and ref_id = (select id from public.escrow_holds where task_id = pg_temp.poid('tpay'))),
  4,
  'four ledger entries about the settled hold: two funding it, two releasing it'
);

select extensions.is(
  (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) from public.ledger_entries
    where ref_type = 'escrow_hold'
      and ref_id = (select id from public.escrow_holds where task_id = pg_temp.poid('tpay'))),
  0::numeric,
  'and they balance, as every set of entries about one reference must'
);

select extensions.is(
  (select coalesce(sum(debit), 0) - coalesce(sum(credit), 0) from public.ledger_entries
    where account = 'escrow'
      and ref_id = (select id from public.escrow_holds where task_id = pg_temp.poid('tpay'))),
  0::numeric,
  'escrow itself nets to zero: the account the money passed through keeps none of it'
);

select extensions.is(
  (select coalesce(sum(credit), 0) from public.ledger_entries
    where account = 'node_payable'
      and ref_id = (select id from public.escrow_holds where task_id = pg_temp.poid('tpay'))),
  400.00::numeric,
  'and node_payable keeps it, which is the account that had no entry until this slice'
);

-- **The ceiling stops counting it**, which is the number the owner reads and the
-- one ADR-0020 says four places must agree on. A released hold that still counted
-- would pin part of an authorised budget against finished work forever, which is
-- the defect the reconcile sweep exists to prevent for cancelled steps.
select extensions.is(
  (select coalesce(sum(amount), 0)::numeric from public.escrow_holds
    where project_id = pg_temp.poid('p1') and state = 'held'),
  (select committed - 400.00 from pobefore),
  'the released hold no longer commits the ceiling (ADR-0020)'
);

-- ------------------------------------------------ settling twice (2)

select extensions.lives_ok(
  format($q$select public.settle_payout(%L, 'tr_fake_payout_test')$q$,
         (select id from public.payouts where task_id = pg_temp.poid('tpay'))),
  'a replayed settlement returns rather than raising: idempotency before validation'
);

select extensions.is(
  (select count(*)::int from public.ledger_entries
    where ref_type = 'escrow_hold'
      and ref_id = (select id from public.escrow_holds where task_id = pg_temp.poid('tpay'))),
  4,
  'and it writes no second ledger pair, so the replay changed nothing at all'
);

-- ---------------------------------- all or nothing, on a real failure (6)
--
-- `settle_payout` is one transaction for the reason its header gives: every
-- partial state is a money defect somebody would reconcile by hand. These drive
-- the two failures that can actually happen in the window between the sweep's
-- read and the call, and assert that **nothing** moved.

-- (a) The hold was refunded underneath it — the reconcile or no-show sweep got
-- there first, so the money is back with the owner and paying now would spend
-- their ceiling twice.
insert into public.payouts
  (engagement_id, node_id, project_id, task_id, amount, platform_fee, currency, idempotency_key)
select e.id, e.node_id, e.project_id, e.task_id, e.agreed_price, 0, e.currency, 'payout:' || e.id
from public.engagements e where e.task_id = pg_temp.poid('tgone');

update public.tasks set state = 'payout_pending' where id = pg_temp.poid('tgone');
update public.escrow_holds set state = 'refunded' where task_id = pg_temp.poid('tgone');

select extensions.throws_ok(
  format($q$select public.settle_payout(%L, 'tr_fake_gone')$q$,
         (select id from public.payouts where task_id = pg_temp.poid('tgone'))),
  '23514',
  null,
  'a hold that was refunded underneath the payout refuses the settlement'
);

select extensions.is(
  (select state from public.payouts where task_id = pg_temp.poid('tgone')),
  'pending',
  'and the payout did not move, because the whole transaction unwound'
);

select extensions.is(
  (select state from public.tasks where id = pg_temp.poid('tgone')),
  'payout_pending'::public.task_state,
  'nor did the step'
);

-- (b) The step was cancelled while the transfer was in flight.
insert into public.payouts
  (engagement_id, node_id, project_id, task_id, amount, platform_fee, currency, idempotency_key)
select e.id, e.node_id, e.project_id, e.task_id, e.agreed_price, 0, e.currency, 'payout:' || e.id
from public.engagements e where e.task_id = pg_temp.poid('tcancel');

update public.tasks set state = 'cancelled' where id = pg_temp.poid('tcancel');

select extensions.throws_ok(
  format($q$select public.settle_payout(%L, 'tr_fake_cancel')$q$,
         (select id from public.payouts where task_id = pg_temp.poid('tcancel'))),
  '23514',
  null,
  'a step cancelled mid-flight refuses the settlement rather than paying against it'
);

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.poid('tcancel')),
  'held',
  'and its hold is untouched, so the reconcile sweep can still give the money back'
);

select extensions.is(
  (select outcome from public.engagements where task_id = pg_temp.poid('tcancel')),
  null,
  'and the deal has no outcome, because nothing about it completed'
);

-- ------------------------------------------- write-once and grants (7)

select extensions.throws_ok(
  format($q$update public.payouts set transfer_id = 'tr_fake_second' where task_id = %L$q$,
         pg_temp.poid('tpay')),
  '23514',
  null,
  'a transfer reference is written once: a writer that could clear it could make a paid payout look unpaid'
);

select extensions.throws_ok(
  format($q$update public.payouts set amount = 1.00 where task_id = %L$q$, pg_temp.poid('tpay')),
  '23514',
  null,
  'and the amount cannot be edited: a re-priced payment is a new payout, not an edit'
);

select extensions.ok(
  not has_table_privilege('service_role', 'public.payouts', 'DELETE'),
  'not even service_role may delete a payout: it is a money record'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.payouts', 'UPDATE'),
  'and a client cannot write one at all'
);

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('n1'),
    'select count(*) from public.payouts'),
  1::bigint,
  'a node reads their own payout: "was I paid" is the one money fact the engagement was about'
);

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('n2'),
    format('select count(*) from public.payouts where task_id = %L', pg_temp.poid('tpay'))),
  0::bigint,
  'and never somebody else''s, even on the same project'
);

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('owner'),
    format('select count(*) from public.payouts where task_id = %L', pg_temp.poid('tpay'))),
  1::bigint,
  'the owner reads what was paid out of their own authorised budget'
);

-- --------------------------- the counterparty pair after payment (3)
--
-- `20260907123000`. Ending the engagement is what pays somebody, and before that
-- migration it would also have been what erased their name from the panel — at
-- the exact moment slice 8 is going to ask the owner to rate them.

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('owner'),
    format('select count(*) from public.profiles where user_id = %L', pg_temp.poid('n1'))),
  1::bigint,
  'the owner still reads the node who was paid, after the deal ended as completed'
);

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('n1'),
    format('select count(*) from public.profiles where user_id = %L', pg_temp.poid('owner'))),
  1::bigint,
  'and the node still reads the owner, in both directions as 20260904126000 opened it'
);

-- A deal that ended **without delivering** closes the pair again. Ended directly
-- rather than through `reassign_engagement`, because that function refuses a step
-- past `in_progress` by design (a deadline passing after delivery is the owner's
-- failure to review) and this fixture walked every step to `approved`. The write
-- goes through the same write-once guard either way, which is what the pair reads.
update public.engagements
set ended_at = now(), outcome = 'reassigned'
where task_id = pg_temp.poid('tother') and ended_at is null;

select extensions.is(
  pg_temp.pocount_as(pg_temp.poid('owner'),
    format('select count(*) from public.profiles where user_id = %L', pg_temp.poid('n2'))),
  0::bigint,
  'but a reassigned deal closes the pair again: nothing was delivered, so there is nobody to rate'
);

-- ------------------------------------------------ the AI arm (2)
--
-- **These two were stated as an absence and are now stated as a boundary.** Slice
-- 7 left `approved -> done` with no AI-side producer on the grounds that it
-- belongs to business-projects-workflow.md rather than to a marketplace slice.
-- That module has since produced one, in `executeTask` and in the owner-answer
-- routes, and no migration was needed because the arc was always legal.
--
-- What still has to hold from HERE is the other half of that boundary: the arc
-- exists, and `approved` stays non-terminal, because `approve_work` lands on it
-- and `PAYABLE_TASK_STATES` selects on it. A step whose expert is still owed the
-- escrow must remain reachable by the payout sweep, so making `approved` itself
-- terminal is the change this file exists to refuse. The AI arm's own walk is
-- asserted where it belongs, in `artifacts.sql`.

select extensions.ok(
  private.task_transition_allowed('approved', 'done'),
  'approved -> done is in the map, which is what the AI arm walks without a migration'
);

select extensions.ok(
  not private.task_state_is_terminal('approved'),
  'and approved stays non-terminal, because an expert waiting on escrow is read from that state'
);

select * from extensions.finish();
rollback;
