-- 20260829160000_campaign_outcome_source_guard.sql — outcomes get their source guard.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md
--
-- `20260829123000` landed `campaign_outcomes` with its unique key, its grants and
-- its RLS policy, and with `source` as plain `text` whose two legal values were
-- documented in a comment and enforced by nothing. That was the same shape
-- `ad_entities` shipped in and `20260829150000` closed: a guard that constrains
-- writes nobody can make is the `task_deps` defect, so it waits for the writer.
--
-- The metrics sweep is that writer, so the guard lands in the same change as it.
--
-- Why it is worth a constraint rather than a comment. `source` is part of the
-- unique key, so it decides idempotency rather than merely describing provenance.
-- A row written as `pull-metrics` or `metrics` would collide with nothing, and
-- the sweep would append a second copy of a window it had already measured on
-- every pass, doubling the spend the optimizer reads. The typo would look like a
-- provenance nit and behave like a duplicated payment record.
--
-- `manual` is included although nothing writes it yet. It is half of what the key
-- means: a correction is a NEW row for the same window under a different source,
-- so both the number we pulled and the number a person says is right survive with
-- their origins attached. Leaving it out would enforce today's writers rather
-- than the design, and the next slice would have to alter the constraint to do
-- the thing the column comment already promises.
--
-- A plain ADD CONSTRAINT rather than NOT VALID plus VALIDATE: the table has never
-- had a writer, so there are no existing rows to scan and nothing to migrate.

alter table public.campaign_outcomes
  add constraint campaign_outcomes_source_check
  check (source in ('pull_metrics', 'manual'));

comment on constraint campaign_outcomes_source_check on public.campaign_outcomes is
  'The two values the column comment documents. `source` is part of the unique key, so an '
  'unrecognised value would not collide with anything and would silently double a measured period.';
