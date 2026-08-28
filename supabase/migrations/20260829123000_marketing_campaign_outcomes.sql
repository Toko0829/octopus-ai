-- 20260829123000_marketing_campaign_outcomes.sql — what a campaign actually did.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md, docs/10-architecture/learning-flywheel.md
--
-- One row per campaign per measured period per source. This is the evidence the
-- auto-optimize loop reads and the flywheel trains on, which is what decides both
-- of its unusual properties.

create table public.campaign_outcomes (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns (id) on delete cascade,
  -- Denormalised for the RLS predicate, as on `ad_entities` and `artifacts`.
  project_id   uuid not null references public.projects (id) on delete cascade,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  spend        numeric(12, 2) not null default 0,
  impressions  bigint,
  clicks       bigint,
  conversions  bigint,
  revenue      numeric(12, 2),
  -- Channel extras that do not generalise: video watch time, thruplays, list
  -- growth. A column per channel-specific metric would be a schema change per
  -- channel, and most of them are read by nothing but a chart.
  metrics      jsonb not null default '{}',
  -- Provenance, always: `pull_metrics` | `manual`. A number whose origin is
  -- unrecorded cannot be corrected later without guessing which numbers were
  -- ours and which were typed in.
  source       text not null,
  created_at   timestamptz not null default now(),

  -- Slice-4 idempotency, designed now so the writer arrives to it: the same
  -- period pulled twice is one row, and the puller says
  -- `insert ... on conflict do nothing`. Without this a retried metrics pull
  -- doubles the spend the optimizer reads, which is the number that decides
  -- whether to pause a campaign.
  unique (campaign_id, period_start, period_end, source)
);

create index campaign_outcomes_campaign_idx
  on public.campaign_outcomes (campaign_id, period_start desc);
create index campaign_outcomes_project_idx
  on public.campaign_outcomes (project_id, period_start desc);

-- ---------- RLS and grants ----------

alter table public.campaign_outcomes enable row level security;

-- Members read their own performance. This is the one marketing table whose whole
-- point is being looked at by the person paying for the ads.
create policy "campaign_outcomes_select_member" on public.campaign_outcomes
  for select using (private.is_project_member(project_id));

grant select on public.campaign_outcomes to authenticated;
grant all on public.campaign_outcomes to service_role;

-- **Append-only by grant, including for `service_role`.**
--
-- Same reasoning as `feedback_events` (`20260812130000`) and `events`: an outcome
-- row is flywheel training evidence, and a training signal that can be rewritten
-- after the fact is not evidence of anything. A correction is a **new row** with
-- `source = 'manual'`, which keeps both the number we pulled and the number a
-- person says is right, and lets anyone reading them see that they differed.
--
-- `feedback_events` states this intent in a comment and enforces it only against
-- clients, since it issues `grant all` to `service_role` and revokes nothing. That
-- is the weaker half of the pattern and `events` is the stronger one, so this
-- table follows `events`: the revoke is explicit and it names `service_role` too.
--
-- **TRUNCATE is revoked alongside UPDATE and DELETE, and it is the one people
-- miss.** `grant all` includes it, it is not row-level, and it ignores RLS
-- entirely, so a role holding it can empty the table whatever the policies say.
revoke update, delete, truncate on public.campaign_outcomes from authenticated, anon, service_role;

comment on table public.campaign_outcomes is
  'Measured campaign performance per period. Append-only including for service_role: '
  'a correction is a new row with source = manual, never an edit. '
  'Unique on (campaign_id, period_start, period_end, source) so a retried pull is one row.';

comment on column public.campaign_outcomes.source is
  'Where the numbers came from: pull_metrics | manual. Provenance always, because a '
  'correction has to be distinguishable from a measurement.';
