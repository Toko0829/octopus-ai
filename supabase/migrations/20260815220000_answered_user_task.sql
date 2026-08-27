-- 20260815220000_answered_user_task.sql — an answered step had nowhere to land.
--
-- The machine allowed exactly one way out of `NEEDS_USER`, back to `ROUTING`, and
-- `business-projects-workflow.md` draws that arc as "a user who answers". Follow
-- it: the router sees a task whose `owner_type` is `user`, applies rule 2, and
-- sends it to `NEEDS_USER` again. **The answer had nowhere to go and the loop had
-- no end.** Nothing failed; the task simply waited forever, which is the shape of
-- defect this project keeps finding.
--
-- `NEEDS_USER -> APPROVED` closes it, and the semantics are the point rather than
-- a convenience. The plan gave this person work only they could do: a budget
-- ceiling, a positioning call, which analytics source counts as the truth. When
-- they answer, **they have done the step**, not merely unblocked it. `APPROVED` is
-- the state that satisfies dependents, so their answer is what lets the rest of
-- the graph move, which is exactly right.
--
-- `ROUTING` stays alongside it for the other case, where an answer changes what
-- should happen rather than completing anything.
--
-- Everything else in this function is reproduced unchanged. `create or replace`
-- rewrites the whole body, so the arcs are restated rather than patched, and the
-- diagram in `business-projects-workflow.md` remains the specification this is
-- derived from.

create or replace function private.task_transition_allowed(
  p_from public.task_state,
  p_to   public.task_state
) returns boolean
language sql
immutable
security invoker
set search_path = public, private, pg_temp
as $$
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
    when p_from = 'escalated' then p_to in ('matching')
    when p_from = 'matching' then p_to in ('offered', 'escalated')
    when p_from = 'offered' then p_to in ('claimed', 'matching')
    when p_from = 'claimed' then p_to in ('escrow_funded')
    when p_from = 'escrow_funded' then p_to in ('in_progress')
    when p_from = 'in_progress' then p_to in ('proof_submitted')
    when p_from = 'proof_submitted' then p_to in ('in_review')
    when p_from = 'in_review' then p_to in ('approved', 'rejected', 'disputed')
    when p_from = 'rejected' then p_to in ('in_progress')
    when p_from = 'disputed' then p_to in ('approved', 'rejected', 'cancelled')
    when p_from = 'approved' then p_to in ('done', 'payout_pending')
    when p_from = 'payout_pending' then p_to in ('paid')
    when p_from = 'paid' then p_to in ('done')
    else false
  end;
$$;

revoke all on function private.task_transition_allowed(public.task_state, public.task_state) from public;
