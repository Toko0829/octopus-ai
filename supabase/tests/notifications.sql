-- notifications.sql — somebody is told, exactly once, and only about their own.
--
-- Four properties, none of which can be checked anywhere but here:
--
--   1. **The derivation is complete.** Every verb in the map produces a row for
--      the right person, including the six written by SQL functions that no
--      TypeScript test can reach: `reassign_engagement`, `settle_payout`,
--      `raise_dispute`, the dispute-resolve guard, the KYC audit trigger and the
--      task transition guard. This is the property the whole slice rests on, and
--      `20260909121000`'s header accepts a real cost for it (a defect here aborts
--      a payout), so it is pinned verb by verb.
--   2. **The derivation is exhaustive in the other direction too.** An unknown
--      verb writes nothing, a task transition that is not the offer cascade
--      exhausting writes nothing, and a replayed event writes nothing new.
--      `public.events` has no unique key, so the dedup is a real mechanism and
--      not an incidental one.
--   3. **An inbox is one person's.** No counterparty policy, no member policy,
--      no ops policy: the row names exactly one reader and RLS says so.
--   4. **`read_at` is the only thing a client may write, once, on the database
--      clock.** A column grant and a trigger, checked separately, because the
--      grant is the control and the trigger is what binds `service_role`.
--
-- A new file rather than lines added to an existing one, because `plan(N)` is
-- exact (`marketplace_disputes.sql:4-6`). The `pg_temp` prefix is `nf` so
-- nothing collides if suites are ever run in one session.

begin;

select extensions.plan(55);

-- ---------------------------------------------------------------- fixtures

create temporary table nfids (k text primary key, v uuid);
insert into nfids (k, v) values
  ('owner',    gen_random_uuid()),
  ('stranger', gen_random_uuid()),
  -- One node per step: `room_members` is keyed on `(room_id, user_id)`
  -- (ADR-0017), so a node works one step of a project at a time.
  ('n1', gen_random_uuid()),
  ('n2', gen_random_uuid()),
  ('n3', gen_random_uuid()),
  ('n4', gen_random_uuid()),
  ('n5', gen_random_uuid()),
  -- Never offered anything. Exists only to walk the KYC arc, because the five
  -- above must start `verified` to accept work and `verified -> pending` is not
  -- a legal transition (`20260902120000`). Caught by the map refusing the
  -- fixture, which is the map doing its job.
  ('n6', gen_random_uuid()),
  ('p1', gen_random_uuid()),
  ('r1', gen_random_uuid()),
  ('c1', gen_random_uuid()),
  -- One step per moment under test.
  ('tapp',  gen_random_uuid()), ('oapp',  gen_random_uuid()),
  ('trea',  gen_random_uuid()), ('orea',  gen_random_uuid()),
  ('tpay',  gen_random_uuid()), ('opay',  gen_random_uuid()),
  ('tdis',  gen_random_uuid()), ('odis',  gen_random_uuid()),
  ('tnod',  gen_random_uuid()), ('onod',  gen_random_uuid()),
  -- Two with no engagement at all: the offer moment, and the cascade exhausting.
  ('toff',  gen_random_uuid()),
  ('tesc',  gen_random_uuid());

create or replace function pg_temp.nfid(text) returns uuid language sql stable as
  $$ select v from nfids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
select pg_temp.nfid(k), '00000000-0000-0000-0000-000000000000', 'authenticated',
       'authenticated', k || '@notify.invalid', '', now(), now(), now()
from (values ('owner'), ('stranger'), ('n1'), ('n2'), ('n3'), ('n4'), ('n5'), ('n6')) as t(k);

-- Claims cleared so guard triggers file their events as `system`, which is what
-- a service_role connection actually produces.
select set_config('request.jwt.claims', '', true);

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
select pg_temp.nfid(k), 'verified', 'available', array['US-TX'], array['en'], 400.00, 'task', 'USD'
from (values ('n1'), ('n2'), ('n3'), ('n4'), ('n5')) as t(k);

insert into public.node_profiles
  (user_id, kyc_status, availability, service_jurisdictions, languages, rate, rate_period, currency)
