-- 20260829122000_marketing_ad_entities.sql — the tree a platform actually holds.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md
--
-- Every ad platform models the same three levels under different names: a
-- campaign holds ad sets, an ad set holds ads. Modelling that as one self
-- referencing table rather than three keeps the hierarchy rule in one place, and
-- the rule is what matters: a platform disapproves an **ad**, not a campaign, so
-- rejection has to be expressible at the leaf.

create type public.ad_entity_kind as enum ('campaign', 'ad_set', 'ad');

-- The per-entity lifecycle.
--
-- `rejected` is entity-level on purpose. The module rule is "ad-policy rejection
-- leads to revise, never silently keep spending", and that rule is unstateable if
-- disapproval can only be recorded against the whole campaign: the sibling ads
-- are still running, still legal, and still spending. `archived` is the platform's
-- own soft delete, kept distinct from `paused` because one is reversible and the
-- other is how a platform says it is done with the object.
create type public.ad_entity_state as enum (
  'draft',
  'publishing',
  'live',
  'paused',
  'rejected',   -- the platform disapproved this specific entity
  'archived',
  'failed'
);

create table public.ad_entities (
  id                    uuid primary key default gen_random_uuid(),
  campaign_id           uuid not null references public.campaigns (id) on delete cascade,
  -- Denormalised so the RLS predicate is a plain column test rather than a join,
  -- exactly as `artifacts` carries `project_id` beside `task_id`
  -- (`20260813160000`) and as `doc_chunks` carries `owner_project_id`. The
  -- tenant predicate on a hot path should not be a subquery.
  project_id            uuid not null references public.projects (id) on delete cascade,
  parent_id             uuid references public.ad_entities (id) on delete cascade,
  kind                  public.ad_entity_kind not null,
  state                 public.ad_entity_state not null default 'draft',
  -- The platform's own id. Null until published, and written exactly once:
  -- overwriting it would orphan a live object that is still spending, with
  -- nothing left in our database pointing at it.
  external_id           text,
  channel_connection_id uuid references public.channel_connections (id) on delete set null,
  -- The approved brief: targeting, creative reference, copy. **What was approved
  -- is what is published.** The publisher reads this column rather than asking the
  -- model to generate again at publish time, because a second generation is a
  -- different artifact from the one a person said yes to, and the difference would
  -- reach the world before anyone saw it.
  spec                  jsonb not null default '{}',
  -- The DB-unique key for the external side effect (rules 9 and 12). A retried
  -- publish collides here rather than creating a second ad. Unique across the
  -- table rather than per campaign: the key names one intended side effect, and
  -- scoping it would let the same intent produce two objects under two parents.
  idempotency_key       text unique,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- The root of the tree is the campaign-kind entity and it has no parent;
  -- everything else has one. Stated as a check rather than left to the trigger
  -- below because it needs no other row to decide.
  constraint ad_entities_root_has_no_parent check (
    (kind = 'campaign' and parent_id is null)
    or (kind <> 'campaign' and parent_id is not null)
  )
);

create index ad_entities_campaign_idx on public.ad_entities (campaign_id, created_at);
create index ad_entities_project_idx on public.ad_entities (project_id, created_at desc);
create index ad_entities_parent_idx on public.ad_entities (parent_id);

-- ---------- The hierarchy stays a hierarchy ----------
--
-- Nothing in `parent_id` says which parent is legal. Two things can go wrong and
-- both are silent: an `ad` parented directly to a `campaign` skips the ad set
-- that carries the targeting, and a parent in a different campaign makes the
-- campaign a leaky unit of pausing, which is exactly the cross-project-edge
-- argument `guard_task_dep_acyclic` makes for `task_deps`. A campaign you pause
-- that does not stop all of its spend is worse than one you cannot pause.
--
-- SECURITY DEFINER and pinned `search_path` for the `20260815200000` reason: the
-- writer must not need privileges on the guard's internals.
create function private.guard_ad_entity_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent public.ad_entities;
begin
  if new.parent_id is null then
    return new;
  end if;

  select * into v_parent from public.ad_entities where id = new.parent_id;
  if not found then
    raise exception 'ad_entities parent % does not exist', new.parent_id
      using errcode = 'foreign_key_violation';
  end if;

  if new.kind = 'ad_set' and v_parent.kind <> 'campaign' then
    raise exception 'an ad_set must hang off a campaign, not a %', v_parent.kind
      using errcode = 'check_violation',
            hint = 'The tree is campaign -> ad_set -> ad. See docs/30-modules/marketing-growth-engine.md.';
  end if;

  if new.kind = 'ad' and v_parent.kind <> 'ad_set' then
    raise exception 'an ad must hang off an ad_set, not a %', v_parent.kind
      using errcode = 'check_violation',
            hint = 'The tree is campaign -> ad_set -> ad. See docs/30-modules/marketing-growth-engine.md.';
  end if;

  if v_parent.campaign_id is distinct from new.campaign_id then
    raise exception 'ad_entities parent belongs to campaign %, not % ',
      v_parent.campaign_id, new.campaign_id
      using errcode = 'foreign_key_violation',
            hint = 'A campaign that cannot be paused as a whole is not a unit of anything.';
  end if;

  return new;
end;
$$;

revoke all on function private.guard_ad_entity_hierarchy() from public;

create trigger ad_entities_guard_hierarchy
  before insert or update on public.ad_entities
  for each row
  execute function private.guard_ad_entity_hierarchy();

-- ---------- RLS and grants ----------

alter table public.ad_entities enable row level security;

create policy "ad_entities_select_member" on public.ad_entities
  for select using (private.is_project_member(project_id));

grant select on public.ad_entities to authenticated;
grant all on public.ad_entities to service_role;

comment on table public.ad_entities is
  'The campaign -> ad_set -> ad tree as the platform holds it. `spec` is the approved '
  'brief and the publisher reads it rather than regenerating. Client-readable, server-written.';

comment on column public.ad_entities.external_id is
  'The platform''s own id. Null until published, written exactly once: overwriting it '
  'orphans a live object that is still spending.';

comment on column public.ad_entities.idempotency_key is
  'DB-unique key for the external side effect. A retried publish collides here rather '
  'than creating a second ad.';

comment on function private.guard_ad_entity_hierarchy() is
  'Keeps the ad tree well-formed: an ad_set hangs off a campaign, an ad off an ad_set, '
  'and a parent belongs to the same campaign. SECURITY DEFINER so it binds any writer.';
