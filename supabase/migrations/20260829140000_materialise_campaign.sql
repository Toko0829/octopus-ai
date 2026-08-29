-- 20260829140000_materialise_campaign.sql — an approved campaign card becomes a
-- campaign.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md
--
-- The fourth writer of its kind, and a deliberate sibling of `materialise_plan`
-- and `apply_plan_diff` rather than a variant. All three share four properties,
-- and each one is load-bearing:
--
--   1. **One transaction.** supabase-js speaks PostgREST and has none, so a
--      multi-row commit written in Node is a commit that can half-happen.
--   2. **The payload is read from the card**, never taken as arguments. The
--      person approved a specific thing; the rows built have to derive from what
--      they read rather than from whatever the caller sends afterwards.
--   3. **Idempotent by its own provenance.** `campaigns.source_embed_id` is
--      unique and was declared for exactly this at `20260829120000:87`. A retry
--      after a failed commit returns the same campaign instead of a second one.
--   4. **Unknown values raise.** A card can arrive from an older service, a
--      replay or a hand edit, and guessing on its behalf is how an unauthorised
--      figure gets written to a table whose whole meaning is authorisation.
--
-- **What is different here, and why.** This is the first of the three that
-- commits money, so it carries a spend check the other two have no equivalent
-- of. `checkSpendCap` in `packages/marketing` already implements that
-- arithmetic and the action route runs it before recording the verdict, which is
-- the readable refusal a person needs. This function performs it again under a
-- row lock, and the duplication is the point rather than an oversight:
--
--   Two campaign cards approved at the same instant both pass a check made in
--   Node, because each reads the committed total before either writes. The
--   conditional update on `action_embeds` makes one card single-use; it says
--   nothing about two. Without the lock the sum of authorised caps can exceed
--   the ceiling in the one table whose entire purpose is recording what was
--   authorised, and no later reader could tell that had happened.
--
-- The trade is a second implementation of a money rule, which this repository
-- normally refuses. It is taken knowingly, argued in the ADR, and defended by
-- pinning the same boundary in both suites: `spend.test.ts` asserts the
-- TypeScript `<=` in both directions and `materialise_campaign.sql` asserts the
-- SQL one, so the two drifting apart fails a test rather than passing quietly.
--
-- Note this does not contradict `data-model.md`'s "the spend cap is enforced in
-- tool code, not by a constraint". A CHECK constraint would be a rule the
-- database applies to itself with no idea what was authorised; this is the
-- transactional arm of the tool, reachable by `service_role` alone.

