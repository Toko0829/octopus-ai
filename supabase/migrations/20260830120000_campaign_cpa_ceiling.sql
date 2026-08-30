-- 20260830120000_campaign_cpa_ceiling.sql — the optimizer gets its input, and
-- pause_reason gets its guard.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md, docs/40-adr/0014-cpa-ceiling-authorises-auto-pause.md
--
-- `marketing-growth-engine.md` has carried the sentence "acting needs a CPA
-- ceiling that has no writer anywhere" since the metrics sweep landed. This is
-- that column, arriving in the same change as its writer (the owner-only PATCH
-- route) and its first reader (the optimize sweep), which is the ordering
-- `projects.budget_ceiling` should have had and did not: that column sat with no
-- reader and no writer for sixteen days while a spend check composed a number
-- nothing could set.
--
-- **NULL abstains here, and that deliberately INVERTS the budget columns.** On
-- `budget_cap` and `projects.budget_ceiling`, NULL means "nothing authorised" and
-- blocks: an unset spend authorisation must refuse spend. A CPA ceiling is not an
-- authorisation to spend, it is an instruction to judge, and an unset judgement
-- threshold must refuse to judge. A NULL that paused campaigns would stop money
-- nobody asked us to stop; a NULL that blocked approval would make the optimizer
-- mandatory. Every reader of this column must know which family it is in, which
-- is why the inversion is stated here, on the contract field, and in the module
-- doc rather than in any one of them.

alter table public.campaigns
  add column cpa_ceiling numeric(12, 2);

comment on column public.campaigns.cpa_ceiling is
  'Owner-entered cost-per-conversion ceiling. NULL means "no ceiling set; the optimizer does '
  'not judge this campaign", which is the OPPOSITE of budget_cap, where NULL blocks: an unset '
  'spend authorisation refuses spend, an unset judgement threshold refuses to judge. Setting '
  'it authorises the automatic pause (ADR-0014). Enforced in tool code (rule 7): '
  'decideCpaBreach in packages/marketing reads it, no constraint acts on it.';

-- Positive, not merely non-negative, unlike the budget columns. A budget of 0 is
-- a coherent authorisation ("spend nothing"); a ceiling of 0 pauses on the first
-- recorded cent whatever the conversions say, which is a kill switch wearing the
-- shape of a setting. Somebody who wants spend stopped has the pause for that,
-- and refusing the footgun at both the contract and the table means the two
-- cannot drift on it.
alter table public.campaigns
  add constraint campaigns_cpa_ceiling_positive
  check (cpa_ceiling is null or cpa_ceiling > 0);

comment on constraint campaigns_cpa_ceiling_positive on public.campaigns is
  'A ceiling of 0 would pause on the first cent regardless of conversions, which is a kill '
  'switch disguised as a threshold. Refused here and at SetCampaignCpaCeilingBody.';

-- `pause_reason` was declared free text "while the set is still being learned by
-- the optimizer that will write it" (20260829120000). The optimizer is here and
-- writes `cpa_breach`, so the learning period is over and the guard lands with
-- the first writer, on the ordering `20260829150000` and `20260829160000`
-- established. Worth a constraint rather than a comment because the panel now
-- branches on the value: a row written as `cpa-breach` would render as a paused
-- campaign with no reason and no resume copy, a wrong answer wearing the shape
-- of a right one.
--
-- All four documented values are included although only `cpa_breach` gains a
-- writer today, on the `manual` argument from `20260829160000`: enforcing
-- today's writers rather than the design would make the kill-switch slice alter
-- a constraint to do what the column comment already promises.
--
-- A plain ADD CONSTRAINT rather than NOT VALID plus VALIDATE: the column has
-- never had a writer, so every existing row holds NULL and there is nothing to
-- scan.
alter table public.campaigns
  add constraint campaigns_pause_reason_check
  check (
    pause_reason is null
    or pause_reason in ('kill_switch', 'cpa_breach', 'user', 'optimizer')
  );

comment on constraint campaigns_pause_reason_check on public.campaigns is
  'The four documented values. The panel branches on cpa_breach to explain a pause and offer '
  'resume, so a typo would render as a paused campaign with no reason attached.';

-- No grant or policy changes. `campaigns` is already client-readable and
-- server-written (`20260829120000`), which is exactly right for a column only
-- the owner-only route writes and only the panel reads.
