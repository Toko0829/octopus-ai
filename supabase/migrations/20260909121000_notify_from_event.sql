-- 20260909121000_notify_from_event.sql — a moment cannot be recorded without the person being told.
-- Owner doc: docs/30-modules/notifications.md
-- Also: docs/10-architecture/data-model.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0028-a-notification-is-derived-from-the-event.md
--
-- Notifications slice 1, second migration. `20260909120000` made the table; this
-- is its only writer, and it is a trigger rather than a function anybody calls.
--
-- ---------- Why a trigger on `events`, and not a call beside each act ----------
--
-- The obvious shape is a `notify(...)` helper called next to `postSystemMessage`
-- in the routes. It was rejected on a count. **Six of the eleven moments in the
-- map below are written by SQL, not by application code**: `accept_offer`,
-- `reassign_engagement`, `settle_payout`, `raise_dispute`, the
-- `guard_dispute_resolve` trigger and the KYC audit trigger. A Node-side helper
-- reaches none of them without re-implementing their transactions in TypeScript,
-- which is exactly the "two writers over one truth" shape this repository keeps
-- paying for.
--
-- `public.events` is the one ledger every one of them already writes, in the same
-- transaction as the fact. Deriving from it gives the property the slice exists
-- for and cannot be got any other way: **a moment cannot be recorded without the
-- person it concerns being told**, including by a writer that does not exist yet.
--
-- The cost is stated rather than discovered: this trigger runs inside
-- `settle_payout`, so a defect here aborts a payout. Three things bound it.
-- Enrichment is left-joined throughout, so a missing title or a deleted room can
-- never be the defect. The verb list is a closed `case`, so an unknown verb
-- returns immediately and no future event can reach this code by accident. And
-- `supabase/tests/notifications.sql` derives at least one row for every verb in
-- the map, so a payload rename fails a suite rather than a transfer.
--
-- The alternative was catching everything and continuing. That is refused under
-- rule 16: a notification silently not written is indistinguishable from the
-- state this slice was built to end, and nobody would find it.
--
-- ---------- The payload is an allow-list, not a copy ----------
--
-- Each branch names the keys it forwards. Carrying `new.payload` wholesale would
-- be shorter and would have disclosed `resolved_by` — the operator who decided a
-- dispute — to both parties, silently, as a side effect of a convenience.
-- `20260907123000` made the counterparty-disclosure decision explicitly and
-- `20260908126000` widened it explicitly; this file keeps that discipline. What a
-- recipient can read is a decision somebody makes, never something they inherit.
--
-- ---------- The recipients ----------
--
--   offer.created            -> the node it was offered to        (payload node_id)
--   offer.accepted           -> the owner                          (projects.owner_id)
--   proof.submitted          -> the owner
--   proof.bounced            -> the node                           (via engagement_id)
--   work.approved            -> the node                           (live engagement on the task)
--   work.rejected            -> the node
--   engagement.reassigned    -> the node who lost it, AND the owner
--   payout.settled           -> the node
--   dispute.raised           -> the OTHER party (by raised_role)
--   dispute.resolved         -> the node, AND the owner
--   node.kyc_status_changed  -> the node                           (subject_id is the user)
--   task.transitioned        -> the owner, ONLY on matching -> escalated
--
-- `task.transitioned` fires on every step of every project and is the reason the
-- guard below is a `where`, not a comment: exhaustion (`matching -> escalated`)
-- is the one transition that is news, because it is the step coming back with
-- nobody found. Every other transition either has its own verb here or is the
-- system working.

-- ---------- Which room the owner is sent to ----------
--
-- `roomForProject` in `apps/api/src/lib/room-for-project.ts`, in SQL. Its whole
-- docstring is the reason this is not `rooms.project_id`: that column is claimed
-- by the FIRST project approved in a room and never reassigned, which once put
-- 8 approved tasks and 8 artifacts in a room that pointed at a nine-day-old
-- project. `projects.source_embed_id` is unique, set at creation and never
-- changed, so it answers durably. The fallback is kept for projects that predate
-- the column, exactly as `private.is_project_member` keeps it.
create function private.room_for_project(p_project uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (
      select ae.room_id
      from public.projects p
      join public.action_embeds ae on ae.id = p.source_embed_id
      where p.id = p_project
    ),
    (
      select r.id
      from public.rooms r
      where r.project_id = p_project
      order by r.created_at
      limit 1
    )
  );
$$;

revoke all on function private.room_for_project(uuid) from public;

comment on function private.room_for_project(uuid) is
  'The room a project is announced in, through the plan card rather than rooms.project_id. '
  'Mirrors apps/api/src/lib/room-for-project.ts, whose docstring records the run where the '
  'legacy column silently delivered nothing because a room already pointed elsewhere.';

