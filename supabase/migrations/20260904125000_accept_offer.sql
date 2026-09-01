-- 20260904125000_accept_offer.sql — a node takes the work, and the money is
-- modelled, in one transaction.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/10-architecture/data-model.md, docs/30-modules/payments-billing.md,
--       docs/30-modules/chat-discord.md,
--       docs/40-adr/0011-spend-cap-checked-twice.md,
--       docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md,
--       docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md,
--       docs/40-adr/0019-claimed-to-matching-stays-dropped.md,
--       docs/40-adr/0020-the-ceiling-has-two-committer-classes.md
--
-- The fifth writer of `materialise_campaign`'s kind, and it shares the four
-- properties that file lists, each of them load-bearing here for a sharper reason
-- because this one commits money:
--
--   1. **One transaction.** supabase-js speaks PostgREST and has none. Written in
--      Node this would be nine statements that can half-happen, and the half that
--      matters is "the offer says accepted, the task says claimed, and no escrow
--      hold exists" — a node holding work nobody funded, which is the exact
--      outcome the whole slice boundary was drawn to prevent.
--   2. **The payload is read from the rows**, never taken as arguments. The only
--      arguments are the offer to accept and the provider's charge reference. The
--      price is read from `node_profiles`, the ceiling from `projects`; a caller
--      cannot name either.
--   3. **Idempotent by its own provenance.** `engagements.offer_id` is unique and
--      was declared for exactly this. A retry after a failed commit returns the
--      same engagement instead of a second one.
--   4. **Unknown or unusable values raise.** A missing rate, an hourly rate, a
--      null ceiling, a currency mismatch, a room with no channel: each raises
--      with a sentence naming what it found, because guessing on any of them
--      writes an unauthorised figure to a table whose whole meaning is
--      authorisation.
--
-- ---------- Why `claimed` is transit-only, and what that decides ----------
--
-- The task moves `offered -> claimed -> escrow_funded` inside this function, as
-- two conditional UPDATEs. Both arcs have existed in
-- `private.task_transition_allowed` since `20260813120000` with no producer at
-- all. They gain one here, together, because `claimed -> escrow_funded` is the
-- machine's ONLY exit from `claimed`: shipping acceptance without funding would
-- reproduce `20260827120000`'s seventeen-permanently-stuck-steps defect on
-- purpose.
--
-- Because both moves are in one transaction, **no reader ever observes a task at
-- `claimed`**. That is the premise of
-- [ADR-0019](../../docs/40-adr/0019-claimed-to-matching-stays-dropped.md), which
-- is why the slice table's booked restoration of `claimed -> matching` is
-- reversed rather than carried: an arc out of a state nothing can sit in is a map
-- permitting an unmakeable transition. The ADR states its own falsifier, and it
-- is this file: **if accept ever splits into two transactions, `claimed` gains a
-- crash window and the arc is needed.**
--
-- Two UPDATEs rather than one direct `offered -> escrow_funded` is not
-- ceremony. The map has no such arc, the guard writes one `task.transitioned`
-- event per move, and the trail of a step that was taken and then funded is two
-- facts. Collapsing them would need a map change to hide an audit row.
--
-- ---------- The race with the matcher sweep ----------
--
-- `apps/api/src/lib/match.ts` is the clock's side of this domain and this
-- function is the person's side. They meet on two rows, and every move on both
-- sides is a conditional UPDATE, so a loser performs nothing rather than
-- overwriting a winner. Walked through, because the sweep's own header used to
-- say it was the single writer of `tasks.state` here and now must not:
--
--   * **Sweep first, accept second.** `settleOffered` expires the offer and moves
--     the task back to `matching`. This function's `status = 'open'` conditional
--     then matches zero rows, it raises, and the **whole transaction unwinds** —
--     no engagement, no hold, no ledger row, no membership. Atomicity is what
--     makes that safe rather than a cleanup problem.
--   * **Accept first, sweep second.** The offer is `accepted` and the task is
--     `escrow_funded`. `settleOffered` reads only tasks at `offered`, so it does
--     not select this one at all. `withdrawOrphans` reads only `open` offers.
--     `offerMatching` reads only tasks at `matching`. All three miss it.
--   * **They cannot interleave past each other**, because `settleOffered` only
--     cascades a task whose latest offer is already settled. It cannot move a task
--     out from under a live offer this function is in the middle of accepting.
--
-- ---------- The ledger pair is written here, and mirrored in TypeScript ----------
--
-- `packages/payments/src/ledger.ts` owns the chart of accounts and builds the
-- balanced pairs; the reconcile sweep inserts what it returns. This function
-- writes the hold pair in SQL instead, for property (1) above: a pair written
-- from Node after this commit could fail to write, and an unbalanced ledger is
-- worse than no ledger.
--
-- That is a second representation of one rule, which this repository normally
-- refuses, and it is taken on ADR-0011's terms: **both sides are pinned by
-- suites asserting the same property.** `packages/payments/src/ledger.test.ts`
-- asserts the TypeScript pair balances; `supabase/tests/marketplace_engagements.sql`
-- asserts `sum(debit) = sum(credit)` per `ref_id` after a real accept. The two
-- drifting apart fails a test rather than passing quietly.

