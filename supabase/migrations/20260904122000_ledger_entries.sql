-- 20260904122000_ledger_entries.sql — double-entry, append-only, and readable by
-- nobody yet.
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/security-compliance.md
--
-- payments-billing.md: "Every movement writes balanced `ledger_entries`
-- (debit/credit) — append-only, immutable. The ledger is the source of truth for
-- reconciliation, not Stripe alone." This is that table, and it lands with the
-- first movement it has to record rather than ahead of one.
--
-- **Nothing here charges anything either.** See `20260904121000`'s header: the
-- only registered provider is the in-repo fake. What this records is the
-- double-entry shape of a modelled hold, so that the shape is right before real
-- money is ever in it. Getting a ledger's grants wrong after it holds real
-- entries is a much worse migration than getting them right now.
--
-- ---------- The grants are the whole design ----------
--
-- This takes the **`events` / `campaign_outcomes` shape**, which is the strictest
-- one in the schema: `revoke update, delete, truncate from authenticated, anon,
-- service_role`, and **no client policy and no client grant at all**.
--
-- Two things follow, and both are deliberate:
--
--   1. **`service_role` cannot edit or erase an entry.** Append-only that only
--      binds clients is not append-only; `campaign_outcomes` established that
--      here (`20260829123000`) and `marketing_rls.sql` pins it. A ledger is the
--      one table where "the server could fix it up" is precisely the property
--      that must not exist.
--
--   2. **A member reads no ledger rows, and that is not an oversight.** RLS is
--      enabled with no policy, which is `events`' own posture. The reader of raw
--      entries is the Phase-3 ops console ([admin-ops.md](admin-ops.md)); what a
--      member sees of their money is the **projection** the project GET builds
--      from `escrow_holds` and `campaigns`, which is a figure in their own
--      currency rather than a debit column. Handing a client a general ledger
--      would be shipping an accounting surface nobody designed.
--
--      The advisor lints this as `rls_enabled_no_policy`, exactly as it does for
--      `events`, and that is the correct reading of an intentionally unreadable
--      table rather than a finding to clear.
--
-- ---------- What enforces balance, since no constraint can ----------
--
-- A balanced pair is a property of two rows, and Postgres has no cheap way to
-- assert it per `ref_id` without a deferred constraint trigger that would fire on
-- every insert of a table whose whole purpose is to be written in pairs. So the
-- invariant lives where the pairs are constructed: `packages/payments/src/ledger.ts`
-- builds both entries from one hold and returns them together, `entriesBalance()`
-- is NaN-guarded the way `spend.ts` guards its amounts, and the only two writers
-- in the codebase insert what that module returns.
--
-- `marketplace_engagements.sql` pins the result rather than the mechanism:
-- `sum(debit) = sum(credit)` per `ref_id` after a real accept, which is the
-- assertion that would fail if a future writer hand-rolled a single entry.
--
-- ---------- Accounts are text, and the vocabulary is in code ----------
--
-- `owner_funds` and `escrow` are the two accounts this slice uses, declared as
-- constants in `packages/payments/src/ledger.ts`. Not an enum, on the
-- `channel_connections.provider` precedent (`20260831123000:70-73`): the chart of
-- accounts grows with every money feature (platform fee, node payable, tax
-- withheld), and a migration per account is a migration per bookkeeping decision.
-- A reviewed file gets read in a diff.

-- ---------- Table ----------

create table public.ledger_entries (
  id         uuid primary key default gen_random_uuid(),

  -- The chart of accounts lives in packages/payments. See the header.
  account    text not null check (char_length(account) between 1 and 64),

  -- **Exactly one side of the pair is nonzero.** Written as `(debit = 0) <>
  -- (credit = 0)` rather than as two constraints, because the interesting error
  -- is an entry that is somehow both or neither, and one expression says that.
  -- Both are `>= 0`: a negative debit is a credit wearing the wrong sign, and
  -- allowing it would make every sum ambiguous.
  debit      numeric(12, 2) not null default 0 check (debit >= 0),
  credit     numeric(12, 2) not null default 0 check (credit >= 0),

  currency   text not null,

  -- What this entry is about: `escrow_hold` today, `payout` and `dispute` later.
  -- Free text with the same reasoning as `account`.
  ref_type   text not null check (char_length(ref_type) between 1 and 32),
  ref_id     uuid not null,

  created_at timestamptz not null default now(),

  constraint ledger_entries_one_side
    check ((debit = 0) <> (credit = 0))
);

-- Reconciliation reads by reference: "show me the entries for this hold". Also
-- what the pgTAP balance assertion groups on.
create index ledger_entries_ref_idx on public.ledger_entries (ref_type, ref_id);

-- ---------- RLS and grants ----------
--
-- RLS on with no policy, and no grant to any client role. See the header: the
-- reader is the ops console, and a member's view of money is the projection.

alter table public.ledger_entries enable row level security;

grant select, insert on public.ledger_entries to service_role;

-- Immutable, including for `service_role`. Append-only that only binds clients is
-- not append-only (`20260829123000`'s lesson, applied where it matters most).
revoke update, delete, truncate on public.ledger_entries from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.ledger_entries is
  'Double-entry, append-only, immutable including for service_role. No client policy and no '
  'client grant: the reader is the Phase-3 ops console, and a member''s view of money is the '
  'projection the project GET builds. Balance is enforced by the pair constructors in '
  'packages/payments and pinned by pgTAP per ref_id, because it is a property of two rows.';

comment on column public.ledger_entries.account is
  'Chart of accounts as text, validated by packages/payments/src/ledger.ts rather than by an '
  'enum: the chart grows with every money feature, and a migration per account is a migration '
  'per bookkeeping decision.';

comment on column public.ledger_entries.ref_id is
  'The thing this entry is about, with ref_type naming which table. escrow_hold in slice 5; '
  'payouts and disputes later.';
