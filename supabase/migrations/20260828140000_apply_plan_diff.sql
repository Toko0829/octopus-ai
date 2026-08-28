-- 20260828140000_apply_plan_diff.sql — approving a diff changes the running plan.
-- Owner doc: docs/30-modules/business-projects-workflow.md
-- Also: docs/10-architecture/data-model.md, docs/30-modules/ai-orchestrator.md
--
-- `materialise_plan`'s sibling, and built from the same four properties for the
-- same four reasons.
--
--   * **All of it, or none of it.** A diff is several changes that only make
--     sense together: cancelling a step and adding its replacement is one
--     decision, and applying half of it leaves a project in a state nobody chose.
--     supabase-js has no transactions, so this is a function.
--   * **What was approved is what gets applied.** The ops are read out of the
--     card rather than accepted from the caller.
--   * **Idempotent per card.** `plan_diffs` is keyed on the embed, so a retry
--     after a downstream failure cannot add the same steps twice. The approve
--     route's conditional update guards the embed, not this: exactly the argument
--     `20260813140000` makes for `projects.source_embed_id`.
--   * **Unknown values raise rather than defaulting**, as everywhere in this
--     seam. An op we cannot read is not an op we may guess at.
--
-- **A stale diff fails rather than half-applying**, which is the property most
-- worth stating. The card was written against the project as it was; by the time
-- somebody approves it a task may have been approved, failed or cancelled. An op
-- naming such a task raises, the transaction rolls back, and the owner replans
-- against what is actually there. The alternative, skipping the impossible ops,
-- would apply a diff nobody reviewed.