-- `paused`, because `node_profiles_available_requires_kyc` refuses an unverified
-- node who claims to be taking work. Another fixture the schema corrected.
values (pg_temp.nfid('n6'), 'unverified', 'paused', array['US-TX'], array['en'], 400.00, 'task', 'USD');

insert into public.projects (id, owner_id, goal, status, budget_ceiling, currency)
values (pg_temp.nfid('p1'), pg_temp.nfid('owner'), 'Ship the launch', 'active', 9000.00, 'USD');

-- No `source_embed_id` on this project, so `private.room_for_project` resolves
-- through the legacy `rooms.project_id` half. That is the fallback branch and it
-- is the one under test here; the card branch is exercised by the live run.
insert into public.rooms (id, name, owner_id, project_id)
values (pg_temp.nfid('r1'), 'Launch', pg_temp.nfid('owner'), pg_temp.nfid('p1'));

insert into public.channels (id, room_id, name, position)
values (pg_temp.nfid('c1'), pg_temp.nfid('r1'), 'general', 0);

insert into public.room_members (room_id, user_id, role, scope)
values (pg_temp.nfid('r1'), pg_temp.nfid('owner'), 'user', 'room');

insert into public.tasks (id, project_id, title, stage, owner_type, state, acceptance_criteria)
values
  (pg_temp.nfid('tapp'), pg_temp.nfid('p1'), 'Approved work',      'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.nfid('trea'), pg_temp.nfid('p1'), 'Reassigned work',    'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.nfid('tpay'), pg_temp.nfid('p1'), 'Paid work',          'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.nfid('tdis'), pg_temp.nfid('p1'), 'Disputed work',      'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.nfid('tnod'), pg_temp.nfid('p1'), 'Node disputed work', 'content', 'human', 'offered', '[]'::jsonb),
  (pg_temp.nfid('toff'), pg_temp.nfid('p1'), 'Only ever offered',  'content', 'human', 'matching', '[]'::jsonb),
  (pg_temp.nfid('tesc'), pg_temp.nfid('p1'), 'Nobody took it',     'content', 'human', 'matching', '[]'::jsonb);

insert into public.offers (id, task_id, project_id, node_id, round, expires_at)
values
  (pg_temp.nfid('oapp'), pg_temp.nfid('tapp'), pg_temp.nfid('p1'), pg_temp.nfid('n1'), 0, now() + interval '48 hours'),
  (pg_temp.nfid('orea'), pg_temp.nfid('trea'), pg_temp.nfid('p1'), pg_temp.nfid('n2'), 0, now() + interval '48 hours'),
  (pg_temp.nfid('opay'), pg_temp.nfid('tpay'), pg_temp.nfid('p1'), pg_temp.nfid('n3'), 0, now() + interval '48 hours'),
  (pg_temp.nfid('odis'), pg_temp.nfid('tdis'), pg_temp.nfid('p1'), pg_temp.nfid('n4'), 0, now() + interval '48 hours'),
  (pg_temp.nfid('onod'), pg_temp.nfid('tnod'), pg_temp.nfid('p1'), pg_temp.nfid('n5'), 0, now() + interval '48 hours');

-- The real RPC as the fixture builder, so what is notified about is what
-- acceptance actually creates rather than a hand-built engagement.
select public.accept_offer(pg_temp.nfid('oapp'), 'ch_fake_nfapp');
select public.accept_offer(pg_temp.nfid('orea'), 'ch_fake_nfrea');
select public.accept_offer(pg_temp.nfid('opay'), 'ch_fake_nfpay');
select public.accept_offer(pg_temp.nfid('odis'), 'ch_fake_nfdis');
select public.accept_offer(pg_temp.nfid('onod'), 'ch_fake_nfnod');

create or replace function pg_temp.nfcount_as(p_user uuid, p_sql text)
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

/* sqlstate of a failing statement, or null when it succeeds. */
create or replace function pg_temp.nferr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

