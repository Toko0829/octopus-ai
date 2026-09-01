-- 20260906124000_reassign_engagement.sql — giving a step back to the market when nobody delivered.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/payments-billing.md, docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0023-a-breached-deadline-reassigns.md
--
-- Marketplace slice 6, fifth migration, and the producer for the two arcs
-- `20260906123000` added. One function.
--
-- ---------- Why this is one transaction and the refund sweep is not ----------
--
-- `escrow-reconcile.ts:46-54` accepts a bounded gap between its four steps on
-- the grounds that each is individually idempotent-by-condition and the money
-- figure, which is the one an owner reads, is corrected first. **That reasoning
-- does not transfer here**, because one of the actors in the window is a live
-- human doing work, and every partial state is unsafe in a way a slow correction
-- does not fix:
--
--   * **task moved, hold still `held`** — `accept_offer`'s ceiling check counts
--     the stale hold, so the replacement node is refused for money already
--     spoken for. The step goes back to the market and cannot be taken;
--   * **task moved, engagement still live** — the replacement `accept_offer`
--     collides on `engagements_one_live_idx` and the whole transaction unwinds,
--     **permanently, on every retry**, because nothing later removes the
--     abandoned row;
--   * **hold refunded, task not moved** — the node is still working and their fee
--     is gone;
--   * **engagement ended first** — the sweep's own selection reads live
--     engagements, so a crash after this point makes the step invisible to the
--     thing meant to finish unwinding it.
--
-- So this is `accept_offer`'s shape for `accept_offer`'s stated reason
-- (`20260904125000:16-20`): supabase-js speaks PostgREST and has no transaction,
-- and written in Node this would be six statements that can half-happen.
--
-- ---------- The race with the node, and who wins ----------
--
-- **Step 2 is the whole safety argument.** The task is moved by a conditional
-- UPDATE on the two states a no-show can be in, and **zero rows raises**, which
-- unwinds everything above it. That is not defensive tidiness: a node who
-- submitted their proof in the seconds between the sweep's read and this call has
-- moved the task to `proof_submitted`, and they win. Their work is kept, their
-- escrow is untouched, and the sweep tries nothing further because the next pass
-- reads a state it does not select.
--
-- The alternative, checking the state in the sweep and trusting it here, is the
-- read-then-write race this repository refuses everywhere else.
--
-- ---------- What this does not do ----------
--
-- **Nothing is refunded at a provider, because nothing was ever charged.**
-- `escrow-reconcile.ts:44-50` argues this and it applies unchanged: routing an
-- internal correction through a `provider.refund()` that the only registered
-- implementation would answer trivially would dress it up as money movement, in
-- the one domain where that distinction is the entire regulatory posture.
--
-- **It never touches a step that reached `proof_submitted`, `in_review`,
-- `approved` or `done`.** The map refuses those arcs and the sweep does not
-- select them, which is two guards for one rule on purpose: a deadline passing
-- after the work was handed over is the owner's failure to review.
--
-- **It creates no offer.** The task lands at `matching` and the existing matcher
-- sweep picks it up on a later pass, which is why `cascadeRound` in `match.ts`
-- had to change in the same push: it counted only `offered -> matching`, so a
-- task arriving here from `escrow_funded` would have re-derived a round that
-- already had an offer, collided, read back the **no-show's accepted offer**, and
-- dispatched a third node against it.

create or replace function public.reassign_engagement(p_engagement_id uuid)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_eng        public.engagements;
  v_task_state public.task_state;
  v_hold       public.escrow_holds;
  v_thread     uuid;
  v_moved      int;
