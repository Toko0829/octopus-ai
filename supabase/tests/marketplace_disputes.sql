-- marketplace_disputes.sql — slice 8: the four restored arcs, the five resolutions,
-- and the ledger arithmetic a partial settlement produces.
--
-- A new file rather than growth of `marketplace_payout.sql`, on
-- `marketplace_engagements.sql:9-12`'s rule: `plan(N)` is exact, and growing a
-- suite whose subject is an earlier slice means editing what it pins.
--
-- **What this suite is really for.** Three things in slice 8 are only checkable
-- here, because no unit test can reach them:
--
--   1. the transition map, asserted **directly** so a broken arc names itself
--      rather than surfacing as a failed write several assertions later;
--   2. the **partial settlement's six ledger entries across two holds**, which
--      is the arithmetic ADR-0025 argues for and the one place a mistake would
--      be money rather than a message;
--   3. that `ops_actions` cannot be edited **by `service_role`**, which is the
--      only role this build ever writes it with.
--
-- Fixture idiom, role-switch helper and the write-then-assert-in-separate-
-- statements rule are `marketplace_payout.sql`'s; the prefix is `d` so nothing
-- collides if suites are ever run in one session.

begin;

select extensions.plan(62);

-- ---------------------------------------------------------------- fixtures

create temporary table dsids (k text primary key, v uuid);
insert into dsids (k, v) values
  ('owner',    gen_random_uuid()),
  ('stranger', gen_random_uuid()),
  ('ops',      gen_random_uuid()),
  -- One node per step: `room_members` is keyed on `(room_id, user_id)`
  -- (ADR-0017), so a node works one step of a project at a time and
  -- `accept_offer` refuses the second acceptance.
  ('n1', gen_random_uuid()),
  ('n2', gen_random_uuid()),
  ('n3', gen_random_uuid()),
  ('n4', gen_random_uuid()),
  ('n5', gen_random_uuid()),
  ('p1', gen_random_uuid()),
  ('r1', gen_random_uuid()),
  ('c1', gen_random_uuid()),
  -- One step per resolution, plus one the node disputes.
  ('trel',  gen_random_uuid()), ('orel',  gen_random_uuid()),
  ('tpart', gen_random_uuid()), ('opart', gen_random_uuid()),
  ('tref',  gen_random_uuid()), ('oref',  gen_random_uuid()),
  ('trea',  gen_random_uuid()), ('orea',  gen_random_uuid()),
  ('tupd',  gen_random_uuid()), ('oupd',  gen_random_uuid());

create or replace function pg_temp.did(text) returns uuid language sql stable as
  $$ select v from dsids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.did(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@dispute.invalid', '', now(), now(), now()
from (values ('owner'), ('stranger'), ('ops'), ('n1'), ('n2'), ('n3'), ('n4'), ('n5')) as t(k);

-- Claims cleared so guard triggers file their events as `system`, which is what
-- a service_role connection actually produces.
select set_config('request.jwt.claims', '', true);

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
select pg_temp.did(k), 'verified', 'available', array['US-TX'], array['en'], 400.00, 'task', 'USD'
from (values ('n1'), ('n2'), ('n3'), ('n4'), ('n5')) as t(k);

insert into public.projects (id, owner_id, goal, status, budget_ceiling, currency)
values (pg_temp.did('p1'), pg_temp.did('owner'), 'Ship the launch', 'active', 9000.00, 'USD');

insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.did('r1'), 'Launch', pg_temp.did('owner'), pg_temp.did('p1'));

insert into public.channels (id, room_id, name, position)
values (pg_temp.did('c1'), pg_temp.did('r1'), 'general', 0);

