-- 20260829120000_marketing_campaigns.sql — the first vertical gets its domain.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md (the module this serves)
--
-- The enforcement spine already works. A plan step whose own words commit to
-- spending, publishing or connecting an account is clamped to a higher risk tier
-- in `services/ai/src/octopus_ai/risk.py`, carried onto `tasks.risk_tier` by
-- `materialise_plan`, and refused an unsupervised run by `routeTask`'s first
-- rule. What it has been guarding is prose: the only thing an AI task can
-- currently produce is text. This migration gives it something real to guard.
--
-- **Zero new capability.** Nothing here lets the AI do anything it could not do
-- yesterday. There is no executor, no adapter call, no OAuth route. These are the
-- rows a later slice's writers arrive to, and the guards arrive with them,
-- because this repository's recorded defect class is the opposite order:
-- `risk_tier` was unreachable for its whole life (`20260816120000`) and
-- `task_deps` held no row for two weeks (`20260828120000`). A guard that lands
-- after its writer is a guard that spent the interval not guarding.

-- ---------- Enums ----------

-- Where a campaign runs. Deliberately no `fake` value: `fake` is a **provider**,
-- an adapter implementation, and it lives on `channel_connections.provider`
-- validated against the checked-in registry in `packages/marketing`. A channel is
-- a place in the world; a provider is how we talk to it. Collapsing the two would
-- make the test double a permanent member of the domain vocabulary.
create type public.marketing_channel as enum (
  'meta',
  'google',
  'email',
  'organic_social'
);

-- The campaign lifecycle.
--
-- `publishing` is distinct from `live` on purpose, and it is the same argument
-- that gave `action_embeds` its `answered` state in `20260815120000`: recording a
-- campaign as live before the platform has confirmed it would put an untrue
-- sentence in the audit trail. Between the request and the confirmation the
-- honest answer is "we asked", and that is a state, not a shade of `live`.
--
-- `failed` is reachable only from `publishing`, because a campaign that never
-- reached the platform failed and one that reached it and was then disapproved is
-- an entity-level rejection (see `ad_entities.state`), not a campaign failure.
create type public.campaign_state as enum (
  'draft',       -- composed, nothing authorised
  'ready',       -- approved by the owner, not yet sent
  'publishing',  -- sent to the platform, no confirmation yet
  'live',        -- the platform confirmed it
  'paused',      -- spend stopped; why is in pause_reason
  'completed',
  'cancelled',
  'failed'
);

-- ---------- Tables ----------

