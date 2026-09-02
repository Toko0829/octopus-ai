-- marketplace_ratings.sql — slice 8: two-sided scores, and trust_score's first writer.
--
-- A new file rather than growth of an earlier suite, on
-- `marketplace_engagements.sql:9-12`'s rule.
--
-- **The property this suite exists for** is the one that is easy to get wrong
-- and impossible to see: `node_profiles.trust_score` has been NULL on every row
-- in the database since `20260831120000`, and the column comment fixed what NULL
-- means before there was a writer — "cold start, never zero, because zero would
-- mean measured and worthless." A `coalesce` or a `left join` anywhere in
-- `submit_rating` would quietly rewrite that, and nothing in the application
-- would notice, because a node whose score reads 0.0000 looks scored rather than
-- unscored and simply stops being offered work.
--
-- The other half is the **outcome gate**. Rating is offered on `completed` and
-- nothing else, which excludes `disputed_resolved` deliberately: an operator has
-- already decided that one, and a score collected from whoever lost is a rating
-- about the verdict rather than about the work.

begin;

select extensions.plan(24);

-- ---------------------------------------------------------------- fixtures

create temporary table rtids (k text primary key, v uuid);
insert into rtids (k, v) values
  ('owner',    gen_random_uuid()),
  ('stranger', gen_random_uuid()),
  ('ops',      gen_random_uuid()),
  ('n1', gen_random_uuid()),
  ('n2', gen_random_uuid()),
  ('n3', gen_random_uuid()),
  ('p1', gen_random_uuid()),
  ('r1', gen_random_uuid()),
  ('c1', gen_random_uuid()),
  -- Two steps the same node completes, so the average has something to average.
  ('tone', gen_random_uuid()), ('oone', gen_random_uuid()),
  -- A second node, one completed deal, to prove the recompute is per-person.
  ('ttwo', gen_random_uuid()), ('otwo', gen_random_uuid()),
  -- A deal that ends in a dispute, which must stay unrateable.
  ('tdis', gen_random_uuid()), ('odis', gen_random_uuid());

create or replace function pg_temp.rid(text) returns uuid language sql stable as
  $$ select v from rtids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.rid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@rating.invalid', '', now(), now(), now()
from (values ('owner'), ('stranger'), ('ops'), ('n1'), ('n2'), ('n3')) as t(k);

select set_config('request.jwt.claims', '', true);

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
select pg_temp.rid(k), 'verified', 'available', array['US-TX'], array['en'], 300.00, 'task', 'USD'
from (values ('n1'), ('n2'), ('n3')) as t(k);

insert into public.projects (id, owner_id, goal, status, budget_ceiling, currency)
values (pg_temp.rid('p1'), pg_temp.rid('owner'), 'Ship the launch', 'active', 9000.00, 'USD');

insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.rid('r1'), 'Launch', pg_temp.rid('owner'), pg_temp.rid('p1'));

insert into public.channels (id, room_id, name, position)
values (pg_temp.rid('c1'), pg_temp.rid('r1'), 'general', 0);

insert into public.room_members (room_id, user_id, role, scope)
values (pg_temp.rid('r1'), pg_temp.rid('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values
  (pg_temp.rid('tone'), pg_temp.rid('p1'), 'First job',  'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.rid('ttwo'), pg_temp.rid('p1'), 'Second job', 'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.rid('tdis'), pg_temp.rid('p1'), 'Disputed job', 'content', 'human', 'offered', '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values
  (pg_temp.rid('oone'), pg_temp.rid('tone'), pg_temp.rid('p1'), pg_temp.rid('n1'), 0, now() + interval '48 hours'),
  (pg_temp.rid('otwo'), pg_temp.rid('ttwo'), pg_temp.rid('p1'), pg_temp.rid('n2'), 0, now() + interval '48 hours'),
  (pg_temp.rid('odis'), pg_temp.rid('tdis'), pg_temp.rid('p1'), pg_temp.rid('n3'), 0, now() + interval '48 hours');

create or replace function pg_temp.rcount_as(p_user uuid, p_sql text)
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

select public.accept_offer(pg_temp.rid('oone'), 'ch_fake_rone');
select public.accept_offer(pg_temp.rid('otwo'), 'ch_fake_rtwo');
select public.accept_offer(pg_temp.rid('odis'), 'ch_fake_rdis');

-- Walk the two clean steps to `approved`, one arc at a time so every guard
-- fires, then pay them through the real settlement so `outcome` is what
-- `settle_payout` writes rather than what a fixture asserts.
update public.tasks set state = 'in_progress'     where id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));
update public.tasks set state = 'proof_submitted' where id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));
update public.tasks set state = 'in_review'       where id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));
update public.tasks set state = 'approved'        where id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));
update public.tasks set state = 'payout_pending'  where id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));

