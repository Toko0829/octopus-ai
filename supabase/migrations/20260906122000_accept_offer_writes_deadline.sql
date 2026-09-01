-- 20260906122000_accept_offer_writes_deadline.sql — `engagements.deadline_at` gets its writer.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md, docs/30-modules/payments-billing.md
--
-- Marketplace slice 6, third migration. **No arc, no table, no grant.** One
-- column is written that was not written before, and one field is added to an
-- event payload.
--
-- `deadline_at` has been a column with no writer and no reader since
-- `20260904120000`. `20260906121000` put the number on the offer; this stamps it
-- onto the deal, so it is frozen at acceptance exactly as `agreed_price` is and
-- for the same reason: what was agreed must not change because a constant moved
-- afterwards.
--
-- **Read from the row, never from an argument.** `20260904125000:22-24` is
-- binding here and the caller of the accept route is the node, so a node naming
-- their own deadline is the same refusal as a node naming their own price. The
-- signature is unchanged, which is the point.
--
-- **It goes in the `engagement.created` payload too.** That event already carries
-- `ceiling`, `committed_before` and `escrow_held_before`, which is the same
-- discipline: the numbers the decision was made against, recorded where a dispute
-- can read them. A reassignment later turns on this timestamp, so it belongs in
-- the trail rather than only in the row it can be re-read from.
--
-- **This migration is deliberately separate from `20260906123000`**, which is the
-- arc file. `20260904124000:10-12` set the idiom: a lifecycle only widens when
-- something can walk the new edge, and the two land as two files in one push so
-- neither reads as having arrived alone. This one creates no arc at all.
--
-- The whole body is restated, per `20260827120000:44-47`. The only differences
-- from the applied version are the `v_deadline` declaration, the two lines that
-- compute and insert it, and one payload field.

create or replace function public.accept_offer(p_offer_id uuid, p_charge_id text)
returns uuid
language plpgsql
set search_path to 'public'
as $function$
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
  v_deadline    timestamptz;
  v_moved       int;
begin
  if p_charge_id is null or btrim(p_charge_id) = '' then
    raise exception 'accept_offer needs the payment provider''s charge reference'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_engagement from public.engagements where offer_id = p_offer_id;
  if found then
    return v_engagement;
  end if;

  select * into v_offer from public.offers where id = p_offer_id;
  if not found then
    raise exception 'offer % not found', p_offer_id using errcode = 'no_data_found';
  end if;

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

  if v_node_curr is distinct from v_proj_curr then
    raise exception 'node % is priced in % but project % is in %',
      v_offer.node_id, v_node_curr, v_offer.project_id, v_proj_curr
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(budget_cap), 0) into v_committed
  from public.campaigns
  where project_id = v_offer.project_id
    and budget_cap is not null
    and not private.campaign_state_is_terminal(state);

  select coalesce(sum(amount), 0) into v_escrow
  from public.escrow_holds
  where project_id = v_offer.project_id
    and state = 'held';

  if v_committed + v_escrow + v_rate > v_ceiling then
    raise exception
      'accepting would commit % against a ceiling of %, with % committed to campaigns and % already held in escrow',
      v_committed + v_escrow + v_rate, v_ceiling, v_committed, v_escrow
      using errcode = 'check_violation',
            hint = 'The owner raises the project ceiling, or waits for other commitments to settle.';
  end if;

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

  -- **The deadline, frozen here rather than computed on every read.**
  -- `20260906121000` put the policy number on the offer so the node saw it before
  -- they agreed; this turns it into an instant, so a later change to the constant
  -- cannot shorten the time somebody already has. Postgres's clock, like every
  -- other comparison in this function.
  v_deadline := now() + make_interval(hours => v_offer.work_deadline_hours);

  insert into public.engagements
    (task_id, project_id, node_id, offer_id, agreed_price, currency, deadline_at)
  values
    (v_offer.task_id, v_offer.project_id, v_offer.node_id, p_offer_id, v_rate, v_proj_curr,
     v_deadline)
  returning id into v_engagement;

  insert into public.escrow_holds (task_id, project_id, charge_id, amount, currency, idempotency_key)
  values (
    v_offer.task_id, v_offer.project_id, p_charge_id, v_rate, v_proj_curr,
    'escrow:' || p_offer_id::text
  )
  returning id into v_hold;

  insert into public.ledger_entries (account, debit, credit, currency, ref_type, ref_id)
  values
    ('owner_funds', v_rate, 0, v_proj_curr, 'escrow_hold', v_hold),
    ('escrow',      0, v_rate, v_proj_curr, 'escrow_hold', v_hold);

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

  if exists (
    select 1 from public.room_members
    where room_id = v_room and user_id = v_offer.node_id
  ) then
    raise exception
      'node % already holds a membership in room %, so they cannot be admitted to a second thread there',
      v_offer.node_id, v_room
      using errcode = 'check_violation',
            hint = 'One thread per person per room (ADR-0017). Finish the other step first.';
  end if;

  -- `expires_at` stays null. There is now a deadline on the engagement, and it is
  -- deliberately NOT copied here: a membership boxed by the deadline would cut a
  -- node out of their own thread the instant they ran late, at exactly the moment
  -- they most need to say why. Revocation stays explicit, done by whatever ends
  -- the work: the approval path, or the reconcile sweep, or the no-show sweep.
  insert into public.room_members (room_id, user_id, role, scope, thread_id, expires_at)
  values (v_room, v_offer.node_id, 'human_node', 'thread', v_thread, null);

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
      'ceiling', v_ceiling,
      'committed_before', v_committed,
      'escrow_held_before', v_escrow,
      -- Beside the other numbers the decision rested on. A reassignment turns on
      -- this instant, so a dispute reads it here rather than inferring it.
      'deadline_at', v_deadline
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
    'node.admitted', 'node', v_offer.node_id,
    jsonb_build_object(
      'room_id', v_room,
      'thread_id', v_thread,
      'task_id', v_offer.task_id,
      'scope', 'thread',
      'role', 'human_node',
      'expires_at', null
    )
  );

  return v_engagement;
end;
$function$;

-- The grants are restated because `create or replace` keeps them, and saying so
-- is cheaper than a reader wondering. `security invoker` is unchanged and
-- load-bearing: `20260904125000:467-475` records that this function needs EXECUTE
-- on `private.campaign_state_is_terminal` in its own right.
revoke all on function public.accept_offer(uuid, text) from public;
grant execute on function public.accept_offer(uuid, text) to service_role;