insert into public.room_members (room_id, user_id, role, scope)
values (pg_temp.did('r1'), pg_temp.did('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values
  (pg_temp.did('trel'),  pg_temp.did('p1'), 'Released after dispute',  'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.did('tpart'), pg_temp.did('p1'), 'Split after dispute',     'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.did('tref'),  pg_temp.did('p1'), 'Refunded after dispute',  'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.did('trea'),  pg_temp.did('p1'), 'Back to the market',      'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.did('tupd'),  pg_temp.did('p1'), 'Rejection upheld',        'content', 'human', 'offered', '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values
  (pg_temp.did('orel'),  pg_temp.did('trel'),  pg_temp.did('p1'), pg_temp.did('n1'), 0, now() + interval '48 hours'),
  (pg_temp.did('opart'), pg_temp.did('tpart'), pg_temp.did('p1'), pg_temp.did('n2'), 0, now() + interval '48 hours'),
  (pg_temp.did('oref'),  pg_temp.did('tref'),  pg_temp.did('p1'), pg_temp.did('n3'), 0, now() + interval '48 hours'),
  (pg_temp.did('orea'),  pg_temp.did('trea'),  pg_temp.did('p1'), pg_temp.did('n4'), 0, now() + interval '48 hours'),
  (pg_temp.did('oupd'),  pg_temp.did('tupd'),  pg_temp.did('p1'), pg_temp.did('n5'), 0, now() + interval '48 hours');

create or replace function pg_temp.dcount_as(p_user uuid, p_sql text)
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

-- The real RPC as the fixture builder, so what is disputed is what acceptance
-- actually funds rather than a hand-built hold.
select public.accept_offer(pg_temp.did('orel'),  'ch_fake_drel');
select public.accept_offer(pg_temp.did('opart'), 'ch_fake_dpart');
select public.accept_offer(pg_temp.did('oref'),  'ch_fake_dref');
select public.accept_offer(pg_temp.did('orea'),  'ch_fake_drea');
select public.accept_offer(pg_temp.did('oupd'),  'ch_fake_dupd');

-- ------------------------------------------- the restored arcs, directly (13)
--
-- Asserted against the map function with no fixture, on `20260904121000:97-99`'s
-- rule: a broken arc names itself instead of surfacing as a failed write several
-- assertions later. Presences first, then absences.

select extensions.ok(private.task_transition_allowed('escrow_funded', 'disputed'),
  'the owner can dispute a step that was paid for and never started');
select extensions.ok(private.task_transition_allowed('in_progress', 'disputed'),
  'the owner can dispute a step while the work is happening');
select extensions.ok(private.task_transition_allowed('rejected', 'disputed'),
  'the node can dispute work the owner sent back: the only arc a node walks against the owner');
select extensions.ok(private.task_transition_allowed('payout_pending', 'disputed'),
  'the owner can dispute after approving and before the sweep pays, which is what freezes it');
select extensions.ok(private.task_transition_allowed('in_review', 'disputed'),
  'in_review keeps the arc it has had since 20260815220000, though nothing rests there to use it');

select extensions.ok(private.task_transition_allowed('disputed', 'approved'),
  'released returns the step to approved, where the existing payout sweep finishes it');
select extensions.ok(private.task_transition_allowed('disputed', 'cancelled'),
  'refunded and partial close the step');
select extensions.ok(private.task_transition_allowed('disputed', 'matching'),
  'reassigned sends the step back to the market: the one arc this slice invents');
select extensions.ok(private.task_transition_allowed('disputed', 'rejected'),
  'rejection_upheld returns the step to the node to redo');

-- The absences, worded descriptively rather than promissorily
-- (`20260904121000:113-119`): each states what is true, not what a later slice
-- will do about it.
select extensions.ok(not private.task_transition_allowed('disputed', 'in_progress'),
  'no arc from disputed straight back to in_progress: returning work to the same node goes '
  'through rejected, which records what was decided (ADR-0026)');
select extensions.ok(not private.task_transition_allowed('approved', 'disputed'),
  'no arc from approved: it is the state the payout sweep picks up first, and an owner who '
  'changes their mind has payout_pending one tick later');
select extensions.ok(not private.task_transition_allowed('paid', 'disputed'),
  'no arc from paid: transfer_id is write-once and the money has left');
select extensions.ok(not private.task_transition_allowed('proof_submitted', 'disputed'),
  'no arc from proof_submitted: work handed over and not yet judged is a review, and the owner '
  'has reject_work with a required note');

-- ------------------------------------------- the payout arc (3)

select extensions.ok(private.payout_transition_allowed('pending', 'failed'),
  'a pending payout can fail, which is how a dispute closes one whose hold it just refunded');
select extensions.ok(private.payout_transition_allowed('pending', 'paid'),
  'settling still works: the arc slice 7 produced is untouched');
select extensions.ok(not private.payout_transition_allowed('failed', 'pending'),
  'no way back from failed: the money went back to the owner, so retrying would pay for a refund');

-- ------------------------------------------- raising (8)

-- Walk `trel` to in_progress so the owner's dispute has somewhere to leave from,
-- then raise. Separate statements throughout: a function that inserts, called in
-- the same statement that reads the table it inserted into, sees the
-- pre-statement snapshot (`marketplace_payout.sql:31-34`).
update public.tasks set state = 'in_progress' where id = pg_temp.did('trel');
select public.raise_dispute(pg_temp.did('trel'), pg_temp.did('owner'), 'owner', 'The video never arrived');

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('trel')),
  'disputed',
  'raising moves the step to disputed, which IS the freeze: PAYABLE_TASK_STATES stops matching it');

select extensions.is(
  (select count(*) from public.disputes where task_id = pg_temp.did('trel'))::int,
  1,
  'one dispute row, written in the same transaction as the freeze');

select extensions.is(
  (select from_state::text from public.disputes where task_id = pg_temp.did('trel')),
  'in_progress',
  'from_state records where it was raised from, which resolve_dispute reads and a reader needs');

select extensions.is(
  (select raised_role from public.disputes where task_id = pg_temp.did('trel')),
  'owner',
  'the side that raised it is recorded, and stays true after a role changes');

select extensions.is(
  (select resolution is null and resolved_at is null from public.disputes where task_id = pg_temp.did('trel')),
  true,
  'open is derived as resolved_at is null: there is no status column to disagree with tasks.state');

-- Idempotency: a second raise returns the first dispute rather than colliding on
-- the partial unique index.
select extensions.is(
  (select public.raise_dispute(pg_temp.did('trel'), pg_temp.did('owner'), 'owner', 'again')),
  (select id from public.disputes where task_id = pg_temp.did('trel')),
  'raising twice returns the open dispute rather than handing the caller a constraint violation');

select extensions.throws_ok(
  format($q$ select public.raise_dispute(%L, %L, 'node', 'I disagree') $q$,
         pg_temp.did('tpart'), pg_temp.did('n2')),
  '23514', null,
  'a node cannot dispute a step that is not rejected: theirs is the arc from work sent back');

select extensions.throws_ok(
  format($q$ select public.raise_dispute(%L, %L, 'owner', '   ') $q$,
         pg_temp.did('tpart'), pg_temp.did('owner')),
  '23514', null,
  'a dispute needs a stated reason: a freeze with no grievance is one nobody can resolve');

-- ------------------------------------------- released: no money moves (5)

-- `from_state` is load-bearing rather than historical, and this is what makes it
-- so: upholding a rejection is meaningless about a dispute raised mid-work.
select extensions.throws_ok(
  format($q$ select public.resolve_dispute(%L, %L, 'rejection_upheld', 'the rejection stands') $q$,
         (select id from public.disputes where task_id = pg_temp.did('trel')),
         pg_temp.did('ops')),
  '23514', null,
  'rejection_upheld is refused on a dispute raised from in_progress: there is no rejection to '
  'uphold, and from_state is the column that knows');

select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('trel')),
  pg_temp.did('ops'), 'released', 'The footage was delivered late but in full.');

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('trel')),
  'approved',
  'released returns the step to approved, where the existing payout sweep finishes it');

