-- 20260913120000_model_connections.sql — the workspace's own reasoning provider key.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/ai-orchestrator.md, docs/10-architecture/security-compliance.md
--
-- ADR-0032: the reasoning provider is a workspace connector and the server's
-- OpenAI key is its default. A workspace connects its own Anthropic, OpenAI or
-- Google key and picks which model answers for each of the four voices.
--
-- **Room-scoped, not project-scoped**, which is `channel_connections`'
-- reasoning (`20260829121000`) verbatim: a key arrives before any single
-- project exists and one room carries many projects, so scoping it to a project
-- would mean re-pasting the same key for every goal posted in the same
-- workspace.
--
-- **This table holds a customer's paid API key, and that is why it has no client
-- policy of any kind.** RLS filters rows and not columns, so a select policy
-- that returned the row would return the ciphertext, the IV and the tag with it.
-- The absence of the grant is the control, and it fails the right way: a client
-- reading this table gets `permission denied` rather than zero rows. Zero rows
-- is what a policy bug looks like and an error is what a deliberate refusal
-- looks like, and this repository has already lost 47 tasks to the two being
-- indistinguishable through PostgREST (`20260827110000`).
--
-- What a member legitimately needs to see, "Anthropic connected, key ending
-- 4f2a", is an API projection over the non-secret columns, authorised in the
-- route. `ModelConnection` in `packages/contracts` is that projection and
-- carries no key field at all.
--
-- ---------- How this differs from `channel_connections`, which matters ----------
--
-- That table stores its tokens as plaintext under a recorded accepted risk whose
-- stated trigger is "the first real provider credential". **This table meets that
-- trigger and does not repeat the exception.** The key arrives encrypted from the
-- first migration: AES-256-GCM in `apps/api/src/lib/envelope.ts` under
-- `MODEL_KEY_SECRET`, with the additional authenticated data bound to the row
-- (`model_connections:{roomId}:{provider}:v{key_version}`), so a ciphertext
-- copied from one row into another fails to open rather than decrypting under
-- the wrong owner.
--
-- Supabase Vault was considered and rejected for a reason specific to this
-- system: Vault decrypts inside Postgres for any role that can read
-- `vault.decrypted_secrets`, and `services/ai` holds `service_role`. Storing
-- keys there would let the Python container read every customer's key by
-- selecting a view, which defeats the property this design exists to buy, that
-- decryption is confined to the Node code that builds the outbound request.
--
-- **Accepted risk, recorded.** The remaining exposure is a JOINT leak: the
-- database AND `MODEL_KEY_SECRET` together. Neither alone yields a key. That is
-- written up in docs/10-architecture/security-compliance.md in the house format.
-- Trigger to narrow it further: the first production deployment, which should
-- hold the master key in a KMS rather than an environment variable.

create table public.model_connections (
  id             uuid primary key default gen_random_uuid(),
  room_id        uuid not null references public.rooms (id) on delete cascade,
  connected_by   uuid not null references auth.users (id),
  -- Which provider this key belongs to. Validated against the checked-in
  -- registry in `packages/contracts`, never against a table and never as an
  -- enum, which is the crawl-registry and `channel_connections` stance: a file
  -- gets reviewed in a diff, a row does not. An enum would also make removing a
  -- provider a migration, and `20260908...`'s note on unremovable enum values
  -- records what that costs.
  provider       text not null,

  -- The sealed key. Three columns rather than one blob so a malformed row is a
  -- constraint violation rather than a parse error four minutes into a run.
  key_ciphertext text,
  key_iv         text,
  key_tag        text,
  -- Which master key sealed this. On the row from the first migration so that
  -- rotation is a re-seal over a known column rather than a schema change under
  -- time pressure; the rotation tooling itself is named-not-built, with the
  -- first rotation as its trigger.
  key_version    smallint not null default 1,

  -- The last four characters, so a person can tell two keys apart. Not a
  -- credential and not completable into one, which is why it is the only
  -- key-shaped thing the projection carries.
  key_hint       text not null check (char_length(key_hint) between 1 and 8),

  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- Two values, checked rather than enumerated, for the reason `provider` gives.
  -- There is no `expired` here as there is on `channel_connections`: an API key
  -- does not age out on a timer the way an OAuth token does, and a value nothing
  -- can ever write is a state the reader has to reason about for nothing.
  constraint model_connections_status_known check (status in ('active', 'revoked')),

  -- An active row must be openable, and a revoked one must be unopenable. Both
  -- halves, because each catches a different mistake: the first catches a write
  -- that stored a hint without a key, and the second catches a revocation that
  -- changed the status and left the key sitting there.
  constraint model_connections_active_has_key
    check (status <> 'active' or (key_ciphertext is not null and key_iv is not null and key_tag is not null)),
  constraint model_connections_revoked_has_no_key
    check (status <> 'revoked' or (key_ciphertext is null and key_iv is null and key_tag is null)),

  -- One key per provider per room. Re-pasting a key for a provider already
  -- connected updates the row rather than creating a rival, which is what keeps
  -- "which key do we use" from having two answers.
  unique (room_id, provider)
);

create index model_connections_room_idx on public.model_connections (room_id, created_at desc);

-- ---------- RLS and grants ----------
--
-- **RLS is on, there is deliberately NO policy of any kind, and no grant to
-- `authenticated` or `anon`.** The `channel_connections` precedent, for a
-- credential that is worth more: a fake OAuth token buys nothing, and a
-- customer's Anthropic key buys their whole quota.
--
-- A linter will report `rls_enabled_no_policy` on this table. That INFO is the
-- design, not a finding: the table is server-only, and the day it grows a select
-- policy is the day a member can read a ciphertext.
alter table public.model_connections enable row level security;

grant all on public.model_connections to service_role;

comment on table public.model_connections is
  'A workspace''s own reasoning-provider API key, sealed AES-256-GCM under MODEL_KEY_SECRET '
  'with the AAD bound to the row. Room-scoped. No client policy and no client grant: '
  'this table holds a credential, and RLS filters rows rather than columns.';

comment on column public.model_connections.provider is
  'Registry id from packages/contracts (anthropic, openai, google, fake). Validated in '
  'application code against a checked-in file, never against a table and never an enum.';

comment on column public.model_connections.key_hint is
  'Last four characters of the key, so a person can tell two apart. The only key-shaped '
  'value the API projection carries.';

comment on column public.model_connections.key_version is
  'Which master key sealed this row, and part of the AAD. Present from the first migration '
  'so a rotation is a re-seal rather than a schema change.';
