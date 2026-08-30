-- 20260831123000_marketplace_node_verifications.sql — the check log, which no client may read.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/10-architecture/security-compliance.md, docs/30-modules/human-nodes-marketplace.md
--
-- **This table is not in the module's entity list. It is forced by it.**
--
-- The marketing domain's four were: the unit of work, the tree, the evidence, and
-- the one table with no client reader because it holds something RLS cannot
-- filter. `channel_connections` is that table because RLS filters rows and not
-- columns, so any policy returning the row returns the tokens with it.
--
-- The marketplace has the identical shape and a worse payload, **for a different
-- reason**. That table has no client reader because it holds secrets. This one has
-- no client reader because it holds **a third party's identity and an adverse
-- inference about the subject**. `matched_node_id` names another human being this
-- node may be a duplicate of; a face-search hit is an accusation. Put those fields
-- on `node_profiles`, which a node must be able to read because it is their own
-- record, and the same defect appears one level down. So the split is forced by
-- the decision to let a node read their own profile at all, and this table is what
-- that argument produces.
--
-- The node's legitimate view -- "identity verified on 3 August" -- is
-- `node_profiles.kyc_status`, which they can read.

-- ---------- Enums ----------

-- One value per check named in security-compliance.md §KYC/AML and the module's
-- anti-fraud section. `face_match` (1:1, is this the document holder) and
-- `face_search` (1:N, is this somebody already enrolled) are separate because
-- **only the second can name a third party**, and that difference is exactly what
-- `node_verifications_match_only_on_face_search` below enforces.
create type public.verification_kind as enum (
  'document',
  'liveness',
  'face_match',    -- 1:1 against the document
  'face_search',   -- 1:N across enrolled nodes; the only kind that can name someone else
  'sanctions_pep',
  'license_check'
);

-- **There is no `pending`.** A row is written when the provider answers; "we asked
-- and are waiting" is `node_profiles.kyc_status = 'pending'`, which is what that
-- value is for. A re-check is a new row, which is also the anti-fraud history you
-- want.
--
-- `inconclusive` and `error` are kept apart because they decide retryability
-- oppositely. `inconclusive` is the provider's verdict (the photo was too dark)
-- and retrying with the same evidence is pointless; `error` is our call failing
-- and retrying with the same evidence is exactly right. Collapsed, the retry
-- decision becomes unmakeable from the row -- the same argument `20260827120000`
-- makes for `escalated -> routing`.
create type public.verification_result as enum (
  'passed',
  'failed',
  'inconclusive',  -- the provider decided it could not tell; the same evidence will not help
  'error'          -- our call failed; the same evidence is worth retrying
);

-- ---------- Tables ----------

create table public.node_verifications (
  id              uuid primary key default gen_random_uuid(),
  node_id         uuid not null references public.node_profiles (user_id) on delete cascade,
  -- Set only for `license_check`, which is why `node_credentials` has no
  -- `verified_by` column: that would name an internal actor on a table the node
  -- can read. The settled verdict lives there, the log and the actor live here,
  -- behind the no-grant boundary.
  credential_id   uuid references public.node_credentials (id) on delete cascade,
  kind            public.verification_kind not null,
  -- Validated against the code registry in slice 3, not here: a provider is a
  -- reviewed file, and a check constraint would need a migration per provider.
  provider        text not null,
  provider_ref    text,
  result          public.verification_result not null,
  -- Verdicts, scores and references. **Never the document, the image, a date of
  -- birth or a number.** security-compliance.md is explicit that sensitive KYC
  -- data is held by the licensed provider and not by us, and this is the column
  -- where that promise is either kept or quietly broken.
  detail          jsonb not null default '{}',
  matched_node_id uuid references public.node_profiles (user_id) on delete set null,
  decided_at      timestamptz not null default now(),
  idempotency_key text unique,
  created_at      timestamptz not null default now(),

  constraint node_verifications_license_has_credential check (
    (kind = 'license_check') = (credential_id is not null)
  ),
  constraint node_verifications_match_only_on_face_search check (
    matched_node_id is null or kind = 'face_search'
  ),
  constraint node_verifications_match_is_not_self check (
    matched_node_id is null or matched_node_id <> node_id
  )
);

create index node_verifications_node_idx
  on public.node_verifications (node_id, created_at desc);

-- The 1:N dedup query: given a node, who else has it collided with.
create index node_verifications_match_idx
  on public.node_verifications (matched_node_id)
  where matched_node_id is not null;

-- ---------- RLS and grants ----------
--
-- **RLS is on, there is deliberately NO policy of any kind, and no grant to
-- `authenticated` or `anon`.** This is the `channel_connections` precedent
-- (`20260829121000`) for the reason argued in the header: RLS filters rows and not
-- columns, so a policy letting a node read their own row hands them the identity
-- of the person they collided with plus every provider score used to decide
-- against them.
--
-- The absence of the grant is the control, and it fails the right way: a client
-- reading this table gets `permission denied` rather than zero rows. That
-- distinction is asserted in `supabase/tests/marketplace_rls.sql` **for the
-- subject of the record themselves**, not merely for an outsider, because zero
-- rows is what a policy bug looks like and an error is what a deliberate refusal
-- looks like -- and this repository has already lost forty-seven tasks to the two
-- being indistinguishable (`20260827110000`).

alter table public.node_verifications enable row level security;

grant all on public.node_verifications to service_role;

-- **Append-only including for `service_role`.** Same reasoning as
-- `campaign_outcomes` (`20260829123000`), `feedback_events` and `events`: a
-- verification is the evidence behind a decision that can stop somebody earning,
-- and a record that trusted code can rewrite after the fact is not evidence of
-- anything. A re-check is a new row.
--
-- **TRUNCATE is revoked alongside UPDATE and DELETE, and it is the one people
-- miss.** `grant all` includes it, it is not row-level, and it ignores RLS
-- entirely, so a role holding it can empty the table whatever the policies say.
--
-- Consequence, stated here so slice 3's writer arrives to it rather than
-- discovering it in a failing write: `insert ... on conflict do nothing` is not
-- merely the house idiom, it is the **only available** idiom.
-- `on conflict do update` fails on privilege rather than on conflict. That is the
-- constraint which shaped `metricsSweep`, arriving before its writer this time.
revoke update, delete, truncate on public.node_verifications
  from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.node_verifications is
  'The KYC/anti-fraud check log. No policy and no client grant at all: a row can name a '
  'third party (matched_node_id) and carries adverse-inference scores about its subject, '
  'and RLS filters rows rather than columns. A client is REFUSED rather than shown zero '
  'rows, and so is the subject. Append-only including for service_role.';

comment on column public.node_verifications.detail is
  'Provider verdicts, scores and references ONLY. Never the document, the image, a date '
  'of birth or an identifier. Sensitive KYC data is held by the licensed provider, not by '
  'us (security-compliance.md).';

comment on column public.node_verifications.matched_node_id is
  'The already-enrolled node this one may duplicate. Set only on face_search, never to '
  'self. This single column is why the table has no reader: it names somebody who is not '
  'the subject.';