create table public.campaigns (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects (id) on delete cascade,
  -- The step that proposed it, kept so a campaign can be traced back to the plan
  -- it came from. `set null` rather than `cascade`: a cancelled step must not
  -- silently delete the record of money that was authorised under it.
  task_id        uuid references public.tasks (id) on delete set null,
  name           text not null,
  objective      text,
  channel        public.marketing_channel not null,
  state          public.campaign_state not null default 'draft',
  -- The authorised ceiling for this campaign. Nullable, and NULL means "nothing
  -- authorised", never "unlimited". That is verbatim the stance
  -- `projects.budget_ceiling` takes at `20260813120000:93`, and `checkSpendCap`
  -- in `packages/marketing` composes the two. Enforced in tool code (rule 7):
  -- this column is the number that code checks against, not a constraint that
  -- checks itself.
  budget_cap     numeric(12, 2),
  currency       text not null default 'USD',
  -- Why spend stopped: `kill_switch` | `cpa_breach` | `user` | `optimizer`.
  -- The reason is data and the state is the same one, because a paused campaign
  -- is paused however it got there, and four states would need four sets of arcs
  -- that all mean "spend stopped". Free text rather than an enum while the set is
  -- still being learned by the optimizer that will write it.
  pause_reason   text,
  -- Slice-2 idempotency, declared now so the writer arrives to a column rather
  -- than to a migration. One approved campaign card produces one campaign, and a
  -- retry after a partial failure collides here. Same argument as
  -- `projects.source_embed_id` (`20260813140000`) and `plan_diffs.embed_id`.
  source_embed_id uuid unique references public.action_embeds (id) on delete set null,
  created_by     public.author_kind not null default 'agent',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index campaigns_project_idx on public.campaigns (project_id, created_at desc);

-- ---------- The campaign state machine ----------

-- Terminal means terminal, exactly as it does for tasks. Checked first below so
-- no arc can resurrect a cancelled campaign into one that spends again.
create function private.campaign_state_is_terminal(s public.campaign_state)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('completed', 'cancelled', 'failed');
$$;

-- The transition map, as data.
--
-- `search_path` is pinned on this and on the terminal-state helper beside it, and
-- that is not a formality: both were written without it, both passed every
-- assertion in `marketing_rls.sql`, and the advisor raised lint 0011 on both the
-- moment the migration was applied. The same pairing `20260813130000` had to
-- correct after `20260813120000`. A test suite asserts the properties somebody
-- thought to assert.
--
-- Cancellation is expressed as a rule rather than listed on every state, for the
-- reason `task_transition_allowed` gives: the kill switch must not have states it
-- cannot reach, and listing the arc on each state is one place per state to
-- forget it. `live` is the exception and it is deliberate: a campaign the
-- platform is actively spending against is paused first and cancelled after, so
-- that "stop the money" and "close the record" stay two separate acts with two
-- separate events.
create function private.campaign_transition_allowed(
  p_from public.campaign_state,
  p_to   public.campaign_state
)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if private.campaign_state_is_terminal(p_from) then
    return false;
  end if;

  return case p_from
    when 'draft'      then p_to in ('ready', 'cancelled')
    when 'ready'      then p_to in ('publishing', 'cancelled')
    -- The two answers the platform can give. Nothing else leaves `publishing`:
    -- a request in flight has not been cancelled, it has been sent.
    when 'publishing' then p_to in ('live', 'failed')
    -- Stop the money before closing the record.
    when 'live'       then p_to in ('paused', 'completed')
    when 'paused'     then p_to in ('live', 'cancelled', 'completed')
    else false
  end;
end;
$$;

revoke all on function private.campaign_state_is_terminal(public.campaign_state) from public;
revoke all on function private.campaign_transition_allowed(public.campaign_state, public.campaign_state) from public;

-- Validate the transition, then record it. One trigger for both, so an audit
-- entry cannot be forgotten by a caller and cannot describe a transition that did
-- not happen.
--
-- SECURITY DEFINER, and that is the `20260815200000` lesson rather than a
-- preference: `20260813130000` hardened the workflow guards and left the only
-- writer without EXECUTE on their internals, so every write to `tasks.state`
-- through the API was refused from the day it landed. A guard meant to bind
-- trusted code must not depend on trusted code holding privileges on its private
-- parts. `search_path` is pinned for lint 0011.
create function private.guard_campaign_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.campaign_transition_allowed(old.state, new.state) then
    raise exception
      'illegal campaign transition % -> % for campaign %',
      old.state, new.state, old.id
      using errcode = 'check_violation',
            hint = 'See the campaign lifecycle in docs/30-modules/marketing-growth-engine.md.';
  end if;

  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'campaign.transitioned',
    'campaign',
    new.id,
    jsonb_build_object(
      'from', old.state,
      'to', new.state,
      'channel', new.channel,
      -- Carried on the event because "why did spend stop" is the question anyone
      -- reading this log is asking, and re-deriving it later means reading a
      -- column that has since been overwritten by the next pause.
      'pause_reason', new.pause_reason
    )
  );

  return new;
end;
$$;

revoke all on function private.guard_campaign_transition() from public;

-- `when` matters for the same reason it does on `tasks`: without it every
-- ordinary edit (a pause reason, a renamed campaign) would be validated as a
-- transition from a state to itself, which the map correctly rejects.
create trigger campaigns_guard_transition
  before update on public.campaigns
  for each row
  when (old.state is distinct from new.state)
  execute function private.guard_campaign_transition();

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.campaigns enable row level security;

create policy "campaigns_select_member" on public.campaigns
  for select using (private.is_project_member(project_id));

-- Client-readable, server-written, like every workflow table. A client that could
-- UPDATE here could raise its own `budget_cap` or mark a campaign `live`, which is
-- precisely the authorisation the design puts in tool code rather than the caller.
grant select on public.campaigns to authenticated;
grant all on public.campaigns to service_role;

comment on table public.campaigns is
  'A marketing campaign: one channel, one authorised cap, one lifecycle. '
  'budget_cap NULL means nothing authorised, never unlimited. Client-readable, server-written.';

comment on column public.campaigns.budget_cap is
  'Authorised ceiling for this campaign. NULL means nothing authorised, never unlimited. '
  'Composed with projects.budget_ceiling by checkSpendCap in packages/marketing.';

comment on column public.campaigns.pause_reason is
  'Why spend stopped: kill_switch | cpa_breach | user | optimizer. The reason is data; '
  'the state is the same one however it was reached.';

comment on function private.guard_campaign_transition() is
  'Enforces the campaign lifecycle on every UPDATE and writes the audit event. '
  'SECURITY DEFINER so the machine binds any writer without that writer needing '
  'EXECUTE on its internals (the 20260815200000 lesson).';
