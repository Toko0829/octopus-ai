-- 20260827120000_owner_takes_escalated_step.sql — an escalated step had nowhere to go.
--
-- `ESCALATED` means "this needs an expert rather than the AI", and the only arc
-- out of it was `MATCHING`, the first state of a marketplace that does not exist.
-- So every step the router sent there was **permanently stuck**, and the two
-- other exits the machine offers, `CANCELLED` and `BLOCKED`, both say the work
-- will not happen rather than that somebody else will do it.
--
-- Measured on the live database: **17 escalated steps across four projects**,
-- twelve of them routed there by rule 3 (the plan gave the work to a human) and
-- five escalated by the executor refusing to produce ungrounded output. None of
-- them could move, by anybody, ever.
--
-- That was survivable while nothing showed it. `ProjectPanel` now lists every
-- step with its state, so a person reads "Needs an expert" beside work they are
-- perfectly capable of doing themselves and has no way to act on it. Making
-- something visible and leaving it dead is worse than not showing it.
--
-- Two arcs, and they are the ones `NEEDS_USER` already has (`20260815220000`).
-- The argument transfers exactly:
--
-- **`ESCALATED -> APPROVED`, because the owner doing it is doing it.** That
-- migration's reasoning was that the plan gave the person work only they could
-- do, so answering IS the step rather than merely unblocking it, and `APPROVED`
-- is the state that satisfies dependents. Here the plan gave the work to an
-- expert who cannot be brought in. The owner taking it on is the same act, and
-- their write-up is the deliverable, stored as an artifact `created_by: 'user'`
-- with no citations for the same reason: a person's own work rests on no
-- retrieved source, and attaching one would attribute their judgement to the
-- corpus.
--
-- **`ESCALATED -> ROUTING`, because some escalations are worth retrying.** The
-- five executor refusals failed for want of grounding, and `POST /sources` exists
-- precisely so somebody can supply what the corpus lacks. Without this arc that
-- loop is a dead end even when the missing piece is one paste away. Retrying
-- without changing anything is still pointless, which is a fact about the corpus
-- rather than about the machine, so the arc exists and the copy says what makes a
-- retry worth taking.
--
-- **This is not the marketplace and must not be dressed up as one.** It gives the
-- owner a way to unstick their own project. `MATCHING` stays exactly where it is
-- for when the matcher lands, and nothing here presumes what it will do.
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
    -- 'matching' hands it to the marketplace when one exists. 'approved' is the
    -- owner doing it themselves. 'routing' is another attempt, worth taking when
    -- something has changed, such as a source that was missing.
    when p_from = 'escalated' then p_to in ('matching', 'approved', 'routing')
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
