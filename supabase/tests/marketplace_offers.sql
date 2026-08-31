-- Offer tests — covers 20260903120000 and 20260903121000.
--
-- The fifth marketplace table, and the first in this domain that lands with its
-- writer. `marketplace_rls.sql` asserts what a domain with no writer can be
-- given; `node_onboarding.sql` asserts the two functions that first wrote; this
-- one asserts the offer lifecycle, who can read an offer, and the two task arcs
-- the matcher actually drives.
--
-- **A separate file rather than more assertions in either**, for the reason
-- `node_onboarding.sql` gives about `marketplace_rls.sql`: `plan(N)` is exact,
-- and growing a suite whose subject is an earlier slice means editing what it
-- pins.
--
-- The role split follows `thread_scope.sql`. RLS and privilege assertions run as
-- `authenticated` with `request.jwt.claims` set, exactly as PostgREST would, so
-- what is being tested is the policy rather than a superuser bypassing it.
-- Constraint, trigger and map assertions run as `postgres`, deliberately: those
-- guards must bind trusted server code too, and the matcher writes with the
-- secret key.
--
-- Two things this file pins that are absences rather than behaviours, and both
-- are decisions somebody could reasonably "fix" later without realising:
--
--   * **The project owner reads zero offer rows.** An offer names a node, and
--     `20260901122000` closed the owner-sees-node and node-sees-owner pair
--     together. The engagement slice opens it deliberately, with a policy
--     written for it.
--   * **Nothing reaches `accepted`.** Worded here as what it is rather than as a
--     promise about a future slice, because this repository has just spent a
--     commit correcting a test message that said "restored in slice 4" about an
--     arc slice 4 then decided not to restore.
--
-- Everything is inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/marketplace_offers.sql

begin;

select extensions.plan(37);

-- ---------------------------------------------------------------- fixtures

create temporary table ofids (k text primary key, v uuid);
insert into ofids (k, v) values
  ('owner',    gen_random_uuid()),
  ('node',     gen_random_uuid()),
  ('other',    gen_random_uuid()),
  ('room',     gen_random_uuid()),
  ('project',  gen_random_uuid()),
  ('task',     gen_random_uuid()),
  ('offer',    gen_random_uuid());

create or replace function pg_temp.ofid(text) returns uuid language sql stable as
  $$ select v from ofids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.ofid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@offers.invalid', '', now(), now(), now()
from (values ('owner'), ('node'), ('other')) as t(k);

select set_config('request.jwt.claims', '', true);

-- Two nodes, both verified and available so they are a legal pool.
insert into public.node_profiles (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period)
values
  (pg_temp.ofid('node'),  'verified', 'available', array['US-TX'], array['en'], 120.00, 'hour'),
  (pg_temp.ofid('other'), 'verified', 'available', array['US-TX'], array['en'], 90.00,  'hour');

insert into public.projects (id, owner_id, goal, status)
values (pg_temp.ofid('project'), pg_temp.ofid('owner'), 'Grow the list', 'active');

-- The room is linked to the project, so the owner is a genuine project member
-- by `private.is_project_member` and still reads zero offers. Without the link
-- the owner assertion would pass for the uninteresting reason that they are a
-- stranger to the project rather than because the policy excludes them.
insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.ofid('room'), 'Offers room', pg_temp.ofid('owner'), pg_temp.ofid('project'));