select extensions.is(
  (select ended_at is null from public.engagements where task_id = pg_temp.did('trel')),
  true,
  'released leaves the deal live, because the sweep has to be able to pay it');

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.did('trel')),
  'held',
  'released moves no money here: the hold stays held and the sweep releases it, so there is not '
  'a second way to pay somebody');

select extensions.is(
  (select count(*) from public.ledger_entries le
    join public.escrow_holds h on h.id = le.ref_id
    where h.task_id = pg_temp.did('trel'))::int,
  2,
  'only acceptance''s pair exists on a released dispute: nothing settled, so nothing was entered');

-- ------------------------------------------- partial: the six entries (8)

update public.tasks set state = 'in_progress' where id = pg_temp.did('tpart');
select public.raise_dispute(pg_temp.did('tpart'), pg_temp.did('owner'), 'owner', 'Half of it is usable');

select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('tpart')),
  pg_temp.did('ops'), 'partial', 'One of the two videos was usable.', 150.00);

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('tpart')),
  'cancelled',
  'a partial closes the step: an owner who still wants the work has reassigned');

select extensions.is(
  (select count(*) from public.escrow_holds where task_id = pg_temp.did('tpart'))::int,
  2,
  'a partial mints a SECOND hold rather than editing the first: both settlements are terminal '
  'and neither reaches the other (ADR-0025)');

select extensions.is(
  (select count(*) from public.escrow_holds where task_id = pg_temp.did('tpart') and state = 'held')::int,
  0,
  'no held residue survives the transaction, which is why ADR-0020''s four committed-budget '
  'sums need no change at all');

select extensions.is(
  (select idempotency_key from public.escrow_holds
    where task_id = pg_temp.did('tpart') and amount = 150.00),
  'dispute-release:' || (select id from public.disputes where task_id = pg_temp.did('tpart'))::text,
  'the new hold''s key is derived from the dispute row, so a re-disputed task derives a new one');

