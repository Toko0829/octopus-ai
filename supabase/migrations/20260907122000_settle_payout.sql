-- 20260907122000_settle_payout.sql — the transfer answered, so everything else
-- settles at once.
-- Owner doc: docs/30-modules/payments-billing.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/10-architecture/data-model.md,
--       docs/40-adr/0013-approving-a-campaign-publishes-it.md,
--       docs/40-adr/0020-the-ceiling-has-two-committer-classes.md,
--       docs/40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md
--
-- **This is `held -> released`'s producer**, which is what let `20260907120000`
-- permit the arc. Still nothing is charged and nothing is transferred: the
-- transfer this function records was made by the in-repo fake, and
-- `apps/api/src/lib/payout.ts` refuses a provider whose `carriesRealMoney` is
-- true before ever reaching here. **The counsel gate in payments-billing.md is
-- unmoved.**
--
-- ---------- Why one transaction ----------
--
-- `reassign_engagement`'s argument, with a different actor in the window. There
-- no-show reasoning turned on a live human still working; here it turns on the
-- ceiling and on the audit trail, and **every partial state is a money defect
-- somebody would have to reconcile by hand**:
--
--   * a released hold under a live engagement is money that left escrow for a
--     deal the database still says is running;
--   * a released hold with no ledger pair is a hold whose four entries no longer
--     sum to zero, which is the one property that makes "settled" derivable
--     rather than a column to trust;
--   * a `done` task whose hold is still `held` pins part of
--     `projects.budget_ceiling` forever against work that finished
--     ([ADR-0020](../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)),
--     which is the exact defect the reconcile sweep was written to prevent for
--     cancelled steps;
--   * a paid payout whose engagement never reached `'completed'` leaves
--     `node_profiles.completed_engagements` short, and that number is what slice
--     8 ranks and rates on.
--
-- The reconcile sweep can be four condition-idempotent steps because the worst
-- partial state there is a delay in a figure. Here it is not.
--
-- ---------- What is deliberately NOT in this function ----------
--
-- **The transfer.** It happened before this was called, which is
-- [ADR-0013](../../docs/40-adr/0013-approving-a-campaign-publishes-it.md)'s
-- ordering rather than ADR-0014's: a transfer **creates** something at a
-- provider under an id the provider mints, so the intent is recorded first (the
-- `payouts` row, at `pending`, under a key derived from the engagement) and the
-- call is made against it. Postgres has no transaction across somebody else's
-- API, and a record of an uncertain request is recoverable where an unrecorded
-- certain one is not.
--
-- **Thread revocation.** Slice 6's approval path already did it
-- (`apps/api/src/lib/proof.ts:revokeThreadAccess`), at the moment the owner said
-- the work was finished. Doing it again here would be a second writer for one
-- fact, and the one that runs later would be moving a revocation time a dispute
-- may read.
--
-- ---------- The task walk, and why it ends at `done` ----------
--
-- `payout_pending -> paid -> done`, two hops, each firing the transition guard so
-- each writes its own `task.transitioned` row. `paid` is transit-only exactly as
-- `in_review` is in the approve route: nobody looks at a step in it.
--
-- **`done` gets its first producer here, and it is the human arm only.** Nothing
-- in this system had ever reached `done`; `private.task_state_is_terminal` is
-- `('done','failed','cancelled')`, so a step stopping at `paid` would be
-- non-terminal forever and still cancellable — a kill switch could cancel work
-- that was finished and paid for. An **AI** step still stops at `approved` and is
-- still non-terminal, which is the same defect one arm over and is **not** closed
-- here: `approved -> done` on an AI step is business-projects-workflow.md's to
-- produce, it involves no money, and closing somebody else's arc from a
-- marketplace slice is how a repository ends up with two half-owners of one
-- machine. It is written down in that module doc rather than left for the next
-- reader to notice.

create or replace function public.settle_payout(p_payout_id uuid, p_transfer_id text)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_payout     public.payouts;
  v_eng        public.engagements;
  v_hold       public.escrow_holds;
  v_task_state public.task_state;
  v_moved      int;
