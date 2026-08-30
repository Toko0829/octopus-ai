-- 20260831121000_marketplace_node_skills.sql — what a node claims, and what we checked.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md
--
-- The skill/trust graph's claim half. `verified` is the **hard filter** in the
-- matcher's pool query and self-attestation is the **ranking** input; both are the
-- same row distinguished by one boolean, because two tables for a claim and a
-- verified claim would need reconciling every time either changed, and the
-- reconciliation is exactly where a claim quietly becomes a credential.
--
-- No writer, like everything in this slice.

create table public.node_skills (
  node_id     uuid not null references public.node_profiles (user_id) on delete cascade,
  skill_tag   text not null,
  verified    boolean not null default false,
  verified_at timestamptz,
  created_at  timestamptz not null default now(),

  primary key (node_id, skill_tag),

  -- `skill_tag` is text with a shape check, **not an enum and not a taxonomy
  -- table**. The curated taxonomy is the `adapter-registry.ts` stance -- a file
  -- gets reviewed in a diff by a person and a row does not -- but that registry is
  -- code and belongs with its reader in slice 3. What is enforceable today, with
  -- no code, is the shape, so the shape is what lands. An enum would need a
  -- migration per skill.
  --
  -- Matches `legal-filing:US-TX`, `notary:US-TX`, `procurement`, `video-edit`.
  -- Refuses `Legal Filing`, `SEO`, and anything with a space.
  constraint node_skills_tag_shape check (
    skill_tag ~ '^[a-z0-9]+(-[a-z0-9]+)*(:[A-Z]{2}(-[A-Za-z0-9]+){0,2})?$'
  ),

  -- A verified claim with no date cannot be aged out or audited.
  constraint node_skills_verified_has_time check (verified = false or verified_at is not null)
);

-- The pool query filters on verified skill and nothing else at this level.
create index node_skills_tag_idx on public.node_skills (skill_tag) where verified;

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant. Both, always.

alter table public.node_skills enable row level security;

-- `node_id` and the user's id are the same uuid, which is what
-- `node_profiles.user_id being the primary key` buys: the tenant predicate is a
-- plain equality rather than a subquery through the parent.
create policy "node_skills_select_own" on public.node_skills
  for select using (node_id = auth.uid());

-- No client write grant, for the same reason as `node_profiles`: `verified` is a
-- hard filter on regulated work, and a filter its subject can set is not a filter.
grant select on public.node_skills to authenticated;
grant all on public.node_skills to service_role;

comment on table public.node_skills is
  'A node''s claimed skills. `verified` is the matcher''s hard filter and the claim '
  'itself is a ranking input, which is why both live on one row. Own-row readable, '
  'server-written: a client that could set `verified` could self-certify.';

comment on column public.node_skills.skill_tag is
  'Shape-checked text (legal-filing:US-TX, notary:US-TX, procurement), not an enum: an '
  'enum needs a migration per skill. The curated taxonomy is a reviewed code registry '
  'and lands with its reader in slice 3.';