create function public.materialise_campaign(p_embed_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_embed      public.action_embeds;
  v_campaign   uuid;
  v_project    uuid;
  v_card_room  uuid;
  v_status     public.project_status;
  v_channel    public.marketing_channel;
  v_name       text;
  v_objective  text;
  v_currency   text;
  v_proj_curr  text;
  v_cap        numeric(12, 2);
  v_ceiling    numeric(12, 2);
  v_committed  numeric(12, 2);
  v_task       uuid;
  v_task_proj  uuid;
  v_task_state public.task_state;
  v_moved      boolean := false;
  v_creator    public.author_kind;
begin
  select * into v_embed from public.action_embeds where id = p_embed_id;
  if not found then
    raise exception 'embed % not found', p_embed_id using errcode = 'no_data_found';
  end if;

  if v_embed.component <> 'campaign' then
    raise exception 'embed % is a %, not a campaign', p_embed_id, v_embed.component
      using errcode = 'invalid_parameter_value';
  end if;

  -- Idempotency, before anything is validated. A retry of a commit that already
  -- succeeded returns what it built; it does not re-check a ceiling that may have
  -- moved since and refuse work the owner already authorised.
  select id into v_campaign from public.campaigns where source_embed_id = p_embed_id;
  if found then
    return v_campaign;
  end if;

  v_project := nullif(trim(v_embed.payload->>'projectId'), '')::uuid;
  if v_project is null then
    raise exception 'campaign card % names no project', p_embed_id
      using errcode = 'invalid_parameter_value';
  end if;

  select status, currency into v_status, v_proj_curr
  from public.projects where id = v_project;
  if not found then
    raise exception 'project % not found', v_project using errcode = 'no_data_found';
  end if;
  if v_status in ('completed', 'cancelled') then
    raise exception 'project % is %; a finished project does not start campaigns',
      v_project, v_status
      using errcode = 'check_violation';
  end if;

  -- Tenancy, verbatim the rule `apply_plan_diff` established. The action route
  -- checks the caller's membership of the CARD's room, which says nothing about
  -- the project this payload names, so a card posted anywhere could otherwise
  -- authorise spend against anyone's project. Resolved through the project's own
  -- plan card, never through `rooms.project_id`, which the first project in a
  -- room claims forever.
  select a.room_id into v_card_room
  from public.projects p
  join public.action_embeds a on a.id = p.source_embed_id
  where p.id = v_project;

  if v_card_room is null or v_card_room <> v_embed.room_id then
    raise exception 'campaign card % belongs to room %, but project % does not',
      p_embed_id, v_embed.room_id, v_project
      using errcode = 'insufficient_privilege',
            hint = 'A campaign may only be authorised for a project of the room its card was posted in.';
  end if;

  v_name := nullif(trim(v_embed.payload->>'name'), '');
  if v_name is null then
    raise exception 'campaign card % has no name', p_embed_id
      using errcode = 'invalid_parameter_value';
  end if;
  v_objective := nullif(trim(v_embed.payload->>'objective'), '');

  -- Explicit mapping rather than a cast, so an unrecognised channel raises with
  -- the value in the message instead of surfacing as invalid_text_representation.
  v_channel := case v_embed.payload->>'channel'
    when 'meta'           then 'meta'::public.marketing_channel
    when 'google'         then 'google'::public.marketing_channel
    when 'email'          then 'email'::public.marketing_channel
    when 'organic_social' then 'organic_social'::public.marketing_channel
  end;
  if v_channel is null then
    raise exception 'campaign card % has unknown channel %',
      p_embed_id, v_embed.payload->>'channel'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The cap the owner typed, written into the payload by the action route as it
  -- recorded the verdict. Absent means the card was approved without one, which
  -- is not a campaign this function will create: "authorised, nothing authorised"
  -- is not a state, and defaulting it to any number would invent an authorisation.
  --
  -- **`is distinct from` and not `<>`, and the difference is a campaign that
  -- authorised nothing and said it was ready.** A missing key makes
  -- `payload->'budgetCap'` SQL NULL, `jsonb_typeof(NULL)` NULL, and `NULL <>
  -- 'number'` is NULL rather than true, so the guard did not fire. Every later
  -- comparison then inherited the NULL the same way (`v_cap < 0`, and the ceiling
  -- sum) and the insert wrote `budget_cap = NULL` at state `ready`. That is the
  -- NULL twin of the `NaN` case `spend.ts` guards on the TypeScript side, with the
  -- same shape and the same worst-available outcome: not an error, not a type
  -- mismatch, just an unauthorised campaign that looks authorised. Caught by the
  -- pgTAP assertion for it rather than by reading the code.
  if jsonb_typeof(v_embed.payload->'budgetCap') is distinct from 'number' then
    raise exception 'campaign card % carries no authorised budget', p_embed_id
      using errcode = 'check_violation',
            hint = 'Enter a budget on the card before approving it.';
  end if;
  v_cap := (v_embed.payload->>'budgetCap')::numeric;
  if v_cap < 0 then
    raise exception 'campaign card % has a negative budget %', p_embed_id, v_cap
      using errcode = 'check_violation';
  end if;

  -- One currency or the arithmetic below means nothing. Summing 400 EUR against a
  -- ceiling of 1000 USD produces a number with no unit, and the failure would be
  -- an over-commitment nobody could see in the row.
  v_currency := coalesce(nullif(trim(v_embed.payload->>'currency'), ''), v_proj_curr);
  if v_currency <> v_proj_curr then
    raise exception 'campaign card % is in % but project % is in %',
      p_embed_id, v_currency, v_project, v_proj_curr
      using errcode = 'check_violation';
  end if;

  -- The lock, and the reason for the whole function. `for update` serialises
  -- concurrent approvals on the project row, so the committed total read below
  -- cannot change between reading it and inserting against it.
  select budget_ceiling into v_ceiling
  from public.projects where id = v_project for update;

  if v_ceiling is null then
    raise exception 'project % has no authorised budget ceiling', v_project
      using errcode = 'check_violation',
            hint = 'Set the project budget ceiling before authorising campaign spend.';
  end if;

  -- Non-terminal siblings only, because a cancelled or completed campaign is not
  -- holding any of the ceiling. A null cap contributes nothing rather than
  -- poisoning the sum, which is the same filtering `readSpendInputs` does in Node.
  select coalesce(sum(budget_cap), 0) into v_committed
  from public.campaigns
  where project_id = v_project
    and budget_cap is not null
    and not private.campaign_state_is_terminal(state);

  -- `>` and not `>=`: landing exactly on the ceiling is authorised, matching
  -- `checkSpendCap` exactly. This boundary is asserted in both directions in both
  -- suites, because an off-by-one here either refuses what the owner authorised
  -- or commits one unit more than they did.
  if v_committed + v_cap > v_ceiling then
    raise exception
      'campaign would commit % against a ceiling of %, with % already committed',
      v_committed + v_cap, v_ceiling, v_committed
      using errcode = 'check_violation',
            hint = 'Lower the campaign budget or raise the project ceiling.';
  end if;

  -- The step this campaign delivers. Optional in the schema, so a card without
  -- one still produces a campaign.
  v_task := nullif(trim(v_embed.payload->>'taskId'), '')::uuid;
  if v_task is not null then
    select project_id, state into v_task_proj, v_task_state
    from public.tasks where id = v_task;
    if not found then
      raise exception 'campaign card % names task %, which does not exist',
        p_embed_id, v_task
        using errcode = 'invalid_parameter_value';
    end if;
    if v_task_proj <> v_project then
      raise exception 'task % belongs to project %, not %',
        v_task, v_task_proj, v_project
        using errcode = 'invalid_parameter_value';
    end if;

    -- The campaign IS the step's deliverable, so authorising it closes the step
    -- and lets whatever depends on it become ready. `needs_user -> approved` is
    -- the arc `20260815220000` added for the answered-question path, and this is
    -- the same shape of act: a person supplied what only a person could.
    --
    -- **Conditional, and it deliberately does not raise when it matches nothing.**
    -- The step may have moved while the card sat there: answered through its
    -- question card, or cancelled by a replan. Raising then would strand an
    -- approval permanently, since the card already reads approved and every retry
    -- meets the same state, so the owner's decision would be unrecoverable and
    -- the campaign they authorised would never exist. The campaign is created
    -- either way and the step's actual state goes into the event, so the skip is
    -- visible rather than silent.
    update public.tasks
    set state = 'approved'
    where id = v_task and state = 'needs_user';
    v_moved := found;
  end if;

  -- `acted_by` is the owner who approved; a card committed by machinery with no
  -- actor is recorded as the agent's rather than attributed to a person.
  v_creator := case when v_embed.acted_by is null
                    then 'agent'::public.author_kind
                    else 'user'::public.author_kind end;

  insert into public.campaigns (
    project_id, task_id, name, objective, channel, state,
    budget_cap, currency, source_embed_id, created_by
  )
  values (
    v_project, v_task, v_name, v_objective, v_channel,
    -- `ready` and not `draft`: the state means "approved by the owner, not yet
    -- sent", and it is exactly what just happened. Nothing publishes in this
    -- slice, so `ready` is where a campaign stops until a publish executor exists.
    'ready',
    v_cap, v_currency, p_embed_id, v_creator
  )
  returning id into v_campaign;

  -- The campaign trigger writes `campaign.transitioned` on UPDATE only, so an
  -- INSERT that lands at `ready` audits nothing by itself. Written here for that
  -- reason: without it the authorisation of money would be the one act in this
  -- domain with no event, and `campaign.transitioned` would first appear when the
  -- campaign left a state nothing recorded it entering.
  insert into public.events (
    project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
  )
  values (
    v_project, auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind
         else 'user'::public.author_kind end,
    'campaign.materialised', 'campaign', v_campaign,
    jsonb_build_object(
      'embed_id', p_embed_id,
      'room_id', v_embed.room_id,
      'task_id', v_task,
      'channel', v_channel,
      'budget_cap', v_cap,
      'currency', v_currency,
      'committed_before', v_committed,
      'ceiling', v_ceiling,
      -- What the step was when the card was approved, and whether this closed it.
      -- Without both, a skipped transition and a step that was never named look
      -- identical afterwards.
      'task_state_at_approval', v_task_state,
      'task_closed', v_moved
    )
  );

  return v_campaign;
end;
$$;

revoke all on function public.materialise_campaign(uuid) from public;
grant execute on function public.materialise_campaign(uuid) to service_role;

-- `private.campaign_state_is_terminal` was revoked from `public` when it was
-- created (`20260829120000:152`) and never granted to anybody, which was correct
-- while nothing called it: the trigger that used it runs as its definer. This
-- function is `security invoker`, so it needs the grant in its own right, and
-- without it every commit would fail with `permission denied for function` at the
-- spend check. Exactly the pairing `20260813130000` had to correct after
-- `20260813120000`, fixed here rather than in a follow-up so the migration
-- replays from scratch.
grant execute on function private.campaign_state_is_terminal(public.campaign_state)
  to service_role;

comment on function public.materialise_campaign(uuid) is
  'Turn an approved campaign card into one campaigns row at state ready, in one '
  'transaction. Idempotent per card via campaigns.source_embed_id. Re-checks the '
  'project spend ceiling under a row lock, because two cards approved at once '
  'both pass a check made in the API. Closes the originating task when it is '
  'still waiting on the owner.';