insert into public.payouts (engagement_id, node_id, project_id, task_id, amount, currency, idempotency_key)
select e.id, e.node_id, e.project_id, e.task_id, h.amount, h.currency, 'payout:' || e.id::text
from public.engagements e
join public.escrow_holds h on h.task_id = e.task_id and h.state = 'held'
where e.task_id in (pg_temp.rid('tone'), pg_temp.rid('ttwo'));

select public.settle_payout(
  (select id from public.payouts where task_id = pg_temp.rid('tone')), 'tr_fake_rone');
select public.settle_payout(
  (select id from public.payouts where task_id = pg_temp.rid('ttwo')), 'tr_fake_rtwo');

-- And drive the third to a resolved dispute, so "readable but not rateable" has
-- something real to be true about.
update public.tasks set state = 'in_progress' where id = pg_temp.rid('tdis');
select public.raise_dispute(pg_temp.rid('tdis'), pg_temp.rid('owner'), 'owner', 'Nothing arrived');
select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.rid('tdis')),
  pg_temp.rid('ops'), 'refunded', 'Nothing was delivered.');

-- ------------------------------------------- cold start (2)

select extensions.is(
  (select count(*) from public.node_profiles where trust_score is not null)::int,
  0,
  'trust_score is NULL on every node before anybody rates: cold start, never zero, because zero '
  'would mean measured and worthless');

select extensions.is(
  (select completed_engagements from public.node_profiles where user_id = pg_temp.rid('n1'))::int,
  1,
  'completed_engagements moved when the payout settled, which is the count a matcher can read '
  'beside a score rather than folded into it');

-- ------------------------------------------- the owner rates (6)

select public.submit_rating(
  (select id from public.engagements where task_id = pg_temp.rid('tone')),
  pg_temp.rid('owner'), 4, 'Late but good.');

select extensions.is(
  (select direction from public.ratings
    where engagement_id = (select id from public.engagements where task_id = pg_temp.rid('tone'))),
  'owner_of_node',
  'the direction is derived from the engagement rather than passed, so a caller cannot mislabel '
  'a score');

select extensions.is(
  (select ratee_id from public.ratings
    where engagement_id = (select id from public.engagements where task_id = pg_temp.rid('tone'))),
  pg_temp.rid('n1'),
  'and so is the ratee: the owner rated the node who did the work');

select extensions.is(
  (select trust_score from public.node_profiles where user_id = pg_temp.rid('n1')),
  0.8000::numeric,
  'trust_score is avg(score)/5, written in the same transaction as the rating that moves it');

select extensions.is(
  (select trust_score is null from public.node_profiles where user_id = pg_temp.rid('n2')),
  true,
  'and only for the node who was rated: nobody else''s score moved');

select extensions.is(
  (select public.submit_rating(
     (select id from public.engagements where task_id = pg_temp.rid('tone')),
     pg_temp.rid('owner'), 1, 'changed my mind')),
  (select id from public.ratings
    where engagement_id = (select id from public.engagements where task_id = pg_temp.rid('tone'))
      and direction = 'owner_of_node'),
  'a second submission returns the first rating rather than replacing it: the unique index is '
  'the control and a score cannot be revised after the other side reads it');

select extensions.is(
  (select trust_score from public.node_profiles where user_id = pg_temp.rid('n1')),
  0.8000::numeric,
  'and the replayed submission moved nothing, so a retry cannot walk somebody''s score down');

-- ------------------------------------------- the node rates back (3)

select public.submit_rating(
  (select id from public.engagements where task_id = pg_temp.rid('tone')),
  pg_temp.rid('n1'), 5, 'Clear brief.');