-- ---------- One insert, one place ----------
--
-- Every branch below routes through this, so the key format, the conflict
-- behaviour and the null-recipient refusal are written once. `p_event` is the
-- whole row rather than six parameters: the columns it needs are the columns the
-- key is built from, and passing them apart is how they drift apart.
create function private.notify(
  p_event   public.events,
  p_user    uuid,
  p_role    text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Refused rather than skipped. A recipient this function cannot resolve means
  -- the payload it was reading changed shape, and the honest failure is loud:
  -- silently writing nothing would restore, undetectably, the exact condition
  -- this slice exists to end.
  if p_user is null then
    raise exception
      'event % (%) matched the notification map but named nobody to tell',
      p_event.id, p_event.verb
      using errcode = 'check_violation',
            hint = 'The writer''s payload changed shape. See private.notify_from_event and '
                   'supabase/tests/notifications.sql, which pins one row per verb.';
  end if;

  insert into public.notifications (
    user_id, recipient_role, kind, subject_type, subject_id, project_id, event_id, key, payload
  )
  values (
    p_user,
    p_role,
    p_event.verb,
    p_event.subject_type,
    p_event.subject_id,
    p_event.project_id,
    p_event.id,
    p_event.verb || ':' || p_event.subject_id::text || ':' || p_user::text,
    coalesce(p_payload, '{}'::jsonb)
  )
  -- `events` carries no unique key and a replay can write the same moment twice
  -- (`match.ts:478-481` says so about `offer.created` specifically). A collision
  -- is the mechanism working: this person has already been told this thing.
  on conflict (key) do nothing;
end;
$$;

revoke all on function private.notify(public.events, uuid, text, jsonb) from public;

comment on function private.notify(public.events, uuid, text, jsonb) is
  'The single insert into public.notifications. Builds the dedup key as '
  '<verb>:<subject_id>:<user_id> and swallows the conflict, because a repeated event means the '
  'person has already been told. Raises when the recipient is null: an unresolvable recipient is '
  'a payload that changed shape, and skipping it silently is the defect this slice removes.';

-- ---------- The map ----------

create function private.notify_from_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task  uuid;
  v_title text;
  v_owner uuid;
  v_room  uuid;
  v_node  uuid;
begin
  -- Most events are not news. `task.routed`, `task.executed`, `campaign.*`,
  -- `node.profile_updated` and the rest fall out here, and so does every verb a
  -- later slice invents until it is added to this list and to the table's check
  -- constraint together.
  if new.verb not in (
    'offer.created', 'offer.accepted', 'proof.submitted', 'proof.bounced',
    'work.approved', 'work.rejected', 'engagement.reassigned', 'payout.settled',
    'dispute.raised', 'dispute.resolved', 'node.kyc_status_changed', 'task.transitioned'
  ) then
    return new;
  end if;

  -- The one transition that is news. Checked before any lookup because
  -- `task.transitioned` fires on every step of every project, several times each.
  if new.verb = 'task.transitioned'
     and not (new.payload->>'from' = 'matching' and new.payload->>'to' = 'escalated') then
    return new;
  end if;

  -- Which step this is about. Either the subject itself or a payload key,
  -- depending on which writer produced the event.
  v_task := coalesce(
    nullif(new.payload->>'task_id', '')::uuid,
    case when new.subject_type = 'task' then new.subject_id end
  );

  -- Enrichment, all of it optional. A step whose title is missing produces a
  -- notification that says "a step"; it never produces a failed payout.
  if v_task is not null then
    select title into v_title from public.tasks where id = v_task;
  end if;

  if new.project_id is not null then
    select owner_id into v_owner from public.projects where id = new.project_id;
    v_room := private.room_for_project(new.project_id);
  end if;

  case new.verb

    -- ---------- Offered ----------
    -- The node is told a step is waiting for an answer. This is the moment the
    -- whole slice is for: until now the only way to learn of an offer was to open
    -- /node and look, which is what makes the window 48 hours.
    when 'offer.created' then
      v_node := nullif(new.payload->>'node_id', '')::uuid;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'expires_at', new.payload->>'expires_at',
        'rate', new.payload->'rate',
        'round', new.payload->'round'
      ));

    -- ---------- Somebody took it ----------
    when 'offer.accepted' then
      perform private.notify(new, v_owner, 'owner', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'room_id', v_room,
        'agreed_price', new.payload->'agreed_price',
        'currency', new.payload->>'currency'
      ));

    -- ---------- Handed over ----------
    when 'proof.submitted' then
      perform private.notify(new, v_owner, 'owner', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'room_id', v_room,
        'files', new.payload->'files'
      ));

    -- ---------- The acceptance criteria refused it ----------
    -- To the node, not the owner: nothing has been handed over yet, and telling
    -- the owner about work that bounced before it reached them would be reporting
    -- a draft.
    when 'proof.bounced' then
      select e.node_id into v_node
      from public.engagements e
      where e.id = nullif(new.payload->>'engagement_id', '')::uuid;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'failures', new.payload->'failures'
      ));

    -- ---------- The owner decided ----------
    -- The live engagement on the step, because approval does not end it:
    -- `settle_payout` does, one tick later. A rejected step keeps its engagement
    -- too, which is what lets the node redo the work or dispute the rejection.
    when 'work.approved', 'work.rejected' then
      select e.node_id into v_node
      from public.engagements e
      where e.task_id = v_task and e.ended_at is null
      order by e.created_at desc
      limit 1;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'note', new.payload->>'note'
      ));

    -- ---------- The deadline passed and the step went back to the market ----------
    -- Both parties, and this is the one place the node being told is arguably
    -- overdue rather than welcome: they lost the work. They are told anyway,
    -- because the alternative is discovering it from a thread they can no longer
    -- open.
    when 'engagement.reassigned' then
      v_node := nullif(new.payload->>'node_id', '')::uuid;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'deadline_at', new.payload->>'deadline_at',
        'agreed_price', new.payload->'agreed_price',
        'currency', new.payload->>'currency'
      ));
      perform private.notify(new, v_owner, 'owner', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'room_id', v_room,
        'agreed_price', new.payload->'agreed_price',
        'currency', new.payload->>'currency'
      ));

    -- ---------- Paid ----------
    -- `platform_fee` and `transfer_id` are deliberately not forwarded: the fee is
    -- not deducted from an agreed price (ADR-0024) so showing it beside the
    -- amount would invite the reading that it was, and a provider reference is
    -- reconciliation, not news.
    when 'payout.settled' then
      v_node := nullif(new.payload->>'node_id', '')::uuid;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'amount', new.payload->'amount',
        'currency', new.payload->>'currency'
      ));

    -- ---------- Somebody said it went wrong ----------
    -- The other party, by who raised it. The raiser knows; the point is that the
    -- person it is about finds out. `admin-ops.md:85` keeps its decision that the
    -- node's working thread gets no line, because a dispute is decided by an
    -- operator rather than negotiated between the parties. An inbox row is not a
    -- negotiation.
    when 'dispute.raised' then
      if new.payload->>'raised_role' = 'owner' then
        v_node := nullif(new.payload->>'node_id', '')::uuid;
        perform private.notify(new, v_node, 'node', jsonb_build_object(
          'task_id', v_task,
          'task_title', v_title,
          'raised_role', new.payload->>'raised_role',
          'from_state', new.payload->>'from_state'
        ));
      else
        perform private.notify(new, v_owner, 'owner', jsonb_build_object(
          'task_id', v_task,
          'task_title', v_title,
          'room_id', v_room,
          'raised_role', new.payload->>'raised_role',
          'from_state', new.payload->>'from_state'
        ));
      end if;

    -- ---------- An operator decided ----------
    -- Both parties, always, whoever raised it. `resolved_by` is not forwarded:
    -- naming the operator to the parties is a disclosure nobody has decided to
    -- make, and `ops_actions` already records it for the people entitled to read
    -- it.
    when 'dispute.resolved' then
      select e.node_id into v_node
      from public.engagements e
      where e.id = nullif(new.payload->>'engagement_id', '')::uuid;
      perform private.notify(new, v_node, 'node', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'resolution', new.payload->>'resolution',
        'release_amount', new.payload->'release_amount',
        'refund_amount', new.payload->'refund_amount'
      ));
      perform private.notify(new, v_owner, 'owner', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'room_id', v_room,
        'resolution', new.payload->>'resolution',
        'release_amount', new.payload->'release_amount',
        'refund_amount', new.payload->'refund_amount'
      ));

    -- ---------- The identity check came back ----------
    -- `project_id` is null on this event and therefore on this row, which is why
    -- the table permits it. `suspended_reason` is forwarded although nothing can
    -- write `suspended` yet, so the day a moderation console exists the person
    -- suspended is told why without a migration.
    when 'node.kyc_status_changed' then
      perform private.notify(new, new.subject_id, 'node', jsonb_build_object(
        'from', new.payload->>'from',
        'to', new.payload->>'to',
        'suspended_reason', new.payload->>'suspended_reason'
      ));

    -- ---------- Nobody took it ----------
    -- Guarded at the top of this function; by here the transition is known to be
    -- `matching -> escalated`, which is the offer cascade exhausting and the step
    -- coming back to the person who has to do something about it (ADR-0018).
    when 'task.transitioned' then
      perform private.notify(new, v_owner, 'owner', jsonb_build_object(
        'task_id', v_task,
        'task_title', v_title,
        'room_id', v_room,
        'from', new.payload->>'from',
        'to', new.payload->>'to'
      ));

    else
      null;
  end case;

  return new;
end;
$$;

revoke all on function private.notify_from_event() from public;

comment on function private.notify_from_event() is
  'Derives public.notifications from public.events (ADR-0028). AFTER INSERT, so it runs inside '
  'the transaction that recorded the fact: six of the eleven moments are written by SQL '
  'functions that no Node-side helper could reach. Unknown verbs return immediately. Enrichment '
  'is left-joined and never fails; only an unresolvable recipient raises.';

create trigger events_notify
  after insert on public.events
  for each row
  execute function private.notify_from_event();
