-- 20260906123000_no_show_arcs.sql — a step a node took and abandoned can go back to the market.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0023-a-breached-deadline-reassigns.md
--
-- Marketplace slice 6, fourth migration. **Two arcs, and its producer is the very
-- next file in the same push.**
--
--     escrow_funded -> matching     a node accepted and never started
--     in_progress   -> matching     a node started and stopped
--
-- `20260904124000:10-12` set this idiom and it is followed here: the arc file and
-- the producer file are two files, landing together, so that a lifecycle only
-- ever widens when something can walk the new edge. `20260906124000` is
-- `public.reassign_engagement`, and it is the only thing in the system that can
-- make either of these moves.
--
-- ---------- Why `matching`, and not `escalated` or `failed` ----------
--
-- **Not `failed`**, on [ADR-0018](../../docs/40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)'s
-- grounds: it is terminal, it blocks every dependent step, and it would put
-- beyond reach work the marketplace can still finish with a different person.
--
-- **Not `escalated`**, and this is the interesting half.
-- `engagements.outcome` has carried `'reassigned'` since `20260904120000` with no
-- producer, and `engagements_one_live_idx` is a **partial** unique index on
-- `(task_id) where ended_at is null` rather than a plain unique, specifically so a
-- second engagement can exist on a task after a first one ends. Both were written
-- for this path. Routing a no-show to `escalated` would make `'reassigned'` a
-- word the schema uses and the product never means, and would leave that partial
-- index unjustified.
--
-- ---------- What is deliberately NOT restored ----------
--
-- **`claimed -> matching` stays permanently dropped.** ADR-0019 named slice 6 as
-- where the reassignment question genuinely reopens, and the answer is that the
-- arc is still not needed: accept and fund are one transaction, so `claimed` is
-- transit-only and no reassignment can ever leave from it. The producer leaves
-- from `escrow_funded` or `in_progress`, which is exactly what that ADR predicted.
--
-- **`proof_submitted -> in_progress` stays dropped**, reversing the slice table's
-- booking ([ADR-0022](../../docs/40-adr/0022-proof-is-an-artifact.md)). It was
-- booked for a withdrawn proof, which has no producer, and for the floor check
-- bouncing a bad hand-over, which turns out not to need it: that check runs
-- before anything is written and before the task moves, so a bounce leaves the
-- step where it was.
--
-- **`blocked -> in_progress` stays dropped**, on the same grounds as every other
-- refusal here: nothing writes `blocked` for a human step, so it would be an exit
-- from a state nothing can enter.
--
-- **No `-> disputed` arc is restored.** Slice 8, with the ops console. A
-- `disputed` task nobody can move is the `escalated` defect on purpose.
--
-- ---------- The one arc the sweep must never take ----------
--
-- Neither of these leaves from `proof_submitted` or `in_review`, and that is a
-- product rule rather than an omission: **a deadline that passes after the work
-- was handed over is the owner's failure to review, not the node's failure to
-- deliver.** Reassigning there would take work away from somebody who finished
-- it, and give their fee to somebody else. The sweep's selection is narrowed to
-- the two states above, and the map's shape is the second guard behind it.
--
-- The whole body is restated, per `20260827120000:44-47`. The only differences
-- from the applied version are the two `matching` entries.

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
    -- The two new edges. `in_progress` is where the work happens and
    -- `escrow_funded` is where it has been paid for and not begun; both go back
    -- to the market when the deadline passes, through `reassign_engagement` and
    -- through nothing else.
    when p_from = 'escrow_funded' then p_to in ('in_progress', 'matching')
    when p_from = 'in_progress' then p_to in ('proof_submitted', 'matching')
    when p_from = 'proof_submitted' then p_to in ('in_review')
    when p_from = 'in_review' then p_to in ('approved', 'rejected', 'disputed')
    when p_from = 'rejected' then p_to in ('in_progress')
    when p_from = 'disputed' then p_to in ('approved', 'rejected', 'cancelled')
    when p_from = 'approved' then p_to in ('done', 'payout_pending')
    when p_from = 'payout_pending' then p_to in ('paid')
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
  'Slice 6 added escrow_funded -> matching and in_progress -> matching, whose only producer is '
  'public.reassign_engagement. Neither leaves from proof_submitted or in_review, because a '
  'deadline that passes after delivery is the owner''s failure to review rather than the '
  'node''s failure to work.';
