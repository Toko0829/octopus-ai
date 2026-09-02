-- 20260908125000_resolve_dispute.sql — an operator decides, and every consequence lands together.
-- Owner doc: docs/30-modules/admin-ops.md
-- Also: docs/30-modules/payments-billing.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, sixth migration. The producer for `disputed -> matching`
-- (`20260908120000`), for `payouts pending -> failed` (`20260908121000`), and the
-- second producer of `engagements.outcome = 'disputed_resolved'`'s value, which
-- has been in the check constraint since `20260904120000` with nothing able to
-- write it.
--
-- ---------- One transaction, on ADR-0023's argument ----------
--
-- `reassign_engagement` states it and it binds harder here: "one of the actors in
-- this window is a live human doing work, and every partial state is unsafe."
-- Every intermediate here is a money defect somebody reconciles by hand — a
-- refunded hold under a live engagement, a released hold with no ledger pair, a
-- resolved dispute over a task still sitting in `disputed`, a `pending` payout
-- against money that went back to the owner. So it is one function, and any raise
-- unwinds all of it.
--
-- ---------- The five resolutions ----------
--
--   released           task -> approved      deal stays live   sweep pays, as normal
--   refunded           task -> cancelled     ends              hold -> refunded, full
--   partial            task -> cancelled     ends              hold -> refunded, then a NEW hold released
--   reassigned         task -> matching      ends              hold -> refunded, market re-offers
--   rejection_upheld   task -> rejected      stays live        nothing moves
--
-- **`released` moves no money here, and that is the elegant half.** The freeze
-- was the task leaving `PAYABLE_TASK_STATES`; un-freezing is putting it back.
-- The engagement stays live, the hold stays `held`, and the next payout sweep
-- picks the step up exactly as it would have. If a `payouts` row already exists
-- from the pass the dispute interrupted, `payoutKey(engagement_id)` collides,
-- the sweep reads its own row back and settles it — the recovery path that was
-- already built for a crash, reused for a freeze. A second money path here would
-- be a second way to pay somebody.
--
-- **`rejection_upheld` moves nothing at all.** The owner's rejection stands, the
-- step returns to `rejected`, and the node re-does the work through
-- `rejected -> in_progress`, which has existed since the map was written. This is
-- why `disputed -> in_progress` stays dropped
-- ([ADR-0026](../../docs/40-adr/0026-the-dispute-exit-map.md)): the same
-- destination through the state that records what was decided.
--
-- **`refunded` and `partial` land the task at `cancelled`.** Terminal, and an
-- existing arc. An owner who got their money back and still wants the work has
-- `reassigned`, which is the resolution built for exactly that; making `refunded`
-- also mean "and try again" would collapse two decisions an operator has to be
-- able to make separately.
--
-- ---------- The partial, and why it is a refund plus a new hold ----------
--
-- `20260907120000:44-49` decided this before there was anything to decide it for:
-- `held -> released` and `held -> refunded` are both terminal with **no arc
-- between them**, and "taking back money somebody earned, or paying twice for
-- work that was cancelled, would each require a *new* hold with its own key and
-- its own reason, **and that is what a dispute is (slice 8)**." This is that
-- sentence being cashed.
--
-- So a partial does not split the original hold, because a terminal row cannot be
-- edited and a half-refunded state does not exist. It:
--
--   1. refunds the original hold **in full**, with the full reversing pair;
--   2. inserts a **new hold** for the node's share, keyed
--      `dispute-release:<dispute_id>`, with its own hold pair;
--   3. immediately releases that new hold, with its own release pair.
--
-- Six ledger entries across two `ref_id`s, each hold summing to zero, and the
-- net across both is exactly `owner_funds -release, node_payable +release`. Every
-- entry is constructed from the pairs `packages/payments/src/ledger.ts` exports
-- — no new pair function exists or is needed, which is the point:
-- [ADR-0025](../../docs/40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md)
-- records that a partial is a **composition** of settlements this system already
-- knows how to make, not a new kind of settlement.
--
-- **ADR-0020's four committed-budget computations need no change**, and this is
-- why: all four count `escrow_holds` at `state = 'held'`, and the new hold is
-- inserted and released inside this transaction, so **nothing outside it ever
-- observes a second `held` row**. The committed sum is correct before, correct
-- after, and never wrong in between. Verified rather than assumed:
-- `checkSpendCap` (packages/marketing/src/spend.ts), `readSpendInputs`
-- (apps/api/src/lib/spend-reads.ts), and the SQL sums in `accept_offer` and
-- `materialise_campaign`.
--
-- **The new hold carries the original's `charge_id`.** It is the same money from
-- the same nominal charge; minting a second charge reference would claim a second
-- charge happened, and nothing was charged at all
-- (`carriesRealMoney` still refuses every provider but the fake, checked in the
-- route before this is called). The `idempotency_key` is what distinguishes the
-- two rows, and it is derived from the dispute id so a re-disputed task derives a
-- different one.
--
-- ---------- The orphaned payout ----------
--
-- A dispute raised from `payout_pending` can catch a step whose `payouts` row was
-- already written at `pending` — the sweep writes it before the transfer, on
-- ADR-0013's ordering. On any resolution but `released`, the hold underneath that
-- row is refunded and the engagement ends, so nothing will ever select it again
-- and it becomes a record of money owed that will never be sent. It is moved to
-- `failed` here, in the same transaction as the refund, so the two records cannot
-- disagree. `20260908121000` is the arc; this is its only producer.

