-- 20260831122000_marketplace_node_credentials.sql — licences are verified, not claimed.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md, docs/10-architecture/security-compliance.md
--
-- human-nodes-marketplace.md is explicit that professional licences are
-- "**verified, not self-attested**" and that licence claims are "hard filters for
-- regulated tasks, not ranking weights". Those two sentences decide the whole
-- table: a boolean with nothing behind it is self-attestation with extra steps,
-- so `verified` cannot be true without dated evidence, and it cannot be quietly
-- turned back off.
--
-- **Named `node_credentials`, not `credentials` as the module doc says.** A table
-- called `public.credentials` sitting three tables from `channel_connections`
-- reads as auth credentials to every future schema browser, and this repository's
-- entire posture is that the next reader should not have to check. Rule 1 forbids
-- diverging silently, so human-nodes-marketplace.md and data-model.md are edited
-- in this same change with the reason. Nothing else is renamed.

-- ---------- Enums ----------

-- Exactly the three the docs name, and nothing else. **There is no `other`**: a
-- credential kind that means nothing cannot be a hard filter, and a hard filter
-- that matches everything is the regulated-task control switched off. Adding a
-- fourth is a reviewed migration, which is the registry stance ("a file gets
-- reviewed in a diff by a person; a row does not") applied to an enum.
-- Trigger to extend: the first vertical whose regulated act is none of these.
create type public.credential_kind as enum ('lawyer', 'accountant', 'notary');

-- ---------- Tables ----------

create table public.node_credentials (
  id             uuid primary key default gen_random_uuid(),
  node_id        uuid not null references public.node_profiles (user_id) on delete cascade,
  kind           public.credential_kind not null,
  -- A licence is jurisdiction-bound or it is not a hard filter.
  jurisdiction   text not null,
  issuer         text,
  licence_number text,
  verified       boolean not null default false,
  verified_at    timestamptz,
  -- A private Storage object path, **never a URL**: the same convention as
  -- `artifacts.storage_path` (`20260829124000`), where the path is the tenancy
  -- scheme and access is a signed URL minted per request. A stored URL is a
  -- credential that never expires.
  evidence_path  text,
  issued_on      date,
  expires_on     date,
  revoked_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One licence per node per kind per jurisdiction per number. Slice-3
  -- idempotency, designed now so the writer arrives to it.
  unique (node_id, kind, jurisdiction, licence_number),

  constraint node_credentials_verified_has_evidence check (
    verified = false or (verified_at is not null and evidence_path is not null)
  ),
  constraint node_credentials_jurisdiction_wellformed check (
    private.is_jurisdiction_code(jurisdiction)
  ),
  constraint node_credentials_validity_ordered check (
    expires_on is null or issued_on is null or expires_on > issued_on
  )
);

-- The regulated-task hard filter, and only it. Revoked credentials are excluded
-- in the index rather than in every future query.
create index node_credentials_filter_idx
  on public.node_credentials (kind, jurisdiction)
  where verified and revoked_at is null;

-- **No expiry index.** It would serve a sweep that does not exist, and it lands
-- with that sweep. Expiry is evaluated at match time against `expires_on`, which
-- is also why `kyc_status` has no `expired` value: a state you must run a clock to
-- enter is wrong between sweeps.

-- ---------- RLS and grants ----------

alter table public.node_credentials enable row level security;

create policy "node_credentials_select_own" on public.node_credentials
  for select using (node_id = auth.uid());

grant select on public.node_credentials to authenticated;
grant all on public.node_credentials to service_role;

-- ---------- The write-once guard ----------
--
-- Structural, not lifecycle, so it lands now: it is decidable from the row in
-- front of it and needs no writer's cooperation to be right.
--
-- Silently flipping `verified` back to false erases the fact that we once
-- asserted somebody was a lawyer, with nothing left pointing at why. Revocation
-- is a separate, dated fact and has its own column. Same shape and same argument
-- as `private.guard_ad_entity_external_id` (`20260829150000`): the predicate is
-- entirely in the trigger's `when` clause and the body is nothing but the raise,
-- which is what makes every ordinary update free.

create function private.guard_node_credential_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    'credential % is verified; un-verifying is not a change, revoking is',
    old.id
    using errcode = 'check_violation',
          hint = 'Set revoked_at instead. A licence we once asserted must leave a dated trail.';
end;
$$;

revoke all on function private.guard_node_credential_verified() from public;

create trigger node_credentials_guard_verified
  before update on public.node_credentials
  for each row
  when (old.verified and not new.verified)
  execute function private.guard_node_credential_verified();

comment on table public.node_credentials is
  'Verified professional licences. A licence claim is a hard filter for regulated work, '
  'never a ranking weight, so `verified` cannot be true without dated evidence and cannot '
  'be turned back off -- it is revoked. Own-row readable, server-written.';

comment on column public.node_credentials.evidence_path is
  'Private Storage object path, never a URL. Same convention as artifacts.storage_path: '
  'the path is the tenancy scheme and access is a signed URL minted per request.';

comment on function private.guard_node_credential_verified() is
  'Refuses un-verifying a verified credential. Revocation is revoked_at, which is dated; '
  'flipping the boolean would erase that we ever asserted it, with nothing pointing at why.';
