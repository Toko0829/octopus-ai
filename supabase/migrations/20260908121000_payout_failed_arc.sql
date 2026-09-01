-- 20260908121000_payout_failed_arc.sql — `payouts.failed` gets the producer it was promised.
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/10-architecture/data-model.md,
--       docs/30-modules/admin-ops.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, second migration. **One arc, and its producer is
-- `20260908125000_resolve_dispute.sql` in the same push.**
--
--     pending -> failed
--
-- `20260907121000` declared `failed` in the check constraint, left it out of the
-- map, and named the exact condition for its return: "Its producer is that
-- console, with a person behind it (admin-ops.md, Phase 3)." The dispute console
-- lands in this push. This is that.
--
-- ---------- What this arc is for, and what it is NOT for ----------
--
-- **It is not a failed transfer.** `20260907121000`'s refusal on that point is
-- unchanged and stays right: nothing in this codebase decides that a payout for
-- work an owner has already approved will never happen, so a provider error
-- still retries at tick cadence and is still logged loudly. A terminal row
-- against work somebody did is worse than a retry that keeps trying.
--
-- **It is a payout that has been overtaken by a dispute.** The freeze is
-- `payout_pending -> disputed` (`20260908120000`), and it can catch a step that
-- already has a `payouts` row at `pending` — the sweep writes that row before
-- the transfer, on ADR-0013's ordering. If the dispute then resolves to anything
-- other than `released`, three things become true at once: the engagement ends
-- `disputed_resolved`, the hold goes to `refunded`, and that `pending` row
-- becomes a **record of money owed that will never be sent**.
--
-- Nothing would ever select it again — the sweep reads engagements at
-- `ended_at is null` and joins to holds at `state = 'held'`, and after a refund
-- neither is true — so leaving it at `pending` is not a stuck job. It is worse
-- than a stuck job: it is a money record that says something untrue and that no
-- reader can distinguish from a payout still in flight. `resolve_dispute` moves
-- it, in the same transaction as the refund, so the two facts cannot disagree.
--
-- ---------- Why `failed` and not a new value ----------
--
-- Because the vocabulary already had the right word and the constraint already
-- allowed it. A `cancelled` or `voided` value would be more precise about *why*,
-- and the `payload` on the `payout.transitioned` event carries that reason
-- already; adding a fourth state to distinguish two kinds of not-paid would put
-- the reason in two places, and this repository's recorded cost of two places is
-- that they drift.
--
-- ---------- No retry, and no un-failing ----------
--
-- `failed` stays terminal. There is deliberately no `failed -> pending`:
-- a payout that failed *here* failed because the money went back to the owner,
-- so retrying it would pay for work that was refunded. If a dispute resolution
-- decides the node should be paid after all, that resolution is `released`, the
-- task returns to `approved` with the engagement still live, and the sweep pays
-- through the row that already exists. Recorded in payments-billing.md rather
-- than left for somebody to try.
--
-- The whole body is restated, per this repository's convention for a
-- `create or replace` map. The only difference from the applied version is the
-- `failed` entry on the `pending` arm.

create or replace function private.payout_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when private.payout_state_is_terminal(p_from) then false
    -- `public.settle_payout` once the provider has answered, and
    -- `public.resolve_dispute` when a dispute resolved against a payout that had
    -- already been recorded and can now never be sent.
    when p_from = 'pending' then p_to in ('paid', 'failed')
    else false
  end;
$$;

revoke all on function private.payout_transition_allowed(text, text) from public;

comment on function private.payout_transition_allowed(text, text) is
  'The payout lifecycle. pending is the only non-terminal value. pending -> paid is '
  'public.settle_payout; pending -> failed is public.resolve_dispute, and ONLY for a payout '
  'overtaken by a dispute that refunded the hold underneath it. A failed provider call is still '
  'not this: it retries at tick cadence, because nothing here decides that approved work will '
  'never be paid. There is no failed -> pending, because the money went back.';

comment on column public.payouts.state is
  'pending is the only non-terminal value. failed means this payout was overtaken by a dispute '
  'that refunded the hold, written by public.resolve_dispute in the same transaction as the '
  'refund so the two records cannot disagree. A failed provider call is NOT this: it retries at '
  'tick cadence and stays pending.';
