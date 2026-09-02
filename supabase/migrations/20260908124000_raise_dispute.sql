-- 20260908124000_raise_dispute.sql — somebody says this deal went wrong, and the money stops.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/30-modules/payments-billing.md,
--       docs/30-modules/admin-ops.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, fifth migration, and the producer for the four inbound
-- arcs `20260908120000` restored.
--
-- ---------- This is the freeze, and it is one statement ----------
--
-- There is no freeze flag, no `frozen_at`, no pause row. **Moving the task to
-- `disputed` is the freeze**, because `PAYABLE_TASK_STATES` in
-- `apps/api/src/lib/payout.ts:86` is `('approved', 'payout_pending')` and the
-- sweep's selection stops matching the moment this UPDATE commits. A flag beside
-- the state would be a second thing the sweep has to remember to read, and a
-- freeze that depends on a reader remembering is not a freeze.
--
-- This is also why the task moves **before** the dispute row is inserted rather
-- than after. Both orders are one transaction and neither can half-commit, but
-- the conditional UPDATE is the operation that can legitimately fail — the step
-- may have moved under the caller between the route's read and here — and
-- failing it first means nothing else has been written to unwind.
--
-- ---------- Who may raise, and from where ----------
--
--     owner   escrow_funded, in_progress, payout_pending
--     node    rejected
--
-- The split is not a permission check bolted on; it is the two parties' two
-- different grievances, and each state belongs to exactly one of them:
--
--   * The owner's three are all "I paid for this and something is wrong with how
--     it is going", at the three points where that is still true and the money
--     has not left.
--   * The node's one is the mirror: **the owner rejected work they did**.
--     `rejected` is the only state in this system where a node has been told no
--     by a person, and without this arc their only recourse is to stop
--     responding, which the no-show sweep then correctly reads as their fault and
--     reassigns the step away from them. That is the failure this arc exists to
--     prevent, and it is why the node arm is not "nice to have later".
--
-- Enforced here rather than only in `apps/api/src/lib/task-resolution.ts`, on
-- ADR-0011's two-layer rule: the route checks so a person gets a readable
-- refusal before anything is written, and this checks because it is the layer
-- that binds `service_role` and therefore binds every future caller.
--
-- **`in_review` is legal in the map and absent here.** It is transit-only — the
-- owner's approve/reject walks `proof_submitted -> in_review -> approved|rejected`
-- inside one request — so no step is ever sitting in it for somebody to dispute
-- from. Offering it would be offering a state nobody can catch.
--
-- ---------- What this function deliberately does not do ----------
--
-- **It writes no `ops_actions` row.** Raising a dispute is a party acting on
-- their own deal, not an operator acting on somebody else's, and recording it as
-- an ops action would make the first ops trail in this system start with a
-- customer. `dispute.raised` goes to `events` with the raiser as `actor_id`,
-- which is where a party's act belongs.
--
-- **It touches no money.** The hold stays `held`, the ledger is untouched, and
-- any `payouts` row stays `pending`. Freezing is the absence of movement, and
-- deciding what happens to the money is `resolve_dispute`'s job with a person
-- behind it.

create or replace function public.raise_dispute(
  p_task_id     uuid,
  p_raised_by   uuid,
  p_raised_role text,
  p_reason      text,
  p_evidence    text default null
)
returns uuid
-- **Deliberately NOT `returns null on null input`.** It was, for one revision,
-- and `marketplace_ratings.sql` caught what that does: STRICT means the function
-- returns NULL without executing if *any* argument is null, and `p_evidence`
-- defaults to null — which is the ordinary case. Every dispute raised without
-- an evidence note would have been a silent no-op: no freeze, no row, no error,
-- and a caller handed a null id.
--
-- The required arguments are checked explicitly below instead, which is what a
-- reader of the refusals would expect anyway. Recorded here rather than quietly
-- corrected, because the failure mode was invisible: the route would have
-- returned 200 and the step would have kept moving toward a payout.
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_task       public.tasks;
  v_eng        public.engagements;
  v_open       uuid;
  v_from       public.task_state;
  v_allowed    public.task_state[];
  v_dispute_id uuid;
  v_moved      int;
