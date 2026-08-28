-- 20260829121000_marketing_channel_connections.sql — the workspace's own accounts.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md, docs/10-architecture/security-compliance.md
--
-- Ordered before `ad_entities`, which references this table.
--
-- **Room-scoped, not project-scoped**, and that is the `room_sources` reasoning
-- (`20260817120000`) applied to credentials. A connection to the user's ad
-- account arrives before any single campaign project exists, and one room carries
-- many projects: scoping it to a project would mean re-authorising the same ad
-- account for every goal posted in the same workspace, which is both worse
-- security theatre and worse product.
--
-- **This table holds OAuth tokens, and it is the reason it has no client policy
-- of any kind.**

create type public.channel_connection_status as enum (
  'active',
  'expired',   -- the token aged out; reconnectable
  'revoked'    -- the user or the platform withdrew it; not reconnectable in place
);

create table public.channel_connections (
  id                 uuid primary key default gen_random_uuid(),
  room_id            uuid not null references public.rooms (id) on delete cascade,
  connected_by       uuid not null references auth.users (id),
  -- Which adapter talks to this account. Validated against the checked-in
  -- registry in `packages/marketing`, never against a table, and that is the
  -- crawl-registry stance verbatim (`apps/api/src/lib/crawl-registry.ts`): a file
  -- gets reviewed in a diff, a row does not. `fake` is a legal value here and is
  -- the only one today. A provider is an editorial and security judgement, so it
  -- belongs where judgements are reviewed.
  provider           text not null,
  channel            public.marketing_channel not null,
  -- The platform's own account identifier, so a person can tell two connected
  -- accounts apart. Nullable: some providers hand it back only after the first
  -- call.
  external_account_id text,
  -- What the user actually granted. Tool code checks the scope a call needs
  -- against this before making it, rather than discovering the gap in a 403 from
  -- the platform. Rule 7 again: the check is in the tool, not in the prompt.
  granted_scopes     text[] not null default '{}',
  access_token       text,
  refresh_token      text,
  token_expires_at   timestamptz,
  status             public.channel_connection_status not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- One connection per account per provider per room. A second OAuth round trip
  -- for an account already connected updates the row rather than creating a
  -- rival one, which is what keeps "which token do we use" from having two
  -- answers.
  unique (room_id, provider, external_account_id)
);

create index channel_connections_room_idx on public.channel_connections (room_id, created_at desc);

-- ---------- RLS and grants ----------
--
-- **RLS is on, there is deliberately NO policy of any kind, and no grant to
-- `authenticated` or `anon`.** This is the `events` precedent (`20260813120000`)
-- for a stronger reason: `events` has no reader yet, while this table has a
-- reader that must never be a client. A row here holds an access token and a
-- refresh token, and a select policy that returned the row would return those
-- columns too, because RLS filters rows and not columns.
--
-- The absence of the grant is the control, and it fails the right way: a client
-- reading this table gets `permission denied` rather than zero rows. That
-- distinction is asserted in `supabase/tests/marketing_rls.sql`, because zero
-- rows is what a policy bug looks like and an error is what a deliberate refusal
-- looks like, and this repository has already lost 47 tasks to the two being
-- indistinguishable (`20260827110000`).
--
-- What a member legitimately needs to see, "Meta account connected, scopes X,
-- expires Y", is an API projection that selects the non-secret columns and is
-- authorised in the route. It lands with the OAuth callback in slice 2.
alter table public.channel_connections enable row level security;

grant all on public.channel_connections to service_role;

comment on table public.channel_connections is
  'OAuth connections to the user''s own ad, social and email accounts. Room-scoped '
  'so one workspace connects an account once. No client policy and no client grant: '
  'this table holds tokens, and RLS filters rows rather than columns.';

comment on column public.channel_connections.provider is
  'Adapter implementation, validated against the checked-in registry in packages/marketing. '
  'Not a channel: `fake` is a provider and `meta` is a channel.';

comment on column public.channel_connections.granted_scopes is
  'What the user actually authorised. Tool code checks a needed scope against this '
  'before the call, rather than learning it from the platform''s 403.';

-- ---------- Accepted risk, recorded ----------
--
-- Tokens are stored at rest without envelope encryption. That is written up in
-- docs/10-architecture/security-compliance.md in the house accepted-risk format,
-- and repeated here because the next person to read this table will read it here
-- first: acceptable only while the sole provider is the in-repo fake whose tokens
-- are worthless. **Trigger to fix: the first real provider credential** (slice 6).
-- Fix: pgsodium/KMS envelope encryption.