/* The same, as a given user, so a refused write names its own code. */
create or replace function pg_temp.nfwrite_as(p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  execute p_sql;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return sqlstate;
end $$;

/* How many rows of realtime.messages a given person sees on a given topic.
   `realtime.topic()` reads `current_setting('realtime.topic')`, the same way
   thread_scope.sql exercises the two chat policies without the Realtime service
   in the loop. */
create or replace function pg_temp.nfrecv_as(p_user uuid, p_topic text)
returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', p_topic, true);
  select count(*) into n from realtime.messages where topic = p_topic;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return n;
exception when others then
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  return -1;
end $$;

/* An attempted presence write, which is the INSERT half. There is no send
   policy on an inbox topic and this is what pins that. */
create or replace function pg_temp.nfsend_as(p_user uuid, p_topic text)
returns text language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', p_topic, true);
  insert into realtime.messages (topic, extension) values (p_topic, 'presence');
  perform set_config('role', 'postgres', true);
  return null;
exception when others then
  perform set_config('role', 'postgres', true);
  return sqlstate;
end $$;

-- Every notification derived from here on is one this suite caused. `accept_offer`
-- above writes `engagement.created`, `thread.created` and `node.admitted`, none
-- of which is in the map, so the table starts empty and assertion 29 says so.
delete from public.notifications;

-- ------------------------------- the six verbs application code writes (12)
--
-- Hand-inserted with the payload shape the TypeScript writer produces, each
-- naming its writer. What is under test is the trigger's reading of that shape;
-- that the writer still produces it is `apps/api`'s own suite.

-- `apps/api/src/lib/match.ts:482-494`
insert into public.events (project_id, actor_kind, verb, subject_type, subject_id, payload)
values (pg_temp.nfid('p1'), 'system', 'offer.created', 'offer', gen_random_uuid(),
        jsonb_build_object('task_id', pg_temp.nfid('toff'), 'node_id', pg_temp.nfid('n1'),
                           'round', 0, 'expires_at', (now() + interval '48 hours')::text,
                           'skills', array['content'], 'rate', 250));

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'offer.created' and user_id = pg_temp.nfid('n1')),
  1::bigint,
  'the node an offer was made to is told about it, which is the moment this whole slice '
  'exists for: until now an offer was found by opening /node and looking');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'offer.created' and user_id = pg_temp.nfid('owner')),
  0::bigint,
  'and the owner is not told, because they are the one who sent it');

select extensions.is(
  (select payload->>'task_title' from public.notifications where kind = 'offer.created'),
  'Only ever offered',
  'the step title is enriched onto the row, so the sentence can name the work rather than '
  'an id');

select extensions.ok(
  (select payload->>'expires_at' is not null from public.notifications where kind = 'offer.created'),
  'and the expiry rides along, so the copy can say how long is left');

-- `apps/api/src/lib/engagements.ts:395-409`
insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
select pg_temp.nfid('p1'), pg_temp.nfid('n1'), 'node', 'offer.accepted', 'offer', pg_temp.nfid('oapp'),
       jsonb_build_object('task_id', pg_temp.nfid('tapp'), 'node_id', pg_temp.nfid('n1'),
                          'engagement_id', e.id, 'agreed_price', e.agreed_price, 'currency', e.currency)
from public.engagements e where e.task_id = pg_temp.nfid('tapp');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'offer.accepted' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'the owner is told an expert took a step');

select extensions.is(
  (select payload->>'agreed_price' from public.notifications where kind = 'offer.accepted'),
  '400.00',
  'with the price that was just committed against their ceiling');

select extensions.is(
  (select payload->>'room_id' from public.notifications where kind = 'offer.accepted'),
  pg_temp.nfid('r1')::text,
  'and the room the project is announced in, resolved by private.room_for_project so the '
  'click has somewhere to land');

-- `apps/api/src/lib/proof.ts:447`, from routes/nodes.ts:1061
insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
select pg_temp.nfid('p1'), pg_temp.nfid('n1'), 'node', 'proof.submitted', 'task', pg_temp.nfid('tapp'),
       jsonb_build_object('engagement_id', e.id, 'artifact_id', gen_random_uuid(), 'files', 2)