begin
  -- (1) **Idempotency before validation**, `accept_offer`'s and `settle_payout`'s
  -- ordering. A retried request finds the open dispute this task already has and
  -- returns it, rather than colliding on `disputes_one_open_per_task_idx` and
  -- handing the caller a constraint violation for having asked twice. The
  -- partial index is on the same predicate, so this read and that constraint
  -- cannot disagree about what "open" means.
  -- The arguments STRICT used to cover. Checked before the idempotent read
  -- rather than after it, because a null task id would otherwise make that read
  -- match nothing and fall through to a confusing "step not found".
  if p_task_id is null or p_raised_by is null or p_raised_role is null or p_reason is null then
    raise exception 'a dispute needs a step, a person, a side and a reason'
      using errcode = 'check_violation';
  end if;

  select id into v_open
  from public.disputes
  where task_id = p_task_id and resolved_at is null
  limit 1;
  if v_open is not null then
    return v_open;
  end if;

  if p_raised_role not in ('owner', 'node') then
    raise exception 'a dispute is raised by the owner or by the node, not by %', p_raised_role
      using errcode = 'check_violation';
  end if;

  if length(btrim(p_reason)) = 0 then
    raise exception 'a dispute needs a stated reason'
      using errcode = 'check_violation',
            hint = 'The other party and the operator both have to read what is being alleged.';
  end if;

  select * into v_task from public.tasks where id = p_task_id;
  if not found then
    raise exception 'step % not found', p_task_id using errcode = 'no_data_found';
  end if;
  v_from := v_task.state;

  -- (2) **The live deal.** Not null on `disputes`, and every disputable state is
  -- downstream of an acceptance, so its absence is a real inconsistency rather
  -- than an ordinary refusal.
  select * into v_eng
  from public.engagements
  where task_id = p_task_id and ended_at is null
  limit 1;
  if not found then
    raise exception 'step % has no live engagement, so there is no deal to dispute', p_task_id
      using errcode = 'check_violation',
            hint = 'A step whose deal already ended is disputed through its own record, not this one.';
  end if;

  -- (3) The party's own states. See the header: this is the same list the route
  -- checks, kept here because this is the layer that binds `service_role`.
  v_allowed := case p_raised_role
    when 'owner' then array['escrow_funded', 'in_progress', 'payout_pending']::public.task_state[]
    else array['rejected']::public.task_state[]
  end;

  if not (v_from = any (v_allowed)) then
    raise exception
      'the % cannot dispute a step that is %',
      p_raised_role, v_from
      using errcode = 'check_violation',
            hint = 'The owner disputes work in progress or awaiting payment; the node disputes work that was sent back.';
  end if;

  -- (4) **The freeze, conditionally.** Zero rows means the step moved between the
  -- route's read and here — a sweep may have reassigned it, the owner may have
  -- cancelled it — and a raise unwinds everything, so nothing has been written
  -- about a step that is no longer where the caller thought it was. The
  -- transition guard validates the arc and writes `task.transitioned` itself.
  update public.tasks set state = 'disputed'
  where id = p_task_id and state = v_from;
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'step % moved out of % while the dispute was being raised', p_task_id, v_from
      using errcode = 'check_violation';
  end if;

  -- (5) The grievance. `from_state` records where it was raised from, which
  -- `resolve_dispute` reads to decide whether `rejection_upheld` is meaningful
  -- and which a reader needs, since the task has moved by the time anyone sees
  -- this row.
  insert into public.disputes (
    task_id, engagement_id, project_id, raised_by, raised_role, reason, evidence, from_state
  )
  values (
    p_task_id, v_eng.id, v_task.project_id, p_raised_by, p_raised_role,
    btrim(p_reason), nullif(btrim(coalesce(p_evidence, '')), ''), v_from
  )
  returning id into v_dispute_id;

  -- (6) Written explicitly because a trigger on UPDATE audits no INSERT — the
  -- split `engagements` has, where `engagement.created` is explicit and
  -- `engagement.ended` is the guard's. The actor is the party, not the system:
  -- this is somebody's accusation and the trail should say whose.
  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_task.project_id, p_raised_by, 'user',
    'dispute.raised', 'dispute', v_dispute_id,
    jsonb_build_object(
      'task_id', p_task_id,
      'engagement_id', v_eng.id,
      'node_id', v_eng.node_id,
      'raised_role', p_raised_role,
      'from_state', v_from,
      'agreed_price', v_eng.agreed_price,
      'currency', v_eng.currency
    )
  );

  return v_dispute_id;
end;
$function$;

-- **`service_role` alone**, like every writer in this domain. A client grant
-- would let a party insert a dispute row without moving the task, which is
-- exactly the two-truths defect `20260908122000`'s header refuses: the row and
-- the state have to move together or the freeze is decorative.
-- `security invoker` so the caller's own privileges apply and every guard still
-- binds — the transition trigger included, which is what stops this function
-- routing around the map it depends on.
revoke all on function public.raise_dispute(uuid, uuid, text, text, text) from public;
grant execute on function public.raise_dispute(uuid, uuid, text, text, text) to service_role;

comment on function public.raise_dispute(uuid, uuid, text, text, text) is
  'Freezes a deal and records the grievance, in one transaction. Moving the task to disputed IS '
  'the freeze: PAYABLE_TASK_STATES stops matching it, so there is no separate flag for a sweep '
  'to forget to read. The owner raises from escrow_funded, in_progress or payout_pending; the '
  'node raises from rejected, which is the only state where a person has told them no. Touches '
  'no money - deciding that is resolve_dispute, with an operator behind it.';
