-- 20260908120000_dispute_arcs.sql — a deal that went wrong can be said to have gone wrong.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/30-modules/admin-ops.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, first migration. **Five arcs, and their producers are the
-- next files in the same push** (`20260908124000_raise_dispute.sql` and
-- `20260908125000_resolve_dispute.sql`), on the idiom `20260904124000:10-12` set
-- and `20260906123000` followed: the arc file and the producer file land
-- together, so a lifecycle only ever widens when something can walk the new edge.
--
--     escrow_funded -> disputed     the owner paid, the node never started, and something is wrong
--     in_progress   -> disputed     the work is happening and the owner objects
--     rejected      -> disputed     the NODE objects: the owner sent back work they did
--     payout_pending -> disputed    the owner objects after approving, before the sweep pays
--     disputed      -> matching     ops sends the step back to the market
--
-- `20260906123000:53-54` refused all of these by name: "No `-> disputed` arc is
-- restored. Slice 8, with the ops console. A `disputed` task nobody can move is
-- the `escalated` defect on purpose." That console lands in this push, so the
-- refusal expires here rather than being carried a sixth time.
--
-- ---------- Why all four inbound arcs land together ----------
--
-- Because they are one product fact — "this deal went wrong" — observed from
-- four points in the deal, and shipping a subset would mean choosing which
-- grievances are expressible by which party. Each names a distinct grievance and
-- a distinct party:
--
--   * `escrow_funded` and `in_progress` are the owner's, mid-work.
--   * `rejected` is **the node's**, and it is the only arc in this system a node
--     can walk against the owner. Without it, "the owner rejected work I did and
--     kept the step" has no expression at all and the node's only recourse is to
--     stop answering, which the no-show sweep then reads as their fault.
--   * `payout_pending` is the freeze. `PAYABLE_TASK_STATES` in
--     `apps/api/src/lib/payout.ts:86` is `('approved', 'payout_pending')`, so
--     moving the task to `disputed` **is** what stops the money: the sweep's
--     selection no longer matches it. There is no separate freeze flag, and there
--     must not be one — a flag the sweep might not read is a freeze that might
--     not hold.
--
-- ---------- `disputed -> matching`, the one genuinely new edge ----------
--
-- The other four restore edges `20260813120000` declared and `20260815220000`
-- dropped while rewriting the map for an unrelated reason. This one has never
-- existed. admin-ops.md:15 specifies **reassign** as one of the four dispute
-- outcomes, and `matching` is where a step goes to find a different person —
-- `20260906123000` established exactly that for the no-show sweep and gave the
-- reasons (not `failed`, which is terminal and blocks dependents; not
-- `escalated`, which would make `engagements.outcome = 'reassigned'` a word the
-- schema uses and the product never means).
--
-- **`cascadeRound` absorbs it.** `apps/api/src/lib/match.ts` counts every return
-- from dispatch as `to = 'matching' and from <> 'escalated'`, which is written
-- against the shape of the arrival rather than a list of origins, so an arrival
-- from `disputed` counts without being enumerated. Asserted in
-- `supabase/tests/marketplace_disputes.sql` rather than assumed.
--
-- ---------- What is deliberately NOT restored ----------
--
-- **`disputed -> in_progress` stays permanently dropped**
-- ([ADR-0026](../../docs/40-adr/0026-the-dispute-exit-map.md)). It was declared
-- by `20260813120000:324` and reads as "give the step back to the same node",
-- which is a real outcome and already has a path: ops upholds the owner's
-- rejection, the task returns to `rejected`, and the node re-does the work
-- through `rejected -> in_progress`, which has existed since the map was
-- written. A second edge to the same place would let a resolution skip the
-- record of what was decided.
--
-- **No arc from `approved`, `paid` or `done`.** A dispute after the transfer has
-- an unresolvable half: `payouts.transfer_id` is write-once and the money has
-- left. `approved` is excluded for a nearer reason — it is the state the payout
-- sweep picks up first, and an owner who wants to stop it has `payout_pending`
-- one tick later, or the `in_review` arc one tick earlier. Recorded in
-- human-nodes-marketplace.md as a limit rather than left to be discovered.
--
-- **`in_review -> disputed` is unchanged and still has no button.** It has been
-- the only inbound arc since `20260815220000`, and `in_review` is transit-only
-- (`20260906120000`: the owner's approve/reject walks `proof_submitted ->
-- in_review -> approved|rejected` inside one request), so nothing rests there
-- long enough for a person to dispute from it. It stays legal because removing a
-- legal arc to tidy the map is how `20260815220000` caused this slice.
--
-- The whole body is restated, per `20260827120000:44-47`. The only differences
-- from the applied version are the four `disputed` inbound entries and the
-- widened `disputed` exit list.

create or replace function private.task_transition_allowed(p_from public.task_state, p_to public.task_state)
returns boolean
language sql
immutable
set search_path to 'public', 'private', 'pg_temp'
as $function$
  select case
    when private.task_state_is_terminal(p_from) then false
    when p_to in ('cancelled', 'blocked') then true
    when p_from = 'blocked' then p_to in ('pending', 'ready', 'routing', 'cancelled')
    when p_from = 'pending' then p_to in ('ready')
    when p_from = 'ready' then p_to in ('routing')
    when p_from = 'routing' then p_to in ('ai_running', 'escalated', 'needs_user')
    when p_from = 'ai_running' then p_to in ('ai_self_check', 'failed', 'escalated')
    when p_from = 'ai_self_check' then p_to in ('approved', 'ai_running', 'escalated', 'failed')
    when p_from = 'needs_user' then p_to in ('routing', 'approved')
    when p_from = 'escalated' then p_to in ('matching', 'approved', 'routing')
    when p_from = 'matching' then p_to in ('offered', 'escalated')
    when p_from = 'offered' then p_to in ('claimed', 'matching')
    when p_from = 'claimed' then p_to in ('escrow_funded')
    -- The owner's two mid-work grievances. `matching` on both is slice 6's
    -- no-show path and is unchanged.
    when p_from = 'escrow_funded' then p_to in ('in_progress', 'matching', 'disputed')
    when p_from = 'in_progress' then p_to in ('proof_submitted', 'matching', 'disputed')
    when p_from = 'proof_submitted' then p_to in ('in_review')
    when p_from = 'in_review' then p_to in ('approved', 'rejected', 'disputed')
    -- The node's arc, and the only one in this system a node walks against the
    -- owner. `in_progress` beside it is the bounded re-do and is unchanged.
    when p_from = 'rejected' then p_to in ('in_progress', 'disputed')
    -- `matching` is the new edge: ops sending the step back to the market is
    -- admin-ops.md's "reassign" outcome. The other three are unchanged, and
    -- `in_progress` is deliberately still absent (ADR-0026).
    when p_from = 'disputed' then p_to in ('approved', 'rejected', 'cancelled', 'matching')
    when p_from = 'approved' then p_to in ('done', 'payout_pending')
    -- The freeze. Moving the task out of the sweep's selection is what stops the
    -- transfer; `paid` beside it is unchanged.
    when p_from = 'payout_pending' then p_to in ('paid', 'disputed')
    when p_from = 'paid' then p_to in ('done')
    else false
  end;
$function$;

-- Restated on every rewrite of this function since `20260813130000`, because a
-- guard that anybody may call is a guard anybody may reason about. The trigger
-- that applies it is SECURITY DEFINER (`20260815200000`), so it does not need
-- this grant and trusted server code cannot route around the map.
revoke all on function private.task_transition_allowed(public.task_state, public.task_state) from public;

comment on function private.task_transition_allowed(public.task_state, public.task_state) is
  'The per-task state machine, enforced by trigger against service_role and superuser alike. '
  'Slice 8 restored the four -> disputed arcs 20260815220000 dropped, whose producer is '
  'public.raise_dispute, and added disputed -> matching, whose producer is '
  'public.resolve_dispute. Moving a task to disputed is the payout freeze: '
  'PAYABLE_TASK_STATES no longer matches it, so there is no separate freeze flag. '
  'disputed -> in_progress stays dropped (ADR-0026): a resolution that returns work to the '
  'same node goes through rejected, which records what was decided.';