from public.engagements e where e.task_id = pg_temp.nfid('tapp');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'proof.submitted' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'the owner is told when work is handed over, which is the one moment on the owner side '
  'that genuinely blocks on them');

-- `apps/api/src/lib/proof.ts:447`, from routes/nodes.ts:1020
insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
select pg_temp.nfid('p1'), pg_temp.nfid('n1'), 'node', 'proof.bounced', 'task', pg_temp.nfid('tapp'),
       jsonb_build_object('engagement_id', e.id, 'failures', 1)
from public.engagements e where e.task_id = pg_temp.nfid('tapp');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'proof.bounced' and user_id = pg_temp.nfid('n1')),
  1::bigint,
  'a handover the criteria check refused goes back to the node and not to the owner: '
  'nothing reached them, so there is nothing to report');

-- `apps/api/src/routes/task-actions.ts:343-351`
insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
values (pg_temp.nfid('p1'), pg_temp.nfid('owner'), 'user', 'work.approved', 'task', pg_temp.nfid('tapp'),
        jsonb_build_object('note', null));

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'work.approved' and user_id = pg_temp.nfid('n1')),
  1::bigint,
  'the node is told their work was approved, resolved through the engagement that is still '
  'live: approval does not end it, settle_payout does');

insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
values (pg_temp.nfid('p1'), pg_temp.nfid('owner'), 'user', 'work.rejected', 'task', pg_temp.nfid('tapp'),
        jsonb_build_object('note', 'The headline does not match the brief.'));

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'work.rejected' and user_id = pg_temp.nfid('n1')),
  1::bigint,
  'and told when it was sent back');

select extensions.is(
  (select payload->>'note' from public.notifications where kind = 'work.rejected'),
  'The headline does not match the brief.',
  'with the note, because "your work was sent back" without the reason is the message that '
  'makes somebody stop answering');

-- ----------------------------------- the five verbs SQL functions write (12)
--
-- Through the real RPCs, so the payload under test is the one the function
-- actually writes. No TypeScript test can reach any of these.

update public.tasks set state = 'in_progress' where id = pg_temp.nfid('trea');
select public.reassign_engagement(
  (select id from public.engagements where task_id = pg_temp.nfid('trea')));

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'engagement.reassigned' and user_id = pg_temp.nfid('n2')),
  1::bigint,
  'the node who missed the deadline is told the step was taken back, which is the one '
  'notification here that is unwelcome and is sent anyway: the alternative is finding out '
  'from a thread they can no longer open');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'engagement.reassigned' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'and the owner is told too, because their step just moved and their escrow just came back');

select extensions.is(
  (select count(*) from public.notifications where kind = 'engagement.reassigned'),
  2::bigint,
  'exactly two rows from one event: both parties, nobody else');

update public.tasks set state = 'in_progress'     where id = pg_temp.nfid('tpay');
update public.tasks set state = 'proof_submitted' where id = pg_temp.nfid('tpay');
update public.tasks set state = 'in_review'       where id = pg_temp.nfid('tpay');
update public.tasks set state = 'approved'        where id = pg_temp.nfid('tpay');

insert into public.payouts
  (engagement_id, node_id, project_id, task_id, amount, platform_fee, currency, idempotency_key)
select e.id, e.node_id, e.project_id, e.task_id, e.agreed_price, 0, e.currency, 'payout:' || e.id
from public.engagements e where e.task_id = pg_temp.nfid('tpay');

update public.tasks set state = 'payout_pending' where id = pg_temp.nfid('tpay');

select public.settle_payout(
  (select id from public.payouts where task_id = pg_temp.nfid('tpay')),
  'tr_fake_notify');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'payout.settled' and user_id = pg_temp.nfid('n3')),
  1::bigint,
  'the node is told they were paid. Slice 7 shipped without this and said so: "The node is '
  'not told they were paid ... they see it on /node"');

select extensions.is(
  (select payload->>'amount' from public.notifications where kind = 'payout.settled'),
  '400.00',
  'with the amount, and without platform_fee or transfer_id: the fee is not deducted from '
  'an agreed price (ADR-0024) so showing it beside the amount would imply that it was');