insert into public.room_members (room_id, user_id, role, scope)
values (pg_temp.ofid('room'), pg_temp.ofid('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values (pg_temp.ofid('task'), pg_temp.ofid('project'), 'Write the launch emails',
        'conversion', 'human', 'matching', '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values (pg_temp.ofid('offer'), pg_temp.ofid('task'), pg_temp.ofid('project'),
        pg_temp.ofid('node'), 0, now() + interval '48 hours');

-- Run a count as a given user, exactly as PostgREST would. The role switch
-- happens INSIDE the function, which is `thread_scope.sql`'s pattern and is what
-- keeps the fixture lookups readable: the outer statement stays `postgres`, so
-- the temp tables it reads need no grants to a client role.
create or replace function pg_temp.ofcount_as(p_user uuid, p_sql text)
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

-- ------------------------------------------------- the lifecycle map (postgres)

select extensions.ok(
  private.offer_transition_allowed('open', 'declined'),
  'open -> declined: the node said no'
);
select extensions.ok(
  private.offer_transition_allowed('open', 'expired'),
  'open -> expired: the node said nothing'
);
select extensions.ok(
  private.offer_transition_allowed('open', 'withdrawn'),
  'open -> withdrawn: the task left the market underneath it'
);

-- Nothing reaches `accepted`. The value exists because `alter type ... add value`
-- is irreversible, and the arc does not because accepting is inseparable from
-- funding escrow. Whether that changes is a later slice's decision, taken with
-- the ledger write beside it.
select extensions.ok(
  not private.offer_transition_allowed('open', 'accepted'),
  'open -> accepted is refused: accepting funds escrow, which has no writer here'
);
select extensions.ok(
  not private.offer_transition_allowed('declined', 'accepted'),
  'declined -> accepted is refused'
);
select extensions.ok(
  not private.offer_transition_allowed('expired', 'accepted'),
  'expired -> accepted is refused'
);

-- The three settlements are terminal, so a cascade cannot reopen what it closed.
select extensions.ok(
  not private.offer_transition_allowed('declined', 'open'),
  'declined -> open is refused: a settled offer never reopens'
);
select extensions.ok(
  not private.offer_transition_allowed('expired', 'open'),
  'expired -> open is refused'
);
select extensions.ok(
  not private.offer_transition_allowed('withdrawn', 'open'),
  'withdrawn -> open is refused'
);
select extensions.ok(
  not private.offer_transition_allowed('declined', 'withdrawn'),
  'declined -> withdrawn is refused: one settlement does not become another'
);
select extensions.ok(
  not private.offer_transition_allowed('open', 'open'),
  'open -> open is refused, which is what the trigger WHEN clause protects'
);

-- ------------------------------------------------- the guard binds everyone

-- Backdated first, and the reason is worth stating because it is the trap that
-- made this assertion pass vacuously on the first run: `now()` is the
-- transaction's start time, so inside one transaction a freshly stamped
-- `updated_at` equals `created_at` exactly and `updated_at > created_at` is
-- false however well the trigger works. Backdating gives the stamp something to
-- move away from. This update changes no status, so the trigger does not fire
-- and does not stamp over it.
update public.offers
   set created_at = now() - interval '1 day',
       updated_at = now() - interval '1 day'
 where id = pg_temp.ofid('offer');

select extensions.throws_ok(
  format('update public.offers set status = %L where id = %L', 'accepted', pg_temp.ofid('offer')),
  '23514',
  null,
  'the guard refuses an illegal transition even as postgres, because a trigger is not a grant'
);

select extensions.lives_ok(
  format('update public.offers set status = %L, declined_at = now() where id = %L',
         'declined', pg_temp.ofid('offer')),
  'a legal transition is allowed'
);

select extensions.is(
  (select status::text from public.offers where id = pg_temp.ofid('offer')),
  'declined',
  'the settlement landed'
);

select extensions.is(
  (select count(*)::int from public.events
    where verb = 'offer.transitioned' and subject_id = pg_temp.ofid('offer')),
  1,
  'exactly one audit event per transition, written by the trigger rather than the caller'
);

select extensions.ok(
  (select updated_at > created_at from public.offers where id = pg_temp.ofid('offer')),
  'the trigger stamped updated_at'
);

-- An ordinary edit is not a transition, which is what the WHEN clause buys.
select extensions.lives_ok(
  format('update public.offers set decline_reason = %L where id = %L',
         'Outside what I do', pg_temp.ofid('offer')),
  'editing a non-status column is not validated as a self-transition'
);

select extensions.is(
  (select count(*)::int from public.events
    where verb = 'offer.transitioned' and subject_id = pg_temp.ofid('offer')),
  1,
  'and it wrote no second audit event'
);

-- ------------------------------------------------- structural constraints

select extensions.throws_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, expires_at)
            values (%L, %L, %L, 1, now() - interval '1 hour')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('other')),
  '23514',
  null,
  'an offer cannot expire before it was made'
);