begin
  -- (1) **Idempotency before validation**, `reassign_engagement`'s and
  -- `accept_offer`'s ordering. A replay of a pass that committed and then died
  -- before its log line finds the payout already `paid` and returns it rather
  -- than re-deciding. This is the fourth of the sweep's four crash points and
  -- the only one that could otherwise double-write.
  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout % not found', p_payout_id using errcode = 'no_data_found';
  end if;
  if v_payout.state = 'paid' then
    return v_payout.id;
  end if;

  if p_transfer_id is null or length(trim(p_transfer_id)) = 0 then
    raise exception 'payout % cannot be settled without a transfer reference', v_payout.id
      using errcode = 'check_violation',
            hint = 'The provider''s reference is what makes a settlement provable.';
  end if;

  -- (2) **The payout itself, first**, so the provider's reference is durable
  -- before anything else moves. Both guards fire: write-once stamps
  -- `updated_at` and refuses a second reference, the transition guard validates
  -- `pending -> paid` and writes `payout.transitioned`.
  update public.payouts
  set transfer_id = p_transfer_id, state = 'paid'
  where id = v_payout.id and state = 'pending';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'payout % stopped being pending while it was being settled', v_payout.id
      using errcode = 'check_violation';
  end if;

  -- (3) **The hold, through the guard**, which writes `escrow.transitioned`
  -- itself. Conditional on `held`, and **a raise unwinds everything**: a hold
  -- that is already `refunded` means the no-show sweep or the reconcile sweep
  -- reached this step first, and paying against money that has gone back to the
  -- owner would be spending their ceiling twice.
  select * into v_hold from public.escrow_holds
  where task_id = v_payout.task_id and state = 'held'
  limit 1;
  if not found then
    raise exception
      'step % has no held escrow, so there is nothing to release for payout %',
      v_payout.task_id, v_payout.id
      using errcode = 'check_violation',
            hint = 'The hold may have been refunded by the reconcile or no-show sweep.';
  end if;

  update public.escrow_holds set state = 'released'
  where id = v_hold.id and state = 'held';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'escrow hold % stopped being held while it was being released', v_hold.id
      using errcode = 'check_violation';
  end if;

  -- (4) The release pair, mirroring `escrowReleasePair` in packages/payments and
  -- **sharing the hold's `ref_id` rather than the payout's**, so the four entries
  -- about this hold sum to zero on every account whichever way it settled, and
  -- "this hold is finished" stays a fact a reader derives. `node_payable` gets
  -- its first entry here; nothing debits it in this build, and packages/payments
  -- says why that is a decision rather than an omission.
  --
  -- **The amount is the hold's**, not the payout's, because this pair is about
  -- the hold. They are equal in this build (the fee is zero, ADR-0024); reading
  -- the hold is what keeps that an equality rather than an assumption.
  insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
  values
    ('escrow',       v_hold.amount, 0, v_hold.currency, 'escrow_hold', v_hold.id),
    ('node_payable', 0, v_hold.amount, v_hold.currency, 'escrow_hold', v_hold.id);

  -- (5) **The deal ends, through the write-once guard**, which writes
  -- `engagement.ended` itself. `'completed'` gets its first producer here — the
  -- value has been in the check constraint since `20260904120000` meaning exactly
  -- this, and slice 6 deliberately left it unwritten on approval so the owner
  -- could still read who did the work while they were about to pay them.
  -- `20260907123000` is what keeps that readable now that the deal is ending.
  select * into v_eng from public.engagements where id = v_payout.engagement_id;
  if not found then
    raise exception 'payout % names engagement %, which does not exist',
      v_payout.id, v_payout.engagement_id
      using errcode = 'no_data_found';
  end if;

  update public.engagements
  set ended_at = now(), outcome = 'completed'
  where id = v_eng.id and ended_at is null;
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'engagement % ended before its payout settled', v_eng.id
      using errcode = 'check_violation',
            hint = 'A reassigned or cancelled deal is not one to pay.';
  end if;

  -- (6) **`completed_engagements` gets its first writer** since the column landed
  -- in `20260831120000` with a default of zero. `matching.ts` records that it is
  -- zero on every row and that ranking on it would be arithmetic pretending to be
  -- a ranking; slice 8's trust score reads it, and this is where it stops being
  -- constant. Incremented in the same transaction as the outcome it counts, so
  -- the two can never disagree.
  update public.node_profiles
  set completed_engagements = completed_engagements + 1, updated_at = now()
  where user_id = v_eng.node_id;

  -- (7) **The step, two hops.** Conditional from `payout_pending`, and a raise
  -- unwinds everything: if the owner cancelled the step in the window between the
  -- sweep's read and here, the money must not move. Each hop fires the transition
  -- guard and writes its own `task.transitioned`.
  update public.tasks set state = 'paid'
  where id = v_payout.task_id and state = 'payout_pending';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    select state into v_task_state from public.tasks where id = v_payout.task_id;
    raise exception
      'step % is %, so it is not awaiting payment',
      v_payout.task_id, coalesce(v_task_state::text, 'missing')
      using errcode = 'check_violation',
            hint = 'The step may have been cancelled while the transfer was in flight.';
  end if;

  update public.tasks set state = 'done'
  where id = v_payout.task_id and state = 'paid';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'step % left paid before it could be finished', v_payout.task_id
      using errcode = 'check_violation';
  end if;

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_payout.project_id, null, 'system',
    'payout.settled', 'payout', v_payout.id,
    jsonb_build_object(
      'task_id', v_payout.task_id,
      'node_id', v_payout.node_id,
      'engagement_id', v_eng.id,
      'hold_id', v_hold.id,
      'amount', v_payout.amount,
      'platform_fee', v_payout.platform_fee,
      'currency', v_payout.currency,
      'transfer_id', p_transfer_id
    )
  );

  return v_payout.id;
end;
$function$;

-- **`service_role` alone**, like `accept_offer` and `reassign_engagement`. There
-- is no owner-facing and no node-facing route onto this: approving the work is
-- the authorisation ([ADR-0013](../../docs/40-adr/0013-approving-a-campaign-publishes-it.md)'s
-- argument, and payments-billing.md's money flow already specifies that approval
-- triggers the transfer), and a node with a button here could pay themselves.
-- `security invoker` matches both, so the caller's own privileges apply and every
-- guard still binds it.
revoke all on function public.settle_payout(uuid, text) from public;
grant execute on function public.settle_payout(uuid, text) to service_role;

comment on function public.settle_payout(uuid, text) is
  'Settles one payout in one transaction: payout to paid with its transfer reference, hold to '
  'released with its ledger pair, engagement ended as completed, completed_engagements '
  'incremented, task payout_pending -> paid -> done. The only producer of held -> released, of '
  'engagements.outcome = ''completed'', and of tasks.done. The transfer happened BEFORE this was '
  'called (ADR-0013 ordering) and was made by the in-repo fake; nothing is transferred.';
