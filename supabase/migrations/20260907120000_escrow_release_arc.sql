-- 20260907120000_escrow_release_arc.sql — `held -> released` gets its producer,
-- so the arc gets permitted.
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0020-the-ceiling-has-two-committer-classes.md
--
-- **Still nothing is charged and nothing is transferred.** The only registered
-- payment provider is `packages/payments/src/fake-provider.ts`, an in-repo
-- deterministic fake that makes no network call and holds no key; its transfer
-- references are visibly `tr_fake_…` on every row this build writes.
-- `carriesRealMoney` is checked in `apps/api/src/lib/payout.ts` before the
-- transfer, exactly as `apps/api/src/lib/engagements.ts` checks it before the
-- accept rpc, so the first person to register Stripe hits a failing write rather
-- than a paragraph they did not read. **The counsel gate in payments-billing.md
-- is unmoved by this file**, for `20260904121000`'s reason restated: releasing a
-- modelled obligation back out of a modelled hold is not money movement, and the
-- gate applies to the slice that first calls a real provider.
--
-- ---------- Why this is its own migration ----------
--
-- `20260904121000` declared `released` in the check constraint and refused it in
-- the map, and said why in a paragraph that is worth honouring rather than
-- deleting: the constraint is the column's vocabulary, the map is the set of
-- moves something can make today, and permitting an arc with no producer is the
-- `task_deps` defect this repository has recorded five times. Its pgTAP
-- assertion was worded **descriptively** ("no producer exists") rather than
-- promissorily, precisely so that this migration is a change of fact rather than
-- the redemption of a promise.
--
-- The fact changed. `public.settle_payout` in `20260907122000` is the producer,
-- and it lands **in the same push**, on `20260904124000`'s two-files idiom: the
-- arc and its walker arrive together or neither arrives. A reader bisecting to
-- this commit finds an arc that something can walk.
--
-- ---------- The map after this file ----------
--
--   held -> refunded   the reconcile sweep (a cancelled step) and
--                      `public.reassign_engagement` (a no-show). The money goes
--                      back to the owner because the work will not happen.
--
--   held -> released   `public.settle_payout`. The money goes to the node
--                      because the work happened and the owner approved it.
--
-- **Both are terminal and there is no arc between them**, which is the property
-- worth stating: a released hold cannot be refunded and a refunded hold cannot be
-- released. Taking back money somebody earned, or paying twice for work that was
-- cancelled, would each require a *new* hold with its own key and its own reason,
-- and that is what a dispute is (slice 8). `private.escrow_state_is_terminal`
-- already covers both values and needs no change.

create or replace function private.escrow_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.escrow_state_is_terminal(p_from) then false
    -- The reconcile sweep and `reassign_engagement` refund; `settle_payout`
    -- releases. Both are terminal; a hold settles exactly once, in exactly one
    -- direction.
    when p_from = 'held' then p_to in ('refunded', 'released')
    else false
  end;
$$;

revoke all on function private.escrow_transition_allowed(text, text) from public;

comment on function private.escrow_transition_allowed(text, text) is
  'The escrow lifecycle as data. held -> refunded (the reconcile sweep, reassign_engagement) and '
  'held -> released (settle_payout). Both terminal, with no arc between them: reversing a '
  'settlement is a new hold with its own key, which is what a dispute is.';

comment on table public.escrow_holds is
  'A modelled escrow obligation against projects.budget_ceiling. NOTHING IS CHARGED and NOTHING '
  'IS TRANSFERRED: the only registered provider is the in-repo fake, and the counsel gate in '
  'payments-billing.md is unmoved. held -> refunded and held -> released are both permitted and '
  'both terminal; each has a producer as of 20260907122000.';

comment on column public.escrow_holds.state is
  'held is the only non-terminal value. released and refunded are both terminal and neither '
  'reaches the other: a settled hold is settled, and reversing one is a new hold with its own '
  'key.';