update public.tasks set state = 'in_progress' where id = pg_temp.nfid('tdis');
select public.raise_dispute(pg_temp.nfid('tdis'), pg_temp.nfid('owner'), 'owner',
                            'The draft is not what we agreed.', null);

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'dispute.raised' and user_id = pg_temp.nfid('n4')),
  1::bigint,
  'an owner-raised dispute reaches the node it is about');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'dispute.raised' and user_id = pg_temp.nfid('owner')),
  0::bigint,
  'and not the owner, who raised it: the raiser already knows');

update public.tasks set state = 'in_progress'     where id = pg_temp.nfid('tnod');
update public.tasks set state = 'proof_submitted' where id = pg_temp.nfid('tnod');
update public.tasks set state = 'in_review'       where id = pg_temp.nfid('tnod');
update public.tasks set state = 'rejected'        where id = pg_temp.nfid('tnod');
select public.raise_dispute(pg_temp.nfid('tnod'), pg_temp.nfid('n5'), 'node',
                            'The work matches the brief.', null);

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'dispute.raised' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'a node-raised dispute reaches the owner, which is the only act in this system a node '
  'performs against them');

select public.resolve_dispute(
  (select id from public.disputes where task_id = pg_temp.nfid('tdis')),
  pg_temp.nfid('owner'), 'refunded', 'The brief was not met.', null);

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'dispute.resolved' and user_id = pg_temp.nfid('n4')),
  1::bigint,
  'a resolution reaches the node');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'dispute.resolved' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'and the owner, whoever raised it: an operator decided about both of them');

select extensions.is(
  (select payload->>'resolution' from public.notifications
   where kind = 'dispute.resolved' and user_id = pg_temp.nfid('owner')),
  'refunded',
  'carrying which of the five it was, and not resolved_by: naming the operator to the '
  'parties is a disclosure nobody has decided to make');

select extensions.ok(
  (select payload->>'resolved_by' is null from public.notifications where kind = 'dispute.resolved'),
  'the operator is not named to either party, which is the allow-list working rather than '
  'the payload being copied through');

-- ------------------------------------------- kyc, and the one transition (5)

update public.node_profiles set kyc_status = 'pending' where user_id = pg_temp.nfid('n6');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'node.kyc_status_changed' and user_id = pg_temp.nfid('n6')),
  1::bigint,
  'a verification verdict reaches the node it is about, resolved from subject_id rather '
  'than from a payload key');

select extensions.ok(
  (select project_id is null from public.notifications where kind = 'node.kyc_status_changed'),
  'with a null project_id, which the table permits because becoming a verified node is not '
  'about a project');

update public.tasks set state = 'escalated' where id = pg_temp.nfid('tesc');

select extensions.is(
  (select count(*) from public.notifications
   where kind = 'task.transitioned' and user_id = pg_temp.nfid('owner')),
  1::bigint,
  'the owner is told when the cascade exhausts and a step comes back to them (ADR-0018)');

update public.tasks set state = 'matching' where id = pg_temp.nfid('tesc');

select extensions.is(
  (select count(*) from public.notifications where kind = 'task.transitioned'),
  1::bigint,
  'and NOT when it goes back out: escalated -> matching is the owner acting, not news for '
  'them');

update public.tasks set state = 'offered' where id = pg_temp.nfid('toff');

select extensions.is(
  (select count(*) from public.notifications where kind = 'task.transitioned'),
  1::bigint,
  'nor on any other transition. task.transitioned fires on every step of every project '
  'several times each, so the guard is a where clause and not a comment');

-- -------------------------------------------- what is deliberately not (4)

insert into public.events (project_id, actor_kind, verb, subject_type, subject_id, payload)
values (pg_temp.nfid('p1'), 'system', 'campaign.published', 'campaign', gen_random_uuid(), '{}'::jsonb);

select extensions.is(
  (select count(*) from public.notifications where kind = 'campaign.published'),
  0::bigint,
  'a verb outside the map writes nothing. The map is a closed case statement, so a verb a '
  'later slice invents cannot reach this table by accident');