-- Provenance, and the idempotency key.
--
-- A table rather than a column, because a project legitimately has many diffs
-- over its life while `projects.source_embed_id` is one card, once. Append-only
-- by grant for the same reason `events` is: a record of what was applied that can
-- be rewritten afterwards is not a record.
create table public.plan_diffs (
  embed_id   uuid primary key references public.action_embeds (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  ops        int not null,
  applied_at timestamptz not null default now()
);

create index plan_diffs_project_idx on public.plan_diffs (project_id, applied_at desc);

alter table public.plan_diffs enable row level security;

-- No client select policy, matching `events`. What a member needs to see is the
-- card, which is already readable through room membership and which is the thing
-- they actually approved; this table answers "was it applied", which is an
-- operational question for the audit console (Phase 3).
grant all on public.plan_diffs to service_role;
revoke update, delete, truncate on public.plan_diffs from service_role;

comment on table public.plan_diffs is
  'One row per applied replan card. Append-only provenance: a retry after a '
  'downstream failure finds the row and applies nothing.';

create function public.apply_plan_diff(p_embed_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_embed    public.action_embeds;
  v_project  uuid;
  v_card_room uuid;
  v_status   public.project_status;
  v_op       jsonb;
  v_task     uuid;
  v_state    public.task_state;
  v_owner_t  public.task_owner_type;
  v_risk_s   text;
  v_risk_t   public.task_risk_tier;
  v_pos      int;
  v_ids      jsonb := '{}'::jsonb;
  v_step_id  text;
  v_ref      text;
  v_dep      uuid;
  v_count    int := 0;
begin
  select * into v_embed from public.action_embeds where id = p_embed_id;
  if not found then
    raise exception 'embed % not found', p_embed_id using errcode = 'no_data_found';
  end if;

  if v_embed.component <> 'replan' then
    raise exception 'embed % is a %, not a replan', p_embed_id, v_embed.component
      using errcode = 'invalid_parameter_value';
  end if;

  select project_id into v_project from public.plan_diffs where embed_id = p_embed_id;
  if found then
    return v_project;
  end if;

  v_project := nullif(trim(v_embed.payload->>'projectId'), '')::uuid;
  if v_project is null then
    raise exception 'replan card % names no project', p_embed_id
      using errcode = 'invalid_parameter_value';
  end if;

  select status into v_status from public.projects where id = v_project;
  if not found then
    raise exception 'project % not found', v_project using errcode = 'no_data_found';
  end if;
  if v_status in ('completed', 'cancelled') then
    raise exception 'project % is %; a finished project is not replanned', v_project, v_status
      using errcode = 'check_violation';
  end if;

  -- Tenancy. The card is posted in a room; the project belongs to the room of the
  -- plan card it was created from (`20260827110000`'s resolution, never
  -- `rooms.project_id`, which the first project in a room claims forever). A
  -- replan card in one room must not be able to rewrite another room's project,
  -- and nothing else on this path checks that: the action route verifies the
  -- caller's membership of the card's room, which says nothing about the project
  -- the payload names.
  select a.room_id into v_card_room
  from public.projects p
  join public.action_embeds a on a.id = p.source_embed_id
  where p.id = v_project;

  if v_card_room is null or v_card_room <> v_embed.room_id then
    raise exception 'replan card % belongs to room %, but project % does not',
      p_embed_id, v_embed.room_id, v_project
      using errcode = 'insufficient_privilege',
            hint = 'A diff may only change a project of the room its card was posted in.';
  end if;

  select coalesce(max(position), -1) + 1 into v_pos
  from public.tasks where project_id = v_project;

  -- ---------- Pass 1: cancels, modifies, adds ----------
  --
  -- In the order the card presents them, so the audit trail reads the way the
  -- person read the card.
  for v_op in select * from jsonb_array_elements(v_embed.payload->'ops') loop
    v_count := v_count + 1;

    if v_op->>'op' = 'add_step' then
      v_owner_t := case v_op->>'owner'
        when 'AI'    then 'ai'::public.task_owner_type
        when 'HUMAN' then 'human'::public.task_owner_type
        when 'YOU'   then 'user'::public.task_owner_type
      end;
      if v_owner_t is null then
        raise exception 'added step "%" has unknown owner %', v_op->>'title', v_op->>'owner'
          using errcode = 'invalid_parameter_value';
      end if;

      v_risk_s := coalesce(nullif(trim(v_op->>'riskTier'), ''), 'reversible');
      v_risk_t := case v_risk_s
        when 'read_only'  then 'read_only'::public.task_risk_tier
        when 'reversible' then 'reversible'::public.task_risk_tier
        when 'external'   then 'external'::public.task_risk_tier
        when 'high_risk'  then 'high_risk'::public.task_risk_tier
      end;
      if v_risk_t is null then
        raise exception 'added step "%" has unknown risk tier %', v_op->>'title', v_risk_s
          using errcode = 'invalid_parameter_value';
      end if;

      insert into public.tasks (
        project_id, title, detail, stage, owner_type, risk_tier,
        acceptance_criteria, citations, position
      )
      values (
        v_project,
        v_op->>'title',
        v_op->>'detail',
        v_op->>'stage',
        v_owner_t,
        v_risk_t,
        case
          when jsonb_typeof(v_op->'acceptanceCriteria') = 'array' then v_op->'acceptanceCriteria'
          else '[]'::jsonb
        end,
        coalesce(
          (select array_agg(c::int) from jsonb_array_elements_text(v_op->'citations') as c),
          '{}'::int[]
        ),
        v_pos
      )
      returning id into v_task;

      v_step_id := nullif(trim(v_op->>'id'), '');
      if v_step_id is not null then
        if v_ids ? v_step_id then
          raise exception 'diff % adds two steps with id "%"', p_embed_id, v_step_id
            using errcode = 'invalid_parameter_value';
        end if;
        v_ids := v_ids || jsonb_build_object(v_step_id, v_task);
      end if;

      v_pos := v_pos + 1;

      insert into public.events (
        project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
      )
      values (
        v_project, auth.uid(),
        case when auth.uid() is null then 'system'::public.author_kind
             else 'user'::public.author_kind end,
        'task.replan_added', 'task', v_task,
        jsonb_build_object('embed_id', p_embed_id, 'title', v_op->>'title')
      );

    elsif v_op->>'op' in ('cancel_task', 'modify_task') then
      v_task := nullif(trim(v_op->>'taskId'), '')::uuid;
      if v_task is null then
        raise exception '% op on diff % names no task', v_op->>'op', p_embed_id
          using errcode = 'invalid_parameter_value';
      end if;

      select state into v_state
      from public.tasks where id = v_task and project_id = v_project;
      if not found then
        raise exception 'task % is not a step of project %', v_task, v_project
          using errcode = 'invalid_parameter_value',
                hint = 'A diff may only change steps of the project it names.';
      end if;

      -- The stale-diff guard. `approved` and later is work that has been
      -- accepted, and terminal is work that has stopped; a card written before
      -- either happened is describing a project that no longer exists.
      if v_state in ('approved', 'payout_pending', 'paid', 'done', 'failed', 'cancelled') then
        raise exception 'task % is %, and this diff was written before that', v_task, v_state
          using errcode = 'check_violation',
                hint = 'Replan again against the project as it is now.';
      end if;

      if v_op->>'op' = 'cancel_task' then
        -- The state machine's own guard runs on this update and writes its own
        -- `task.transitioned` event; this one records WHY, which the transition
        -- cannot know.
        update public.tasks set state = 'cancelled' where id = v_task;

        insert into public.events (
          project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
        )
        values (
          v_project, auth.uid(),
          case when auth.uid() is null then 'system'::public.author_kind
               else 'user'::public.author_kind end,
          'task.replan_cancelled', 'task', v_task,
          jsonb_build_object('embed_id', p_embed_id, 'reason', v_op->>'reason')
        );
      else
        -- Three fields, and the omissions are the safety property. State, owner
        -- and risk tier are not updatable here at all: changing who runs a step or
        -- what it may touch is a different piece of work, and routing that through
        -- the op that looks least like an authorisation decision is what rules 7
        -- and 11 forbid. Expressed as columns this statement does not name, so
        -- there is no flag anybody can pass to widen it.
        update public.tasks
        set detail = coalesce(nullif(trim(v_op->>'detail'), ''), detail),
            acceptance_criteria = case
              when jsonb_typeof(v_op->'acceptanceCriteria') = 'array'
                then v_op->'acceptanceCriteria'
              else acceptance_criteria
            end,
            updated_at = now()
        where id = v_task;

        insert into public.events (
          project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
        )
        values (
          v_project, auth.uid(),
          case when auth.uid() is null then 'system'::public.author_kind
               else 'user'::public.author_kind end,
          'task.replan_modified', 'task', v_task,
          jsonb_build_object('embed_id', p_embed_id)
        );
      end if;

    else
      raise exception 'diff % carries an unknown op "%"', p_embed_id, v_op->>'op'
        using errcode = 'invalid_parameter_value',
              hint = 'Known ops are add_step, cancel_task and modify_task.';
    end if;
  end loop;

  if v_count = 0 then
    raise exception 'diff % has no ops; refusing to record an empty change', p_embed_id
      using errcode = 'check_violation';
  end if;

  -- ---------- Pass 2: the edges ----------
  --
  -- Separate for `materialise_plan`'s reason: an op may depend on a step added
  -- after it in the list. A reference resolves against the steps this diff added,
  -- by their card-local id, or against the project's existing tasks, by UUID.
  for v_op in select * from jsonb_array_elements(v_embed.payload->'ops') loop
    if v_op->>'op' = 'add_step' then
      v_task := (v_ids->>nullif(trim(v_op->>'id'), ''))::uuid;
    elsif v_op->>'op' = 'modify_task' then
      v_task := (v_op->>'taskId')::uuid;
    else
      continue;
    end if;

    -- An add_step with no id cannot be depended upon and has nothing to hang an
    -- edge from. Skipped rather than raised: the step itself was inserted fine.
    continue when v_task is null;

    for v_ref in
      select *
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_op->'dependsOn') = 'array' then v_op->'dependsOn'
          when jsonb_typeof(v_op->'addDependsOn') = 'array' then v_op->'addDependsOn'
          else '[]'::jsonb
        end
      )
    loop
      v_dep := (v_ids->>v_ref)::uuid;

      if v_dep is null then
        -- Not a step this diff added, so it must name an existing task of THIS
        -- project. Verified rather than trusted: a task id from another project
        -- would otherwise make a cross-project edge, which the trigger refuses,
        -- but only after this function has already decided the reference was fine.
        --
        -- The cast is guarded because a reference is an arbitrary string off a
        -- card. `v_ref::uuid` on something that is not one raises a bare
        -- `invalid_text_representation`, which would surface to the owner as a
        -- type error instead of as "that names no step".
        begin
          v_dep := v_ref::uuid;
        exception when others then
          v_dep := null;
        end;

        if v_dep is not null and not exists (
          select 1 from public.tasks where id = v_dep and project_id = v_project
        ) then
          v_dep := null;
        end if;
      end if;

      if v_dep is null then
        raise exception 'diff % depends on "%", which names no step of this project',
          p_embed_id, v_ref
          using errcode = 'invalid_parameter_value';
      end if;

      -- Self-edges and cycles are refused by the constraint and the trigger from
      -- 20260813120000. Not re-checked here: one definition of the DAG's shape,
      -- and it is the one that defends every writer rather than this one.
      insert into public.task_deps (task_id, depends_on_task_id, dep_kind)
      values (v_task, v_dep, 'hard')
      on conflict do nothing;
    end loop;
  end loop;

  insert into public.plan_diffs (embed_id, project_id, ops)
  values (p_embed_id, v_project, v_count);

  insert into public.events (
    project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
  )
  values (
    v_project, auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind
         else 'user'::public.author_kind end,
    'project.replanned', 'project', v_project,
    jsonb_build_object('embed_id', p_embed_id, 'ops', v_count)
  );

  return v_project;
end;
$$;

revoke all on function public.apply_plan_diff(uuid) from public;
grant execute on function public.apply_plan_diff(uuid) to service_role;

comment on function public.apply_plan_diff(uuid) is
  'Apply an approved replan card to its project, in one transaction. Idempotent '
  'per card. Reads the ops from the card itself. Raises on an op naming work that '
  'has since been approved or stopped, so a stale diff fails rather than half-applying.';