create or replace function public.resolve_dispute(
  p_dispute_id     uuid,
  p_actor_id       uuid,
  p_resolution     text,
  p_reason         text,
  p_release_amount numeric default null
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_dispute    public.disputes;
  v_eng        public.engagements;
  v_hold       public.escrow_holds;
  v_new_hold   uuid;
  v_payout     public.payouts;
  v_thread     uuid;
  v_task_state public.task_state;
  v_target     public.task_state;
  v_outcome    text;
  v_release    numeric(12, 2);
  v_refund     numeric(12, 2);
  v_moved      int;
begin
  -- (1) **Idempotency before validation**, this domain's ordering in all four
  -- writers. A retried request finds the dispute resolved and returns it rather
  -- than re-deciding — and re-deciding is the one thing that must not happen
  -- here, because the second decision would move money against a hold the first
  -- already settled.
  select * into v_dispute from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'dispute % not found', p_dispute_id using errcode = 'no_data_found';
  end if;
  if v_dispute.resolved_at is not null then
    return v_dispute.id;
  end if;

  if p_actor_id is null then
    raise exception 'a dispute resolution has to name the operator who made it'
      using errcode = 'check_violation',
            hint = 'ops_actions.actor_id is not null: an unattributable decision is not recorded.';
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'a dispute resolution has to say why'
      using errcode = 'check_violation',
            hint = 'admin-ops.md: no destructive action without a trail.';
  end if;

  if p_resolution not in ('released', 'refunded', 'partial', 'reassigned', 'rejection_upheld') then
    raise exception 'unknown dispute resolution %', p_resolution
      using errcode = 'check_violation';
  end if;

  -- (2) `rejection_upheld` is an answer to a specific grievance and is
  -- meaningless about any other. `from_state` is on the row for this check.
  if p_resolution = 'rejection_upheld' and v_dispute.from_state <> 'rejected' then
    raise exception
      'this dispute was raised from %, so there is no rejection to uphold',
      v_dispute.from_state
      using errcode = 'check_violation',
            hint = 'Upholding a rejection answers a node disputing work the owner sent back.';
  end if;

  select * into v_eng from public.engagements where id = v_dispute.engagement_id;
  if not found then
    raise exception 'dispute % names engagement %, which does not exist',
      v_dispute.id, v_dispute.engagement_id
      using errcode = 'no_data_found';
  end if;

  -- (3) **The hold, read before anything moves**, because the partial's
  -- arithmetic is checked against it. Required for the three resolutions that
  -- move money; `released` and `rejection_upheld` leave it exactly where it is.
  select * into v_hold from public.escrow_holds
  where task_id = v_dispute.task_id and state = 'held'
  limit 1;

  if p_resolution in ('refunded', 'partial', 'reassigned') and not found then
    raise exception
      'step % has no held escrow, so there is nothing to settle for dispute %',
      v_dispute.task_id, v_dispute.id
      using errcode = 'check_violation',
            hint = 'The hold may already have been refunded by the reconcile or no-show sweep.';
  end if;

  -- (4) The partial's split. **Read from the hold, never from `agreed_price`**
  -- (ADR-0024): they are equal in this build because the fee is zero, and
  -- reading the hold is what keeps that an equality rather than an assumption.
  -- Both bounds are strict: a partial of the whole amount is `released` and a
  -- partial of nothing is `refunded`, and letting either be spelled as a partial
  -- would put two names on one outcome.
  if p_resolution = 'partial' then
    if p_release_amount is null then
      raise exception 'a partial settlement has to say how much the node keeps'
        using errcode = 'check_violation';
    end if;
    v_release := round(p_release_amount, 2);
    if v_release <= 0 or v_release >= v_hold.amount then
      raise exception
        'a partial settlement of % has to be between 0 and the held amount %, exclusive',
        v_release, v_hold.amount
        using errcode = 'check_violation',
              hint = 'Paying all of it is released; paying none of it is refunded.';
    end if;
    v_refund := v_hold.amount - v_release;
  elsif p_resolution = 'refunded' then
    v_refund := v_hold.amount;
  elsif p_release_amount is not null then
    raise exception 'an amount is only meaningful on a partial settlement, not on %', p_resolution
      using errcode = 'check_violation';
  end if;

  v_target := case p_resolution
    when 'released'         then 'approved'
    when 'reassigned'       then 'matching'
    when 'rejection_upheld' then 'rejected'
    else 'cancelled'
  end::public.task_state;

  -- Only the three that settle the hold end the deal. `released` keeps it live so
  -- the payout sweep can finish it; `rejection_upheld` keeps it live because the
  -- node is about to re-do the work under the same agreement.
  v_outcome := case
    when p_resolution in ('refunded', 'partial', 'reassigned') then 'disputed_resolved'
    else null
  end;

  -- (5) **The step first, conditionally**, `settle_payout`'s and
  -- `reassign_engagement`'s ordering: the operation that can legitimately lose a
  -- race goes first, so a raise unwinds a transaction that has written nothing.
  -- The transition guard validates the arc and writes `task.transitioned`.
  update public.tasks set state = v_target
  where id = v_dispute.task_id and state = 'disputed';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    select state into v_task_state from public.tasks where id = v_dispute.task_id;
    raise exception
      'step % is %, so it is not under dispute',
      v_dispute.task_id, coalesce(v_task_state::text, 'missing')
      using errcode = 'check_violation',
            hint = 'The step may have been cancelled while the dispute was open.';
  end if;

  -- (6) The money. Nothing at all on `released` and `rejection_upheld`.
  if p_resolution in ('refunded', 'partial', 'reassigned') then
    update public.escrow_holds set state = 'refunded'
    where id = v_hold.id and state = 'held';
    get diagnostics v_moved = row_count;
    if v_moved = 0 then
      raise exception 'escrow hold % stopped being held while the dispute was being resolved', v_hold.id
        using errcode = 'check_violation';
    end if;

    -- The reversing pair for the whole hold, mirroring `escrowRefundPair` and
    -- sharing the hold's `ref_id`, so the four entries about it sum to zero.
    insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
    values
      ('escrow',      v_hold.amount, 0, v_hold.currency, 'escrow_hold', v_hold.id),
      ('owner_funds', 0, v_hold.amount, v_hold.currency, 'escrow_hold', v_hold.id);

    -- The node's share, as a new hold that is created and settled inside this
    -- transaction. See the header and ADR-0025: nothing outside this transaction
    -- ever sees a second `held` row, which is why the committed-budget sum is
    -- untouched everywhere it is computed.
    if p_resolution = 'partial' then
      insert into public.escrow_holds
        (task_id, project_id, charge_id, amount, currency, state, idempotency_key)
      values (
        v_hold.task_id, v_hold.project_id, v_hold.charge_id, v_release, v_hold.currency,
        'held', 'dispute-release:' || v_dispute.id
      )
      returning id into v_new_hold;

      insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
      values
        ('owner_funds', v_release, 0, v_hold.currency, 'escrow_hold', v_new_hold),
        ('escrow',      0, v_release, v_hold.currency, 'escrow_hold', v_new_hold);

      update public.escrow_holds set state = 'released'
      where id = v_new_hold and state = 'held';
      get diagnostics v_moved = row_count;
      if v_moved = 0 then
        raise exception 'the partial settlement hold % could not be released', v_new_hold
          using errcode = 'check_violation';
      end if;

      insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
      values
        ('escrow',       v_release, 0, v_hold.currency, 'escrow_hold', v_new_hold),
        ('node_payable', 0, v_release, v_hold.currency, 'escrow_hold', v_new_hold);
    end if;
  end if;

  -- (7) The deal ends, through the write-once guard, which writes
  -- `engagement.ended`. `'disputed_resolved'` gets its first producer here.
  if v_outcome is not null then
    update public.engagements
    set ended_at = now(), outcome = v_outcome
    where id = v_eng.id and ended_at is null;
    get diagnostics v_moved = row_count;
    if v_moved = 0 then
      raise exception 'engagement % ended while its dispute was being resolved', v_eng.id
        using errcode = 'check_violation';
    end if;

    -- (8) **Thread access ends with the work**, `reassign_engagement`'s idiom:
    -- stamped rather than deleted, so the roster still records that this person
    -- was here — which is what the next dispute reads. Scoped to this task's
    -- thread and this node, and conditional on `expires_at is null` so a replay
    -- cannot move a revocation time.
    select id into v_thread from public.threads where task_id = v_dispute.task_id;
    if v_thread is not null then
      update public.room_members
      set expires_at = now()
      where user_id = v_eng.node_id
        and thread_id = v_thread
        and expires_at is null;
    end if;

    -- (9) The orphaned payout. See the header: on any resolution but `released`
    -- the hold underneath a recorded `pending` payout has just been refunded, so
    -- the row would otherwise claim money is owed that nothing will ever send.
    select * into v_payout from public.payouts
    where engagement_id = v_eng.id and state = 'pending'
    limit 1;
    if found then
      update public.payouts set state = 'failed'
      where id = v_payout.id and state = 'pending';
    end if;
  end if;

  -- (10) The decision, through the write-once guard, which writes
  -- `dispute.resolved`. All four resolution columns move together or the
  -- all-or-none constraint refuses the row.
  update public.disputes
  set resolution      = p_resolution,
      release_amount  = v_release,
      refund_amount   = v_refund,
      resolution_note = btrim(p_reason),
      resolved_by     = p_actor_id,
      resolved_at     = now()
  where id = v_dispute.id and resolved_at is null;
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'dispute % was resolved while it was being resolved', v_dispute.id
      using errcode = 'check_violation';
  end if;

  -- (11) **The ops trail, inside the transaction**, which is what makes it
  -- impossible to forget: a resolution that could not be attributed or explained
  -- fails at the `not null` and takes the money with it. This is the reason the
  -- table exists rather than a verb in `events` — see `20260908123000`'s header.
  insert into public.ops_actions (actor_id, action, subject_type, subject_id, reason, payload)
  values (
    p_actor_id, 'dispute.resolve', 'dispute', v_dispute.id, btrim(p_reason),
    jsonb_build_object(
      'task_id', v_dispute.task_id,
      'engagement_id', v_eng.id,
      'node_id', v_eng.node_id,
      'project_id', v_dispute.project_id,
      'raised_role', v_dispute.raised_role,
      'from_state', v_dispute.from_state,
      'resolution', p_resolution,
      'task_to', v_target,
      'engagement_outcome', v_outcome,
      'hold_id', v_hold.id,
      'hold_amount', v_hold.amount,
      'release_amount', v_release,
      'refund_amount', v_refund,
      'release_hold_id', v_new_hold,
      'failed_payout_id', v_payout.id,
      'currency', coalesce(v_hold.currency, v_eng.currency)
    )
  );

  return v_dispute.id;
end;
$function$;

-- **`service_role` alone**, like every writer in this domain. The operator check
-- is `apps/api/src/plugins/require-ops.ts`, reading `profiles.role` from the
-- database rather than from the JWT — the claim does not carry it, verified in
-- auth-identity.md. No role predicate lives inside this function, on this
-- domain's standing pattern: authorization is the API layer plus the grant, and
-- the database expresses it as "no client grant" rather than as a test a
-- SECURITY DEFINER helper would have to publish at `/rest/v1/rpc/`.
revoke all on function public.resolve_dispute(uuid, uuid, text, text, numeric) from public;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, numeric) to service_role;

comment on function public.resolve_dispute(uuid, uuid, text, text, numeric) is
  'An operator decides a dispute and every consequence lands in one transaction: the task arc, '
  'the escrow settlement, the engagement outcome, the thread roster, any orphaned payout, the '
  'decision, and the ops trail. released moves no money - it returns the task to approved and '
  'the existing payout sweep finishes it. partial is a full refund plus a new hold released '
  'inside this transaction (ADR-0025), because both escrow settlements are terminal and neither '
  'reaches the other. The reason is required and is written to ops_actions with the operator.';