begin
  -- (1) **Idempotency before validation**, the `accept_offer:123-131` ordering.
  -- A replay of a pass that committed and then died before its log line finds
  -- the engagement already ended and returns it rather than re-deciding.
  select * into v_eng from public.engagements where id = p_engagement_id;
  if not found then
    raise exception 'engagement % not found', p_engagement_id using errcode = 'no_data_found';
  end if;
  if v_eng.ended_at is not null then
    return v_eng.id;
  end if;

  -- (2) **The task, conditionally, and a raise unwinds everything.** The two
  -- states a no-show can be in and no others. If the node handed over in the
  -- window between the sweep's read and here, this matches zero rows and the
  -- whole transaction is abandoned: they delivered, so they win.
  update public.tasks set state = 'matching'
  where id = v_eng.task_id and state in ('escrow_funded', 'in_progress');
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    select state into v_task_state from public.tasks where id = v_eng.task_id;
    raise exception
      'step % is %, so it is not an abandoned one and will not be reassigned',
      v_eng.task_id, coalesce(v_task_state::text, 'missing')
      using errcode = 'check_violation',
            hint = 'The node may have handed the work over, or the owner may have taken the step back.';
  end if;

  -- (3) **The hold, through the guard**, which writes `escrow.transitioned`
  -- itself. Conditional on `held` for the same reason: a hold already refunded by
  -- the reconcile sweep is not one to refund twice.
  select * into v_hold from public.escrow_holds
  where task_id = v_eng.task_id and state = 'held'
  limit 1;

  if found then
    update public.escrow_holds set state = 'refunded'
    where id = v_hold.id and state = 'held';
    get diagnostics v_moved = row_count;
    if v_moved = 0 then
      raise exception 'escrow hold % stopped being held while it was being refunded', v_hold.id
        using errcode = 'check_violation';
    end if;

    -- (4) The reversing pair, mirroring `escrowRefundPair` in packages/payments
    -- and **sharing the hold's `ref_id`**, so the four entries about this hold
    -- sum to zero on every account and "settled" is a fact a reader derives
    -- rather than a column they trust. Both halves are pinned by suites, on
    -- ADR-0011's terms, because this arithmetic now exists in two languages.
    insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
    values
      ('escrow',      v_hold.amount, 0, v_hold.currency, 'escrow_hold', v_hold.id),
      ('owner_funds', 0, v_hold.amount, v_hold.currency, 'escrow_hold', v_hold.id);
  end if;

  -- (5) **The deal ends, through the write-once guard**, which writes
  -- `engagement.ended` itself. `'reassigned'` gets its first producer here: the
  -- value has been in the check constraint since `20260904120000` meaning exactly
  -- this, and `engagements_one_live_idx` is partial specifically so the next
  -- acceptance can create a second row on the same task.
  update public.engagements
  set ended_at = now(), outcome = 'reassigned'
  where id = v_eng.id and ended_at is null;
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'engagement % ended while it was being reassigned', v_eng.id
      using errcode = 'check_violation';
  end if;

  -- (6) **Thread access ends with the work.** Stamped rather than deleted, so the
  -- roster still records that this person was here, which is what a dispute
  -- reads. Scoped to this task's thread and this node: a node can hold thread
  -- memberships in other rooms for other steps, and a revocation keyed on the
  -- person alone would cut them out of work that is still running. Conditional on
  -- `expires_at is null` so a replay cannot move a revocation time.
  select id into v_thread from public.threads where task_id = v_eng.task_id;
  if v_thread is not null then
    update public.room_members
    set expires_at = now()
    where user_id = v_eng.node_id
      and thread_id = v_thread
      and expires_at is null;
  end if;

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_eng.project_id, null, 'system',
    'engagement.reassigned', 'engagement', v_eng.id,
    jsonb_build_object(
      'task_id', v_eng.task_id,
      'node_id', v_eng.node_id,
      'deadline_at', v_eng.deadline_at,
      'agreed_price', v_eng.agreed_price,
      'currency', v_eng.currency,
      'hold_id', v_hold.id,
      'thread_id', v_thread
    )
  );

  return v_eng.id;
end;
$function$;

-- **`service_role` alone**, like `accept_offer`. There is no owner-facing and no
-- node-facing route onto this: a reassignment is a clock's decision, made by the
-- sweep, and giving either party a button would let one of them end the other's
-- deal. `security invoker` matches `accept_offer`, so the caller's own privileges
-- apply and the transition guard still binds it.
revoke all on function public.reassign_engagement(uuid) from public;
grant execute on function public.reassign_engagement(uuid) to service_role;

comment on function public.reassign_engagement(uuid) is
  'Ends an abandoned engagement and returns its step to the market, in one transaction: task '
  'to matching (conditionally, so a node who handed over in the window wins), hold to refunded '
  'with its reversing ledger pair, engagement ended as reassigned, thread access revoked. The '
  'only producer of escrow_funded -> matching and in_progress -> matching, and the first '
  'producer of engagements.outcome = ''reassigned''. Nothing is charged or refunded at a '
  'provider, because nothing was ever charged.';
