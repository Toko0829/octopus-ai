-- The ad entity lifecycle and the write-once rule on `external_id`.
-- Covers 20260829150000.
--
-- **Everything here runs as `postgres` on purpose**, which is the same split
-- `marketing_rls.sql` and `rls_workflow.sql` make. These are triggers, not
-- policies: their whole job is to bind trusted server code, and the publish
-- executor is service-role code from end to end. A guard that only refused
-- clients would refuse nobody who was ever going to write this table. Row
-- visibility on `ad_entities` is already covered by `marketing_rls.sql` and is
-- deliberately not re-asserted here.
--
-- Two properties carry most of the weight.
--
-- `rejected` is **not** terminal, and `rejected -> archived` is its one exit. A
-- platform disapproving an entity is a verdict on that entity; revising produces
-- a new one, so the disapproved row is closed out rather than resurrected.
--
-- `external_id` refuses a CHANGE and permits a REWRITE of the same value. That
-- asymmetry is the resume path: a publisher whose process died between the
-- platform answering and the row being finished re-drives with the same
-- idempotency key, gets the same id back, and writes it again. If this suite ever
-- starts refusing that, a crash mid-publish becomes unrecoverable.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database and leaves no fixtures behind.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/ad_entity_guard.sql

begin;

select extensions.plan(25);

-- ---------------------------------------------------------------- fixtures

create temporary table aeids (k text primary key, v uuid);
insert into aeids (k, v) values
  ('owner',    gen_random_uuid()),
  ('project',  gen_random_uuid()),
  ('campaign', gen_random_uuid()),
  ('e1',       gen_random_uuid()),
  ('e2',       gen_random_uuid()),
  ('e3',       gen_random_uuid()),
  ('e4',       gen_random_uuid()),
  ('e5',       gen_random_uuid());

create or replace function pg_temp.aeid(text) returns uuid language sql stable as
  $$ select v from aeids where k = $1 $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values (pg_temp.aeid('owner'), '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', 'owner@ad-entity-test.invalid', '', now(), now(), now());

insert into public.projects (id, owner_id, goal, status, budget_ceiling)
values (pg_temp.aeid('project'), pg_temp.aeid('owner'),
        'launch and grow my app', 'active', 5000.00);

insert into public.campaigns (id, project_id, name, channel, state, budget_cap)
values (pg_temp.aeid('campaign'), pg_temp.aeid('project'),
        'Launch campaign', 'meta', 'ready', 400.00);

-- Several root entities under one campaign. Legal: the check constraint only
-- requires that a `campaign`-kind entity has no parent, and the hierarchy trigger
-- returns early when `parent_id` is null. Each one walks a different path.
insert into public.ad_entities (id, campaign_id, project_id, kind, state, idempotency_key)
values
  (pg_temp.aeid('e1'), pg_temp.aeid('campaign'), pg_temp.aeid('project'), 'campaign', 'draft',      'test:e1'),
  (pg_temp.aeid('e2'), pg_temp.aeid('campaign'), pg_temp.aeid('project'), 'campaign', 'draft',      'test:e2'),
  (pg_temp.aeid('e3'), pg_temp.aeid('campaign'), pg_temp.aeid('project'), 'campaign', 'publishing', 'test:e3'),
  (pg_temp.aeid('e4'), pg_temp.aeid('campaign'), pg_temp.aeid('project'), 'campaign', 'publishing', 'test:e4');

-- e5 is inserted stale so the `updated_at` stamp is observable. `now()` is the
-- transaction timestamp and is constant inside this file, so a row created at
-- `now()` and stamped at `now()` would prove nothing.
insert into public.ad_entities (id, campaign_id, project_id, kind, state, idempotency_key,
                                created_at, updated_at)
values (pg_temp.aeid('e5'), pg_temp.aeid('campaign'), pg_temp.aeid('project'), 'campaign',
        'publishing', 'test:e5', now() - interval '2 days', now() - interval '2 days');

-- Helper: the SQLSTATE a statement raises, or null if it succeeds. The code
-- rather than a boolean, for `merrcode_of`'s reason: "it threw something" would
-- also pass for a typo'd column, which makes a refusal look enforced when the
-- test never reached it.
create or replace function pg_temp.aeerr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ------------------------------------------------- e1 walks the happy path

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''publishing'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'draft -> publishing is allowed: the intent row is written before the platform is called'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''live'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'publishing -> live is allowed once the platform has confirmed'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''paused'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'live -> paused is allowed: the kill switch reaches a running entity'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''live'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'paused -> live is allowed: pausing is reversible, which is what distinguishes it from archived'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''rejected'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'live -> rejected is allowed: a platform can disapprove an entity that is already running'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''archived'' where id = %L', pg_temp.aeid('e1'))),
  null::text,
  'rejected -> archived is allowed: revise-and-resubmit makes a new entity and closes this one'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''live'' where id = %L', pg_temp.aeid('e1'))),
  '23514',
  'archived -> live is refused: terminal means terminal, so no arc resurrects a closed entity'
);

