-- 20260904123000_ceiling_counts_escrow.sql — `projects.budget_ceiling` gains a
-- second class of committer.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/payments-billing.md,
--       docs/30-modules/marketing-growth-engine.md,
--       docs/40-adr/0011-spend-cap-checked-twice.md,
--       docs/40-adr/0020-the-ceiling-has-two-committer-classes.md
--
-- One arithmetic change, and it lands **before** the writer that can create a
-- hold (`20260904125000`). That ordering is this repository's standing rule and
-- the direction it points here is unambiguous: a guard that arrives after its
-- first writer has an interval in which the rule is not enforced, and on a spend
-- ceiling that interval is an over-commitment nobody could see in the row
-- afterwards.
--
-- ---------- What changed, and the four places it binds ----------
--
-- `materialise_campaign` has re-checked the ceiling under a row lock since
-- `20260829140000`, summing the `budget_cap` of non-terminal sibling campaigns.
-- From `20260904121000` there is a second thing committed against the same
-- number: `escrow_holds` at `state = 'held'`. This replaces the function with the
-- escrow sum added under the same lock and folded into the same refusal.
--
-- [ADR-0020](../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)
-- records the contract that follows, in ADR-0011's own discipline. **Four places
-- must move in step**, and each is pinned by a suite so that drift fails a test
-- rather than passing quietly:
--
--   1. `packages/marketing/src/spend.ts` `checkSpendCap`  (pinned by `spend.test.ts`)
--   2. `apps/api/src/lib/spend-reads.ts` `readSpendInputs` (pinned by `spend-reads.test.ts`)
--   3. the SQL sum in this file                            (pinned by `materialise_campaign.sql`)
--   4. the `committedBudget` projection in `apps/api/src/routes/projects.ts`
--                                                          (pinned by `projects.test.ts`)
--
-- ---------- The two classes cannot race past the ceiling ----------
--
-- `accept_offer` (`20260904125000`) takes `select ... for update` on the **same**
-- `projects` row before its own re-check, and so does this function. Two
-- transactions therefore serialise on that row rather than both reading a total
-- the other is about to change. That is the identical argument
-- `20260829140000:27-38` makes for why the check exists in SQL at all, extended
-- to a second writer: a check made in Node passes for both of two concurrent
-- actors, because each reads the committed total before either writes.
--
-- ---------- Why a full `create or replace` ----------
--
-- Postgres has no way to amend a function body in place, so the whole definition
-- is restated. `20260829140000`'s own habit is repeated beneath it: the
-- `revoke`/`grant` pair and the `private.campaign_state_is_terminal` EXECUTE
-- grant are restated too. `create or replace function` **preserves** existing
-- privileges, so strictly neither is required; they are here because the next
-- person to replace this function will copy this file, and a file that silently
-- depends on a grant made two migrations ago is how `20260813130000` came to
-- exist as a correction to `20260813120000`.

create or replace function public.materialise_campaign(p_embed_id uuid)
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
  v_escrow     numeric(12, 2);
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

  -- **The second committer class, added by `20260904123000`
  -- ([ADR-0020](../../docs/40-adr/0020-the-ceiling-has-two-committer-classes.md)).**
  -- Escrow held against this project is authorised spend against the same
  -- ceiling: a node accepted a step and the owner's budget is what pays them.
  -- Counting only campaigns would let a project with its whole ceiling in escrow
  -- authorise a campaign for the whole ceiling again.
  --
  -- Under the SAME row lock taken above, which is what makes the two classes
  -- unable to race each other: `accept_offer` locks the same `projects` row
  -- before its own re-check, so an accept and an approval serialise rather than
  -- both reading a total the other is about to change.
  --
  -- `state = 'held'` only, mirroring the terminal filter on campaigns: a refunded
  -- hold commits nothing, exactly as a cancelled campaign does.
  select coalesce(sum(amount), 0) into v_escrow
  from public.escrow_holds
  where project_id = v_project
    and state = 'held';

  -- `>` and not `>=`: landing exactly on the ceiling is authorised, matching
  -- `checkSpendCap` exactly. This boundary is asserted in both directions in both
  -- suites, because an off-by-one here either refuses what the owner authorised
  -- or commits one unit more than they did.
  --
  -- **The message names both classes** rather than reporting one number. An owner
  -- refused for a total they cannot see in their campaign list would reasonably
  -- conclude the check was wrong; escrow is invisible on that list and has to be
  -- said out loud.
  if v_committed + v_escrow + v_cap > v_ceiling then
    raise exception
      'campaign would commit % against a ceiling of %, with % already committed to campaigns and % held in escrow',
      v_committed + v_escrow + v_cap, v_ceiling, v_committed, v_escrow
      using errcode = 'check_violation',
            hint = 'Lower the campaign budget, raise the project ceiling, or wait for escrow to settle.';
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
      'escrow_held_before', v_escrow,
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

-- Restated beneath the replace, `20260829140000:309-317`'s own habit. This
-- function is `security invoker`, so it needs the grant in its own right; without
-- it every commit fails with `permission denied for function` at the spend check.
grant execute on function private.campaign_state_is_terminal(public.campaign_state)
  to service_role;

comment on function public.materialise_campaign(uuid) is
  'Turn an approved campaign card into one campaigns row at state ready, in one '
  'transaction. Idempotent per card via campaigns.source_embed_id. Re-checks the '
  'project spend ceiling under a row lock against BOTH committer classes since '
  '20260904123000: non-terminal campaign caps and held escrow (ADR-0020). Closes '
  'the originating task when it is still waiting on the owner.';