select extensions.throws_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, status, expires_at)
            values (%L, %L, %L, 1, 'declined', now() + interval '1 day')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('other')),
  '23514',
  null,
  'a declined offer must carry the time it was declined'
);

select extensions.throws_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, expires_at, decline_reason)
            values (%L, %L, %L, 1, now() + interval '1 day', 'no')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('other')),
  '23514',
  null,
  'a reason belongs to a decline and to nothing else'
);

select extensions.throws_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, expires_at)
            values (%L, %L, %L, 0, now() + interval '1 day')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('other')),
  '23505',
  null,
  'one offer per cascade round: the matcher''s replay key'
);

select extensions.throws_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, expires_at)
            values (%L, %L, %L, 7, now() + interval '1 day')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('node')),
  '23505',
  null,
  'a node is offered a given task once, ever, so a cascade cannot loop back'
);

-- One live offer per task, which is first-accept-wins expressed as structure.
-- The seeded offer is `declined` by now, so a second open one is legal; a third
-- is not.
select extensions.lives_ok(
  format($q$insert into public.offers (task_id, project_id, node_id, round, expires_at)
            values (%L, %L, %L, 1, now() + interval '1 day')$q$,
         pg_temp.ofid('task'), pg_temp.ofid('project'), pg_temp.ofid('other')),
  'a new round may open once the previous offer settled'
);

-- ------------------------------------------------- the task arcs the matcher drives

select extensions.ok(
  private.task_transition_allowed('escalated', 'matching'),
  'escalated -> matching: the owner sent the step to the marketplace'
);
select extensions.ok(
  private.task_transition_allowed('matching', 'offered'),
  'matching -> offered: an offer went out'
);
select extensions.ok(
  private.task_transition_allowed('offered', 'matching'),
  'offered -> matching: the cascade, after a decline or an expiry'
);
select extensions.ok(
  private.task_transition_allowed('matching', 'escalated'),
  'matching -> escalated: exhaustion returns the step to its owner (ADR-0018)'
);

-- `matching -> failed` stays refused, and the reason changed in this slice.
-- `marketplace_rls.sql` used to say it would be "restored in slice 4"; slice 4
-- decided against it, because `failed` is terminal and would strand work the
-- owner can still take with the three buttons on their panel. It is refused
-- because nothing produces it, not because it is pending.
select extensions.ok(
  not private.task_transition_allowed('matching', 'failed'),
  'matching -> failed stays refused: exhaustion goes back to the owner, not into a terminal state'
);
select extensions.ok(
  not private.task_transition_allowed('offered', 'failed'),
  'offered -> failed stays refused, for the same reason'
);

-- ------------------------------------------------- RLS, as the client roles

-- The node reads their own offer and only their own.
select extensions.is(
  pg_temp.ofcount_as(pg_temp.ofid('node'), 'select count(*) from public.offers'),
  1::bigint,
  'a node reads their own offer'
);

select extensions.is(
  pg_temp.ofcount_as(pg_temp.ofid('other'), 'select count(*) from public.offers'),
  1::bigint,
  'and reads only their own, not the other node''s'
);

-- **The owner reads nothing**, which is the load-bearing absence. They are a
-- genuine project member by `private.is_project_member`, so this passes because
-- the policy excludes them rather than because they are a stranger.
select extensions.is(
  pg_temp.ofcount_as(pg_temp.ofid('owner'), 'select count(*) from public.offers'),
  0::bigint,
  'the project owner reads zero offer rows: an offer names a node, and that pair is closed until the engagement slice'
);

-- ------------------------------------------------- privileges

select extensions.ok(
  not has_table_privilege('authenticated', 'public.offers', 'INSERT'),
  'authenticated cannot insert an offer: a client that could would be offering itself work'
);
select extensions.ok(
  not has_table_privilege('authenticated', 'public.offers', 'UPDATE'),
  'authenticated cannot update an offer directly; the decline route writes with the secret key'
);
select extensions.ok(
  not has_table_privilege('service_role', 'public.offers', 'DELETE'),
  'not even service_role may delete an offer: the trail is what a dispute reads'
);
select extensions.ok(
  has_table_privilege('service_role', 'public.offers', 'UPDATE'),
  'service_role may update, because a settlement is an update and the guard is what constrains it'
);

select extensions.finish();
rollback;