select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.aeid('e1') and verb = 'ad_entity.transitioned'),
  6::bigint,
  'six transitions wrote six events, and the refused seventh wrote none'
);

-- Matched on the pair rather than read off the newest row: `now()` is the
-- transaction timestamp, so all six events share a `created_at` and "the last
-- one" is not a thing this file can order by.
select extensions.is(
  (select count(*) from public.events
    where subject_id = pg_temp.aeid('e1') and verb = 'ad_entity.transitioned'
      and payload->>'from' = 'rejected' and payload->>'to' = 'archived'),
  1::bigint,
  'the event records where the entity came from and where it went, not merely that it moved'
);

-- ------------------------------------------------------ refused shortcuts

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''live'' where id = %L', pg_temp.aeid('e2'))),
  '23514',
  'draft -> live is refused: claiming live without having asked the platform puts an '
  'untrue sentence in the audit trail'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''archived'' where id = %L', pg_temp.aeid('e2'))),
  null::text,
  'draft -> archived is allowed: an entity abandoned before anything was sent is closed, not failed'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''paused'' where id = %L', pg_temp.aeid('e3'))),
  '23514',
  'publishing -> paused is refused: a request in flight has not been cancelled, it has been sent'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''rejected'' where id = %L', pg_temp.aeid('e3'))),
  null::text,
  'publishing -> rejected is allowed: policy disapproval is one of the three answers'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''live'' where id = %L', pg_temp.aeid('e3'))),
  '23514',
  'rejected -> live is refused: the only exit from a disapproval is to close the entity'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''failed'' where id = %L', pg_temp.aeid('e4'))),
  null::text,
  'publishing -> failed is allowed: the call did not land'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set state = ''publishing'' where id = %L', pg_temp.aeid('e4'))),
  '23514',
  'failed -> publishing is refused: a failed entity is terminal, and a retry is a new entity '
  'under a new key'
);

select extensions.is(
  (select actor_kind::text from public.events
    where subject_id = pg_temp.aeid('e4') and verb = 'ad_entity.transitioned' limit 1),
  'system',
  'a transition with no authenticated user is filed as the system, never as a person'
);

-- -------------------------------------------- e5: no event, then write-once

select extensions.is(
  (select count(*) from public.events where subject_id = pg_temp.aeid('e5')),
  0::bigint,
  'the fixtures wrote no event for e5 yet, so the next assertion measures only what follows'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set spec = ''{"name":"renamed"}''::jsonb where id = %L',
    pg_temp.aeid('e5'))),
  null::text,
  'an update that does not change state is not treated as a transition to itself'
);

select extensions.is(
  (select count(*) from public.events where subject_id = pg_temp.aeid('e5')),
  0::bigint,
  'and it wrote no event: the audit trail records transitions, not every edit'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set external_id = ''fake:abc123abc123'' where id = %L',
    pg_temp.aeid('e5'))),
  null::text,
  'external_id null -> value is allowed: this is the platform answering for the first time'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set external_id = ''fake:abc123abc123'' where id = %L',
    pg_temp.aeid('e5'))),
  null::text,
  'rewriting the SAME external_id is allowed, which is the resume path: a publisher that '
  'crashed after the platform answered re-drives the same key and writes the same id'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set external_id = ''fake:999999999999'' where id = %L',
    pg_temp.aeid('e5'))),
  '23514',
  'changing external_id to a different value is refused: it orphans a live object that is '
  'still spending'
);

select extensions.is(
  pg_temp.aeerr(format(
    'update public.ad_entities set external_id = null where id = %L', pg_temp.aeid('e5'))),
  '23514',
  'clearing external_id is refused too, which is the same orphaning by a quieter route'
);

-- Not an assertion: the stamp is only observable after a transition, and none of
-- the edits above was one. e5 was inserted two days stale precisely so this is
-- measurable inside a single transaction, where `now()` never advances.
update public.ad_entities set state = 'live' where id = pg_temp.aeid('e5');

select extensions.ok(
  (select updated_at > created_at from public.ad_entities where id = pg_temp.aeid('e5')),
  'a transition stamps updated_at, so a row that moved does not read as untouched since creation'
);

select * from extensions.finish();

rollback;