create function public.accept_offer(p_offer_id uuid, p_charge_id text)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_engagement  uuid;
  v_offer       public.offers;
  v_task_state  public.task_state;
  v_rate        numeric(12, 2);
  v_period      text;
  v_node_curr   text;
  v_ceiling     numeric(12, 2);
  v_proj_curr   text;
  v_committed   numeric(12, 2);
  v_escrow      numeric(12, 2);
  v_hold        uuid;
  v_room        uuid;
  v_channel     uuid;
  v_thread      uuid;
  v_task_title  text;
  v_moved       int;
begin
  if p_charge_id is null or btrim(p_charge_id) = '' then
    raise exception 'accept_offer needs the payment provider''s charge reference'
      using errcode = 'invalid_parameter_value';
  end if;

  -- (1) **Idempotency, before anything is validated.** A retry of a commit that
  -- already succeeded returns what it built; it does not re-check a ceiling that
  -- may have moved since and refuse work already accepted, and it does not
  -- re-read an offer that is now `accepted` and raise about it. Verbatim the
  -- ordering `materialise_campaign` established and for the same reason.
  select id into v_engagement from public.engagements where offer_id = p_offer_id;
  if found then
    return v_engagement;
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if not found then
    raise exception 'offer % not found', p_offer_id using errcode = 'no_data_found';
  end if;

  -- (2) Open, and open **on Postgres's clock**. The node's browser and the API
  -- process disagree by seconds, and the deadline is the difference between an
  -- acceptance and an expiry, so the comparison is made where the row lives.
  -- This is the same argument `declineOffer` makes for putting `expires_at >
  -- now()` inside its conditional UPDATE.
  if v_offer.status <> 'open' then
    raise exception 'offer % is %, so it cannot be accepted', p_offer_id, v_offer.status
      using errcode = 'check_violation',
            hint = 'A settled offer never reopens.';
  end if;
  if v_offer.expires_at <= now() then
    raise exception 'offer % expired at %', p_offer_id, v_offer.expires_at
      using errcode = 'check_violation',
            hint = 'The step goes back to the market for the next candidate.';
  end if;

  -- (3) **Freeze the price**, and refuse an hourly one.
  --
  -- `engagements.agreed_price` is written once and never follows
  -- `node_profiles.rate` afterwards, so this read is the moment the number stops
  -- being editable. A null rate cannot be frozen at all: the matcher's pool query
  -- already requires one and `offerabilityGap` already tells such a node why they
  -- are never offered anything, so reaching here with a null rate means the rate
  -- was cleared between the offer and the acceptance.
  --
  -- **`rate_period = 'task'` is required, and this is the second of two layers.**
  -- `readEligiblePool` filters hourly nodes out of the pool, so an hourly node is
  -- not offered work in the first place. This is defense in depth behind that
  -- filter, and it is not redundant: an hourly rate is a price per hour and
  -- `escrow_holds.amount` is a total, so funding one as if it were the other
  -- would hold an arbitrary fraction of a real bill against somebody's ceiling.
  -- There is no hours field anywhere to multiply by, and inventing one at
  -- acceptance would be guessing at a number that decides what a person is paid.
  select rate, rate_period, currency into v_rate, v_period, v_node_curr
  from public.node_profiles where user_id = v_offer.node_id;
  if not found then
    raise exception 'offer % names node %, which has no marketplace profile',
      p_offer_id, v_offer.node_id
      using errcode = 'no_data_found';
  end if;
  if v_rate is null then
    raise exception 'node % has no rate, so there is no price to agree', v_offer.node_id
      using errcode = 'check_violation',
            hint = 'Set a rate before accepting work.';
  end if;
  if v_period is distinct from 'task' then
    raise exception
      'node % is priced by the %, and a step is funded as a whole amount',
      v_offer.node_id, v_period
      using errcode = 'check_violation',
            hint = 'Only task-rated nodes can be offered or accept work in this slice.';
  end if;

  -- (4) **The lock, and the reason the check is here at all.**
  --
  -- ADR-0011: the readable refusal lives in the API and this is the transactional
  -- arm of the same rule. Two nodes accepting two steps on one project at the
  -- same instant both pass a check made in Node, because each reads the committed
  -- total before either writes. `for update` on the project row serialises them,
  -- and it is the SAME row `materialise_campaign` locks, so an acceptance and a
  -- campaign approval cannot race past the ceiling either.
  select budget_ceiling, currency into v_ceiling, v_proj_curr
  from public.projects where id = v_offer.project_id for update;
  if not found then
    raise exception 'project % not found', v_offer.project_id using errcode = 'no_data_found';
  end if;

  if v_ceiling is null then
    raise exception 'project % has no authorised budget ceiling', v_offer.project_id
      using errcode = 'check_violation',
            hint = 'Set the project budget before an expert accepts work paid from it.';
  end if;

  -- One currency or the arithmetic means nothing. Summing 400 EUR against a
  -- ceiling of 1000 USD produces a number with no unit, and the failure would be
  -- an over-commitment nobody could see in the row. `materialise_campaign`'s rule,
  -- applied to the node's rate rather than to a card's payload.
  if v_node_curr is distinct from v_proj_curr then
    raise exception 'node % is priced in % but project % is in %',
      v_offer.node_id, v_node_curr, v_offer.project_id, v_proj_curr
      using errcode = 'check_violation';
  end if;

  -- Both committer classes (ADR-0020). Non-terminal campaign caps, and escrow
  -- already held, under the lock taken above.
  select coalesce(sum(budget_cap), 0) into v_committed
  from public.campaigns
  where project_id = v_offer.project_id
    and budget_cap is not null
    and not private.campaign_state_is_terminal(state);

  select coalesce(sum(amount), 0) into v_escrow
  from public.escrow_holds
  where project_id = v_offer.project_id
    and state = 'held';

  -- `>` and not `>=`: landing exactly on the ceiling is authorised, because the
  -- ceiling is the authorised amount rather than an amount to stay under. The
  -- same boundary `checkSpendCap` and `materialise_campaign` assert, asserted
  -- here too in both directions, because an off-by-one is either refusing what
  -- the owner authorised or committing one unit more than they did.
  if v_committed + v_escrow + v_rate > v_ceiling then
    raise exception
      'accepting would commit % against a ceiling of %, with % committed to campaigns and % already held in escrow',
      v_committed + v_escrow + v_rate, v_ceiling, v_committed, v_escrow
      using errcode = 'check_violation',
            hint = 'The owner raises the project ceiling, or waits for other commitments to settle.';
  end if;

  -- (5) **The arcs, as conditional UPDATEs.**
  --
  -- Every one of them goes through the table's own guard trigger, so the
  -- lifecycle binds this function exactly as it binds the sweep, and every audit
  -- row is trigger-written rather than hand-written beside a move that might not
  -- have happened. `get diagnostics` reads the row count because a conditional
  -- update that matches nothing is not an error in Postgres, and treating it as
  -- success is how a race is lost silently.

  update public.offers set status = 'accepted'
  where id = p_offer_id and status = 'open' and expires_at > now();
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'offer % stopped being open while it was being accepted', p_offer_id
      using errcode = 'check_violation',
            hint = 'The sweep settled it, or somebody else moved the step.';
  end if;

  update public.tasks set state = 'claimed'
  where id = v_offer.task_id and state = 'offered';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    -- Read the state back so the refusal names what actually happened. Without
    -- this the API's 409 is opaque, and "that step moved" is the one message a
    -- node cannot act on.
    select state into v_task_state from public.tasks where id = v_offer.task_id;
    raise exception
      'step % is %, not offered, so it cannot be claimed',
      v_offer.task_id, coalesce(v_task_state::text, 'missing')
      using errcode = 'check_violation',
            hint = 'The owner may have taken the step back, or the offer expired.';
  end if;

  update public.tasks set state = 'escrow_funded'
  where id = v_offer.task_id and state = 'claimed';
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    raise exception 'step % could not be funded after being claimed', v_offer.task_id
      using errcode = 'check_violation';
  end if;

  select title into v_task_title from public.tasks where id = v_offer.task_id;

  -- (6) The deal, the hold, and the balanced pair.

  insert into public.engagements (task_id, project_id, node_id, offer_id, agreed_price, currency)
  values (v_offer.task_id, v_offer.project_id, v_offer.node_id, p_offer_id, v_rate, v_proj_curr)
  returning id into v_engagement;

  -- `escrow:<offer_id>` is naturally epoch-ed: each cascade round produces a new
  -- offer row, so a step that came back to the market and was accepted on a later
  -- round derives a different key rather than colliding with the first attempt's.
  insert into public.escrow_holds (task_id, project_id, charge_id, amount, currency, idempotency_key)
  values (
    v_offer.task_id, v_offer.project_id, p_charge_id, v_rate, v_proj_curr,
    'escrow:' || p_offer_id::text
  )
  returning id into v_hold;

  -- The pair, mirroring `escrowHoldPair` in packages/payments. Money the owner
  -- authorised leaves their available balance and becomes an obligation held
  -- against this task: `owner_funds` is debited, `escrow` is credited, and the
  -- two are equal by construction because both read `v_rate`.
  insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
  values
    ('owner_funds', v_rate, 0, v_proj_curr, 'escrow_hold', v_hold),
    ('escrow',      0, v_rate, v_proj_curr, 'escrow_hold', v_hold);

  -- (7) **The thread.** `20260901120000` shipped the table with no writer and
  -- said creation "lands with the writer that first needs it"; slice 4 turned out
  -- not to need one, because it admits nobody. This does.
  --
  -- Create-or-find rather than create: `threads.task_id` is unique (one thread
  -- per task ever, so a reassignment does not fragment the trail), and this
  -- function is not the only thing that could ever have made it.
  --
  -- The room is resolved **the `is_project_member` way**: through the plan card
  -- first, falling back to the legacy `rooms.project_id` link. Going through
  -- `rooms.project_id` alone would be `20260827110000`'s exact defect, since that
  -- column is claimed permanently by the first project approved in a room.
  select ae.room_id into v_room
  from public.projects p
  join public.action_embeds ae on ae.id = p.source_embed_id
  where p.id = v_offer.project_id;

  if v_room is null then
    select r.id into v_room from public.rooms r where r.project_id = v_offer.project_id limit 1;
  end if;

  if v_room is null then
    raise exception 'project % has no room, so there is nowhere to work', v_offer.project_id
      using errcode = 'check_violation';
  end if;

  -- The room's first channel, by position then creation then id. Deterministic
  -- rather than arbitrary, because a crashed accept that retried into a different
  -- channel would put the thread somewhere else on the second attempt.
  --
  -- There is no `channelForRoom` helper anywhere in the codebase, and this is the
  -- only caller, so the pick lives here rather than becoming a one-use export.
  select c.id into v_channel
  from public.channels c
  where c.room_id = v_room
  order by c.position, c.created_at, c.id
  limit 1;

  if v_channel is null then
    raise exception 'room % has no channel to hold a thread', v_room
      using errcode = 'check_violation';
  end if;

  insert into public.threads (room_id, channel_id, task_id, title)
  values (v_room, v_channel, v_offer.task_id, coalesce(v_task_title, 'Expert work'))
  on conflict (task_id) do nothing;

  select id into v_thread from public.threads where task_id = v_offer.task_id;
  if v_thread is null then
    raise exception 'could not create or find a thread for step %', v_offer.task_id
      using errcode = 'check_violation';
  end if;

  -- (8) **Admission**, which is the whole reason threads exist (ADR-0017): a
  -- thread-scoped membership rather than a second table, so there is one
  -- predicate family to keep right.
  --
  -- **`expires_at` is null on purpose.** The module doc calls thread access
  -- "time-boxed", and there is no deadline to box it with: `engagements.deadline_at`
  -- has no writer in this slice and a number invented here would be a policy
  -- nobody decided. Revocation is therefore **explicit** rather than automatic:
  -- the reconcile sweep stamps `expires_at = now()` when an engagement ends, and
  -- the approval path in slice 6 does the same. An arbitrary expiry would cut a
  -- node off mid-task, which is worse than a membership that is closed by the act
  -- that ends the work.
  if exists (
    select 1 from public.room_members
    where room_id = v_room and user_id = v_offer.node_id
  ) then
    -- `room_members` is keyed on (room_id, user_id), so one person holds at most
    -- one membership per room and therefore at most one thread in it. That is
    -- ADR-0017's ceiling, and it is a real product limit rather than a bug: a
    -- node cannot work two steps of the same project at once. Refused with a
    -- sentence rather than absorbed silently, because silently reusing the
    -- existing row would admit them to the wrong thread.
    raise exception
      'node % already holds a membership in room %, so they cannot be admitted to a second thread there',
      v_offer.node_id, v_room
      using errcode = 'check_violation',
            hint = 'One thread per person per room (ADR-0017). Finish the other step first.';
  end if;

  insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
  values (v_room, v_offer.node_id, 'human_node', 'thread', v_thread, null);

  -- (9) **Events for everything an INSERT created.** The transition triggers fire
  -- on UPDATE only, so the offer's settlement and the task's two moves have
  -- audited themselves and these three have not. Without them the creation of a
  -- deal, a thread and an admission would be the only acts in this domain with no
  -- trail, and `engagement.ended` would first appear about an engagement nothing
  -- recorded beginning. `materialise_campaign` writes `campaign.materialised` for
  -- exactly this reason.

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_offer.project_id, auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'engagement.created', 'engagement', v_engagement,
    jsonb_build_object(
      'offer_id', p_offer_id,
      'task_id', v_offer.task_id,
      'node_id', v_offer.node_id,
      'round', v_offer.round,
      'agreed_price', v_rate,
      'currency', v_proj_curr,
      'hold_id', v_hold,
      'charge_id', p_charge_id,
      -- The arithmetic that authorised it, so a later reader can reconstruct the
      -- decision from the row rather than re-deriving it from totals that have
      -- since moved.
      'ceiling', v_ceiling,
      'committed_before', v_committed,
      'escrow_held_before', v_escrow
    )
  );

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_offer.project_id, auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'thread.created', 'thread', v_thread,
    jsonb_build_object('room_id', v_room, 'channel_id', v_channel, 'task_id', v_offer.task_id)
  );

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_offer.project_id, auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    -- Subject is the node, not the membership row: `room_members` has no id of
    -- its own, and `auditNode` already files acts about a person under
    -- `subject_type = 'node'`. The room and thread go in the payload, where a
    -- reader asking "what was this person admitted to" will look.
    'node.admitted', 'node', v_offer.node_id,
    jsonb_build_object(
      'room_id', v_room,
      'thread_id', v_thread,
      'task_id', v_offer.task_id,
      'scope', 'thread',
      'role', 'human_node',
      -- Recorded as null rather than omitted, because "no deadline" is the
      -- decision (see step 8) and an absent key would read as an oversight.
      'expires_at', null
    )
  );

  return v_engagement;
end;
$$;

revoke all on function public.accept_offer(uuid, text) from public;
grant execute on function public.accept_offer(uuid, text) to service_role;

-- **The security-invoker gotcha, stated rather than left to be rediscovered.**
-- This function is `security invoker`, so it needs EXECUTE on
-- `private.campaign_state_is_terminal` in its own right. That grant already
-- exists: `20260829140000:317` made it to `service_role` when
-- `materialise_campaign` hit the same wall, and `20260904123000` restates it.
-- No further grant is needed here, and the reason is written down because the
-- symptom is `permission denied for function` raised from the middle of a spend
-- check, which reads as an authorisation bug rather than a missing grant. That
-- pairing is what `20260813130000` had to correct after `20260813120000`.

comment on function public.accept_offer(uuid, text) is
  'A node accepts an offer: the offer settles to accepted, the task moves offered -> claimed -> '
  'escrow_funded, an engagement freezes the price, an escrow hold is modelled against the '
  'project ceiling, a balanced ledger pair is written, the task''s thread is created and the '
  'node is admitted thread-scoped. One transaction, so claimed is never observable (ADR-0019). '
  'Idempotent per offer via engagements.offer_id. NOTHING IS CHARGED: see 20260904121000.';
