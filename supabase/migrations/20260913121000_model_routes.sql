-- 20260913121000_model_routes.sql — which model answers for which voice.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/ai-orchestrator.md, docs/30-modules/chat-discord.md
--
-- ADR-0032 decision 6. Six roles: the four voices of ADR-0031, plus `fallback`
-- for the labelled ungrounded tier and `creative` for image generation. Per
-- workspace, owner-only to write.
--
-- **An absent row is the feature, not a missing default.** No row for a role
-- means the house default answers, which is what "Auto" means on the settings
-- surface. Seeding six rows per room at creation would turn a preference nobody
-- expressed into a stored decision, and would make "the owner never chose" and
-- "the owner chose what we happened to pick" the same state.
--
-- ---------- Member-readable, and that is the difference from the key table ----------
--
-- `model_connections` has no client policy because it holds a credential.
-- This table holds no secret: it says that the Ads voice runs on GPT-5.4, which
-- is the same fact every message chip in the room already shows next to the
-- message that voice wrote. Hiding it from members would hide it from nobody
-- while costing the client a round trip through the API for something RLS can
-- answer directly.
--
-- **Read for members, written only by the server.** `apps/api` writes as
-- `service_role` after reading the room as the caller and checking `owner_id`,
-- which is the `room_profiles` split (`20260911120000`). A client able to write
-- here could point another workspace member's voice at a provider the owner
-- never connected.
--
-- **A route grants nothing.** It names which endpoint composes a proposal.
-- `routeTask`, `checkSpendCap` and `apply_plan_diff` do not read this table, so a
-- role with the strongest model routed to it has exactly the authority it had
-- with none, which is none. Recorded here because a table called "routes" beside
-- a table called "connections" is the place a later change is most likely to
-- mistake a preference for a capability.

create table public.model_routes (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  role       text not null,
  -- Registry ids from `packages/contracts`, validated in application code for
  -- the reason `model_connections.provider` gives. `model` is deliberately
  -- unconstrained beyond a length: vendors retire and rename ids without asking,
  -- and a closed vocabulary in Postgres would make a route that was valid when
  -- it was written into a row nobody can update.
  provider   text not null,
  model      text not null check (char_length(model) between 1 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,

  -- One route per role per room. Choosing again replaces rather than appends,
  -- because "which model answers for Ads" has exactly one answer.
  primary key (room_id, role),

  -- The role set IS closed, unlike the model list, and the asymmetry is the
  -- point: a role is a fact about this system's own six jobs, it changes only
  -- when we change, and a typo'd role would silently never be resolved by
  -- anything.
  constraint model_routes_role_known
    check (role in ('strategist', 'content', 'ads', 'analyst', 'fallback', 'creative'))
);

alter table public.model_routes enable row level security;

create policy model_routes_select_member on public.model_routes
  for select to authenticated
  using (private.is_room_member(room_id));

-- A policy is not a grant (data-model.md): select for the client role, nothing
-- else, and Supabase's default TRUNCATE/REFERENCES/TRIGGER revoked as every
-- table here does.
grant select on public.model_routes to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.model_routes
  from anon, authenticated;
grant all on public.model_routes to service_role;

comment on table public.model_routes is
  'Which model answers for each of the six roles in a workspace. No row means the house '
  'default, which is what Auto means. Member-readable because it holds no secret; '
  'server-written after an owner check. A route is a preference, never a grant.';

comment on column public.model_routes.model is
  'Raw vendor model id. Length-checked only: ids are an open vocabulary that vendors '
  'change without asking, and an unknown one still renders as itself.';
