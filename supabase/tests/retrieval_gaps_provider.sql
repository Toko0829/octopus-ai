-- Gap ledger attribution tests — covers 20260913123000, which records which
-- connector answered an ungrounded gap.
--
-- Small on purpose. This table has **no client policy and no client grant at
-- all**, so there is no RLS question to ask of it: a client is refused whatever
-- the columns say. What is left is worth asserting anyway, and two of the four
-- assertions here are about things the columns must NOT have changed.
--
-- The interesting one is the last. `retrieval_gaps_no_sources_is_empty` ties
-- `core = 'refusing-v0'` to `chunks_retrieved = 0` in both directions, and it is
-- the check that stops the two numbers every query groups by from quietly
-- disagreeing. A migration that adds columns to a table has no business changing
-- it, which is precisely why a migration that adds columns is the kind that does:
-- the constraint is stated once, in a file nobody reopens, and nothing fails if
-- it goes.
--
-- Runs entirely as `postgres`, and that is the correct role rather than a
-- shortcut. `service_role` is the only writer this table will ever have, the
-- checks bind trusted code, and running the assertions as `authenticated` would
-- exercise a path that is closed before any of this is reached.
--
-- Everything is inside a transaction that ROLLBACKs, so the fixtures never
-- persist and this is safe against a live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/retrieval_gaps_provider.sql

begin;

select extensions.plan(5);

-- Helper: the SQLSTATE a statement raises, or null if it succeeds. The code
-- rather than a boolean, so a typo'd column name cannot pass as an enforced
-- refusal.
create or replace function pg_temp.rgerr(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate;
end $$;

-- ------------------------------------------------- the columns exist (2)

select extensions.has_column(
  'public', 'retrieval_gaps', 'provider',
  'the gap ledger records which connector answered'
);

select extensions.has_column(
  'public', 'retrieval_gaps', 'model',
  'and which model did, so the queue can be read per provider rather than as an '
  'average of things that did not happen'
);

-- ------------------------------------------------- an answered gap (1)

select extensions.is(
  pg_temp.rgerr($$
    insert into public.retrieval_gaps
      (core, surface, goal, reason, candidates_considered, chunks_retrieved,
       provider, model)
    values ('ungrounded-general-v1', 'plan',
            'how do i build a webinar funnel for my course',
            'the sources never discuss webinars or live sessions',
            25, 4, 'anthropic', 'claude-opus-5')
  $$),
  null::text,
  'an ungrounded answer records the connector that produced it'
);

-- ----------------------------------------- still append-only (1)

-- The posture `campaign_outcomes` and `events` take, asserted here for the
-- reason `marketing_rls.sql` gives: append-only that only binds clients is not
-- append-only, and this table's whole value is that a row nobody can rewrite is
-- evidence of what was actually refused.
select extensions.ok(
  not has_table_privilege('service_role', 'public.retrieval_gaps', 'UPDATE'),
  'service_role still cannot rewrite a gap row: two new columns did not loosen the '
  'append-only grant'
);

-- ----------------------------------------- the old constraint holds (1)

-- The regression assertion. `refusing-v0` means nothing was retrieved, and the
-- check binds that in both directions. Nothing in `20260913123000` touches it,
-- which is a claim about a constraint in a file nobody reopened.
select extensions.is(
  pg_temp.rgerr($$
    insert into public.retrieval_gaps
      (core, surface, goal, candidates_considered, chunks_retrieved)
    values ('refusing-v0', 'plan', 'how do i get a car licence', 25, 1)
  $$),
  '23514',
  'a refusing-v0 row that claims it retrieved something is still refused: the two '
  'counts every query groups by cannot start disagreeing because a column was added'
);

select * from extensions.finish();
rollback;