select extensions.is(
  (select count(*) from public.notifications
   where kind in ('engagement.created', 'thread.created', 'node.admitted')),
  0::bigint,
  'including the three real verbs accept_offer writes, which are the system working rather '
  'than anything either party needs telling about');

insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
values (pg_temp.nfid('p1'), pg_temp.nfid('owner'), 'user', 'work.rejected', 'task', pg_temp.nfid('tapp'),
        jsonb_build_object('note', 'The headline does not match the brief.'));

select extensions.is(
  (select count(*) from public.notifications where kind = 'work.rejected'),
  1::bigint,
  'a replayed moment tells nobody twice. events carries no unique key and match.ts says a '
  'replay can write the same event again, so the key is the only thing between a retried '
  'sweep and a doubled inbox');

select extensions.is(
  (select key from public.notifications where kind = 'work.approved'),
  'work.approved:' || pg_temp.nfid('tapp')::text || ':' || pg_temp.nfid('n1')::text,
  'and the key is <verb>:<subject_id>:<user_id>, so two people told about one moment get '
  'one row each');

-- ------------------------------------------------- an inbox is one person's (4)

select extensions.is(
  pg_temp.nfcount_as(pg_temp.nfid('n1'),
    'select count(*) from public.notifications where user_id <> ' || quote_literal(pg_temp.nfid('n1')) || '::uuid'),
  0::bigint,
  'a node sees none of anybody else''s');

select extensions.ok(
  pg_temp.nfcount_as(pg_temp.nfid('n1'), 'select count(*) from public.notifications') > 0,
  'and does see their own');

select extensions.is(
  pg_temp.nfcount_as(pg_temp.nfid('owner'),
    'select count(*) from public.notifications where user_id <> ' || quote_literal(pg_temp.nfid('owner')) || '::uuid'),
  0::bigint,
  'the owner sees none of anybody else''s either, including on their own project: there is '
  'no member policy on this table and there must not be one');

select extensions.is(
  pg_temp.nfcount_as(pg_temp.nfid('stranger'), 'select count(*) from public.notifications'),
  0::bigint,
  'and somebody with no part in any of it sees nothing at all');

-- --------------------------------------------------------- read_at (6)

select extensions.is(
  pg_temp.nfwrite_as(pg_temp.nfid('n1'),
    'update public.notifications set read_at = now() where kind = ''work.approved'''),
  null::text,
  'a person can mark their own notification read, which is the one column the grant opens');

select extensions.ok(
  (select read_at > now() - interval '1 minute'
   from public.notifications where kind = 'work.approved'),
  'and the database stamps the time. A caller supplying its own clock could backdate the '
  'one fact this row is asked to prove, and the caller is a browser');

select extensions.is(
  pg_temp.nfwrite_as(pg_temp.nfid('n1'),
    'update public.notifications set read_at = null where kind = ''work.approved'''),
  '23514',
  'unread-again is refused explicitly rather than ignored, because a silent no-op looks '
  'like it worked');

select extensions.is(
  pg_temp.nfwrite_as(pg_temp.nfid('n1'),
    'update public.notifications set read_at = now() + interval ''1 hour'' where kind = ''work.approved'''),
  '23514',
  'and a second reading does not move the timestamp of the first');

select extensions.is(
  pg_temp.nfwrite_as(pg_temp.nfid('n1'),
    'update public.notifications set payload = ''{}''::jsonb where kind = ''work.approved'''),
  '42501',
  'no other column is writable at all: the column grant refuses before the trigger has to, '
  'because RLS filters rows and not columns');

select extensions.is(
  pg_temp.nfcount_as(pg_temp.nfid('stranger'),
    'with moved as (update public.notifications set read_at = now() where read_at is null returning 1) select count(*) from moved'),
  0::bigint,
  'and marking everything read touches nothing when none of it is yours, which is what '
  'lets the read-all route carry no user filter');

-- ------------------------------------------------------ privileges (5)
--
-- Asserted directly rather than through a policy, on supabase/README.md:97's
-- rule. TRUNCATE especially: it bypasses RLS entirely and `grant all` includes it.