select extensions.is(
  (select count(*) from public.ledger_entries le
    join public.escrow_holds h on h.id = le.ref_id
    where h.task_id = pg_temp.did('tpart'))::int,
  8,
  'eight entries across two holds, four each: the original was funded at acceptance and reversed '
  'in full, and the new one was funded and released. Every hold this system settles carries four '
  'entries, which is what makes "this hold is finished" a fact a reader derives rather than a '
  'column they trust');

-- The property that matters more than the count: every hold nets to zero, and
-- the two sides of the split are what the operator entered.
select extensions.is(
  (select sum(debit) - sum(credit) from public.ledger_entries le
    join public.escrow_holds h on h.id = le.ref_id
    where h.task_id = pg_temp.did('tpart')),
  0::numeric,
  'the whole settlement balances: debits equal credits across both holds');

select extensions.is(
  (select sum(credit) - sum(debit) from public.ledger_entries le
    join public.escrow_holds h on h.id = le.ref_id
    where h.task_id = pg_temp.did('tpart') and le.account = 'node_payable'),
  150.00::numeric,
  'the expert is owed exactly what the operator released, and nothing else reaches node_payable');

select extensions.is(
  (select sum(debit) - sum(credit) from public.ledger_entries le
    join public.escrow_holds h on h.id = le.ref_id
    where h.task_id = pg_temp.did('tpart') and le.account = 'owner_funds'),
  150.00::numeric,
  'the owner is out exactly the released share and nothing more, across the whole task. Read as '
  'a net rather than as "250 came back", because 250 is only true of the second hold: the first '
  'was refunded in full and 150 of it was then re-committed, which is what makes a partial a '
  'composition of settlements rather than a settlement of its own (ADR-0025)');

-- ------------------------------------------- refunded and reassigned (6)

update public.tasks set state = 'in_progress' where id = pg_temp.did('tref');
select public.raise_dispute(pg_temp.did('tref'), pg_temp.did('owner'), 'owner', 'Nothing was delivered');
select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('tref')),
  pg_temp.did('ops'), 'refunded', 'Nothing was delivered at all.');

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('tref')),
  'cancelled',
  'a full refund closes the step');

select extensions.is(
  (select outcome from public.engagements where task_id = pg_temp.did('tref')),
  'disputed_resolved',
  'disputed_resolved gets its first producer: the value has been in the check constraint since '
  '20260904120000 with nothing able to write it');

select extensions.is(
  (select state from public.escrow_holds where task_id = pg_temp.did('tref')),
  'refunded',
  'the hold goes back in full');

update public.tasks set state = 'in_progress' where id = pg_temp.did('trea');
select public.raise_dispute(pg_temp.did('trea'), pg_temp.did('owner'), 'owner', 'They stopped answering');
select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('trea')),
  pg_temp.did('ops'), 'reassigned', 'The expert stopped answering, and the work is still wanted.');

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('trea')),
  'matching',
  'reassigned sends the step back to the market, where a different expert can take it');

select extensions.is(
  (select expires_at is not null from public.room_members
    where user_id = pg_temp.did('n4')
      and thread_id = (select id from public.threads where task_id = pg_temp.did('trea'))),
  true,
  'thread access is STAMPED rather than deleted, so the roster still records that this person '
  'was here, which is what the next dispute reads');

select extensions.is(
  (select count(*) from public.engagements
    where task_id = pg_temp.did('trea') and ended_at is null)::int,
  0,
  'the deal ends, so engagements_one_live_idx lets a replacement acceptance create a second row');

-- ------------------------------------------- the node's arc, upheld (3)

update public.tasks set state = 'in_progress'     where id = pg_temp.did('tupd');
update public.tasks set state = 'proof_submitted' where id = pg_temp.did('tupd');
update public.tasks set state = 'in_review'       where id = pg_temp.did('tupd');
update public.tasks set state = 'rejected'        where id = pg_temp.did('tupd');
select public.raise_dispute(pg_temp.did('tupd'), pg_temp.did('n5'), 'node', 'The brief said 30 seconds');

select extensions.is(
  (select raised_role from public.disputes where task_id = pg_temp.did('tupd')),
  'node',
  'a node can raise from rejected: without it their only recourse is to stop answering, which '
  'the no-show sweep reads as their failure');

select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('tupd')),
  pg_temp.did('ops'), 'rejection_upheld', 'The brief did say 60 seconds.');

select extensions.is(
  (select state::text from public.tasks where id = pg_temp.did('tupd')),
  'rejected',
  'upholding returns the step to rejected, from which the node redoes it under the same agreement');

select extensions.is(
  (select ended_at is null from public.engagements where task_id = pg_temp.did('tupd')),
  true,
  'upholding leaves the deal live, because the node is about to do the work again');