select extensions.is(
  (select count(*) from public.ratings
    where engagement_id = (select id from public.engagements where task_id = pg_temp.rid('tone')))::int,
  2,
  'both directions land on one deal: a market where only the buyer rates puts all the '
  'reputational risk on the individual being paid');

select extensions.is(
  (select direction from public.ratings
    where engagement_id = (select id from public.engagements where task_id = pg_temp.rid('tone'))
      and rater_id = pg_temp.rid('n1')),
  'node_of_owner',
  'the node''s score is filed in the other direction, derived the same way');

select extensions.is(
  (select trust_score is null from public.node_profiles where user_id = pg_temp.rid('n1')),
  false,
  'rating the owner did not disturb the node''s own score');

-- ------------------------------------------- the average is a recompute (2)

select public.submit_rating(
  (select id from public.engagements where task_id = pg_temp.rid('ttwo')),
  pg_temp.rid('owner'), 2, 'Missed the deadline.');

select extensions.is(
  (select trust_score from public.node_profiles where user_id = pg_temp.rid('n2')),
  0.4000::numeric,
  'the second node''s score is their own average, not the market''s');

select extensions.is(
  (select trust_score from public.node_profiles where user_id = pg_temp.rid('n1')),
  0.8000::numeric,
  'and the first node''s is unchanged: the recompute is scoped to the ratee');

-- ------------------------------------------- what cannot be rated (4)

select extensions.throws_ok(
  format($q$ select public.submit_rating(%L, %L, 5, null) $q$,
         (select id from public.engagements where task_id = pg_temp.rid('tdis')),
         pg_temp.rid('owner')),
  '23514', null,
  'a deal that ended in a resolved dispute cannot be rated: an operator already decided it, and '
  'a score collected from whoever lost would be about the verdict rather than the work');

select extensions.is(
  (select trust_score is null from public.node_profiles where user_id = pg_temp.rid('n3')),
  true,
  'so the disputed node keeps a NULL score rather than acquiring one from the argument');

select extensions.throws_ok(
  format($q$ select public.submit_rating(%L, %L, 5, null) $q$,
         (select id from public.engagements where task_id = pg_temp.rid('ttwo')),
         pg_temp.rid('stranger')),
  '42501', null,
  'somebody who is neither party cannot rate a deal at all');

select extensions.throws_ok(
  format($q$ select public.submit_rating(%L, %L, 9, null) $q$,
         (select id from public.engagements where task_id = pg_temp.rid('ttwo')),
         pg_temp.rid('owner')),
  '23514', null,
  'a score outside one to five is refused: the surface is five stars and nothing should be able '
  'to write what no person could enter');

-- ------------------------------------------- who reads a rating (3)

select extensions.is(
  pg_temp.rcount_as(pg_temp.rid('owner'), 'select count(*) from public.ratings'),
  3::bigint,
  'the owner reads every rating on their own project, both directions, which is the whole of '
  '"visible immediately"');

select extensions.is(
  pg_temp.rcount_as(pg_temp.rid('n1'), 'select count(*) from public.ratings'),
  2::bigint,
  'a node reads both ratings on their own deal, including the one about them');

select extensions.is(
  pg_temp.rcount_as(pg_temp.rid('stranger'), 'select count(*) from public.ratings'),
  0::bigint,
  'somebody with no part in the project reads nothing');

-- ------------------------------------------- what stays shut (4)

select extensions.ok(
  not has_table_privilege('authenticated', 'public.ratings', 'INSERT'),
  'no client writes a rating: the same statement writes node_profiles.trust_score, and that '
  'table gives authenticated no write grant at all');

select extensions.ok(
  not has_table_privilege('service_role', 'public.ratings', 'UPDATE'),
  'not even service_role edits one: an editable rating can be changed after the other side '
  'reads it');

select extensions.ok(
  not has_table_privilege('service_role', 'public.ratings', 'DELETE'),
  'nor deletes one: a trust graph that can be quietly cleaned up is not a trust graph');

select extensions.ok(
  not has_function_privilege('authenticated', 'public.submit_rating(uuid, uuid, integer, text)', 'EXECUTE'),
  'submit_rating is service_role alone; the party check is inside it because both parties are '
  'ordinary authenticated users');

select * from extensions.finish();

rollback;