select extensions.ok(
  not has_table_privilege('authenticated', 'public.notifications', 'INSERT'),
  'nobody can write themselves a notification. The only writer is the trigger, and a client '
  'insert would be a notification about a moment that did not happen');

select extensions.ok(
  not has_table_privilege('authenticated', 'public.notifications', 'DELETE'),
  'and nobody can delete one');

select extensions.ok(
  not has_table_privilege('authenticated', 'public.notifications', 'TRUNCATE'),
  'nor truncate the table');

select extensions.ok(
  not has_table_privilege('service_role', 'public.notifications', 'DELETE'),
  'service_role cannot delete either. This row is the record that somebody was told, and '
  'the first place that matters is a dispute where one party says they never heard');

select extensions.ok(
  not has_table_privilege('service_role', 'public.notifications', 'TRUNCATE'),
  'and cannot truncate');

-- ---------------------------------------------------- the topic (5)

-- No fixture row is needed here and that is itself the finding: by this point
-- `notify:user:<n1>` already carries several rows, because `broadcast_notification`
-- put them there as each of this node's notifications was derived. The first
-- version of this assertion inserted one row and expected to see exactly one; it
-- saw five, which is the broadcaster working rather than the policy leaking.
--
-- Asserted against what `postgres` sees on the same topic rather than against a
-- literal, so it stays true however many moments the fixtures above produce, and
-- so it says the thing that matters: the policy admits the whole topic to its
-- owner and hides none of it.
select extensions.is(
  pg_temp.nfrecv_as(pg_temp.nfid('n1'), 'notify:user:' || pg_temp.nfid('n1')::text),
  (select count(*) from realtime.messages where topic = 'notify:user:' || pg_temp.nfid('n1')::text),
  'a person reaches every row on their own inbox topic, which is what makes the bell move '
  'without a reload. The rows are there because the broadcast trigger wrote them');

select extensions.is(
  pg_temp.nfrecv_as(pg_temp.nfid('stranger'), 'notify:user:' || pg_temp.nfid('n1')::text),
  0::bigint,
  'and nobody else reaches it. The predicate is auth.uid() and there is nothing else in it: '
  'no membership row, no expires_at, nothing that can go stale');

select extensions.is(
  pg_temp.nfsend_as(pg_temp.nfid('n1'), 'notify:user:' || pg_temp.nfid('n1')::text),
  '42501',
  'and nobody can push to an inbox topic, their own included. There is no send policy '
  'because nobody is present in their notifications: the client subscribes and never tracks');

select extensions.is(
  (select count(*) from pg_policies
   where schemaname = 'realtime' and tablename = 'messages'
     and policyname = 'realtime_own_inbox_can_receive'),
  1::bigint,
  'the policy is its own rather than a third OR inside the two chat policies (ADR-0028): '
  'what 20260906120000 refused to duplicate was the expires_at time-box, and this topic '
  'has none');

select extensions.is(
  (select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
  3::bigint,
  'so realtime.messages now carries three policies rather than two. thread_scope.sql '
  'asserted two and is amended in the same push, because changing that count should be '
  'something somebody has to argue for');

-- -------------------------------------------- the trigger, and its refusal (2)

select extensions.is(
  (select count(*) from pg_trigger
   where tgname = 'events_notify' and tgrelid = 'public.events'::regclass and not tgisinternal),
  1::bigint,
  'the derivation hangs off public.events, which is the one ledger every writer in this '
  'system already reaches');

select extensions.is(
  pg_temp.nferr(
    'insert into public.events (project_id, actor_kind, verb, subject_type, subject_id, payload) values ('
    || quote_literal(pg_temp.nfid('p1')) || '::uuid, ''system'', ''offer.created'', ''offer'', '
    || quote_literal(gen_random_uuid()) || '::uuid, ''{"task_id": null}''::jsonb)'),
  '23514',
  'and a mapped event that names nobody to tell is refused rather than skipped. Writing '
  'nothing quietly there would restore, undetectably, the exact condition this slice ends');

select * from extensions.finish();
rollback;