-- ------------------------------------------- the ops trail (6)

select extensions.is(
  (select count(*) from public.ops_actions where action = 'dispute.resolve')::int,
  5,
  'every resolution wrote an ops_actions row, in the same transaction as the money');

select extensions.is(
  (select count(*) from public.ops_actions where actor_id = pg_temp.did('ops'))::int,
  5,
  'the operator is named on every one, which is the whole reason this is not a verb in events');

select extensions.is(
  (select count(*) from public.ops_actions where btrim(reason) = '')::int,
  0,
  'no resolution was recorded without a stated reason: admin-ops.md''s rule, enforced by the '
  'not-null and by the check rather than by a convention');

-- **Asserted as a privilege rather than attempted as a write**, and the
-- difference is the whole reliability of these two. This suite runs as
-- `postgres`, which is a superuser and bypasses grants entirely, so an attempted
-- UPDATE would succeed here and prove nothing about what `service_role` may do.
-- `marketplace_payout.sql` established the idiom for exactly this reason.
select extensions.ok(
  not has_table_privilege('service_role', 'public.ops_actions', 'UPDATE'),
  'not even service_role may edit an ops action: the account being protected from is the one '
  'the operator is using');

select extensions.ok(
  not has_table_privilege('service_role', 'public.ops_actions', 'DELETE'),
  'not even service_role may delete one');

select extensions.ok(
  not has_table_privilege('authenticated', 'public.ops_actions', 'SELECT'),
  'no client role reads the ops trail at all: the ledger_entries posture, and the reader is the '
  'API behind require-ops');

-- ------------------------------------------- resolving is written once (2)

-- **A second decision is ignored, not refused**, and this asserts the behaviour
-- rather than the shape somebody might expect. `resolve_dispute` puts
-- idempotency before validation, this domain's ordering in all four writers, so
-- a replay short-circuits before it ever reads the resolution being asked for.
-- The safety property is what matters and it holds either way: the first
-- decision stands and no second settlement is made. The route surfaces it
-- honestly by returning the stored resolution with `replayed: true`, so nobody
-- is told their new answer was taken.
select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.did('trea')),
  pg_temp.did('ops'), 'refunded', 'changed my mind');

select extensions.is(
  (select resolution from public.disputes where task_id = pg_temp.did('trea')),
  'reassigned',
  'asking again with a different outcome leaves the first decision standing: the second would '
  'move money against a hold the first already settled');

select extensions.is(
  (select public.resolve_dispute(
     (select id from public.disputes where task_id = pg_temp.did('tref')),
     pg_temp.did('ops'), 'refunded', 'Nothing was delivered at all.')),
  (select id from public.disputes where task_id = pg_temp.did('tref')),
  'replaying the same resolution returns the dispute rather than re-deciding it');

-- ------------------------------------------- who can read one (4)

select extensions.is(
  pg_temp.dcount_as(pg_temp.did('owner'),
    'select count(*) from public.disputes'),
  5::bigint,
  'the owner reads every dispute on their own project, through is_project_member');

select extensions.is(
  pg_temp.dcount_as(pg_temp.did('n5'),
    'select count(*) from public.disputes'),
  1::bigint,
  'a node reads the dispute on their own deal and no others, including one raised against them: '
  'a node who cannot read the grievance cannot answer it');

select extensions.is(
  pg_temp.dcount_as(pg_temp.did('stranger'),
    'select count(*) from public.disputes'),
  0::bigint,
  'somebody with no part in the project reads nothing');

select extensions.ok(
  not has_table_privilege('authenticated', 'public.disputes', 'INSERT'),
  'no client may write a dispute row: raising moves tasks.state in the same transaction, and a '
  'row without the move is a freeze that is not freezing anything');

-- ------------------------------------------- what stays shut (4)

select extensions.ok(
  not has_table_privilege('authenticated', 'public.disputes', 'DELETE'),
  'a dispute is never deleted by a client');

select extensions.ok(
  not has_table_privilege('service_role', 'public.disputes', 'DELETE'),
  'nor by service_role: a record of an accusation and a decision about somebody''s money is not '
  'a record if trusted code can remove it');

select extensions.ok(
  not has_function_privilege('authenticated', 'public.resolve_dispute(uuid, uuid, text, text, numeric)', 'EXECUTE'),
  'resolving is service_role alone; the operator check is the API layer reading profiles.role');

select extensions.ok(
  not has_function_privilege('authenticated', 'public.raise_dispute(uuid, uuid, text, text, text)', 'EXECUTE'),
  'so is raising, for the same reason: the freeze and the record have to land together');

select * from extensions.finish();

rollback;
