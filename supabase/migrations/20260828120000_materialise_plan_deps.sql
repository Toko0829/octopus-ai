-- 20260828120000_materialise_plan_deps.sql — an approved plan brings its edges.
-- Owner doc: docs/30-modules/business-projects-workflow.md
-- Also: docs/10-architecture/data-model.md, docs/30-modules/ai-orchestrator.md
--
-- `task_deps`, its acyclicity trigger, `task_deps_satisfied` and
-- `private.tasks_ready` have all been live since 20260813120000, and **not one row
-- has ever been written to that table**. The reason is recorded in 20260813140000
-- and it was the right one at the time: the planner emitted stages and steps, so
-- the only edges available would have been inferred from stage order, and
-- inferring "strategy must finish before content" states a constraint nobody made.
-- An invented edge is worse than a missing one. A missing edge lets two things run
-- at once that perhaps should not have; an invented one stops work for a reason
-- that does not exist and that nobody reading the plan can trace.
--
-- So the DAG has been a flat list, every step dispatched by the first tick, and
-- the dependency machinery has been enforcing an empty set. The planner now states
-- dependencies (`PlanStep.id` / `PlanStep.depends_on`), and this carries them onto
-- the table that already knows how to enforce them.
--
-- **The function still infers nothing.** Every edge written here was stated by the
-- planner as one step consuming another's output. Stage order remains presentation.
--
-- Properties from the two migrations this replaces that must not be lost, and are
-- not: all of it or none of it (now including the edges, so a cycle takes the
-- project with it); what was approved is what gets built, the payload still read
-- from the card rather than accepted from a caller; idempotent per card; the risk
-- tier and acceptance criteria carried exactly as 20260816120000 carries them,
-- absent meaning `reversible` and present-but-unrecognised raising.
--
-- `create or replace` rewrites the whole body, so everything below is restated
-- unchanged apart from the id map in pass 1 and the new pass 2.

create or replace function public.materialise_plan(p_embed_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_embed   public.action_embeds;
  v_owner   uuid;
  v_project uuid;
  v_goal    text;
  v_stage   jsonb;
  v_step    jsonb;
  v_owner_t public.task_owner_type;
  v_risk_s  text;
  v_risk_t  public.task_risk_tier;
  v_pos     int := 0;
  v_task    uuid;
  -- step id -> task uuid, built in pass 1 and read in pass 2.
  --
  -- A jsonb object rather than a temp table: it is keyed on a string, it lives for
  -- the length of one statement, and a temp table on a pooled connection outlives
  -- the transaction that made it.
  v_ids     jsonb := '{}'::jsonb;
  v_step_id text;
  v_dep_id  text;
  v_dep_task uuid;
  v_edges   int := 0;
begin
  select * into v_embed from public.action_embeds where id = p_embed_id;
  if not found then
    raise exception 'embed % not found', p_embed_id using errcode = 'no_data_found';
  end if;

  if v_embed.component <> 'plan' then
    raise exception 'embed % is a %, not a plan', p_embed_id, v_embed.component
      using errcode = 'invalid_parameter_value';
  end if;

  -- Idempotent by provenance rather than by catching the unique violation, so a
  -- retry returns the project it already built instead of erroring at a caller
  -- that would then have to guess whether the work was done.
  select id into v_project from public.projects where source_embed_id = p_embed_id;
  if found then
    return v_project;
  end if;

  -- The room's owner owns the project. Null owner means nobody can approve
  -- (20260812130000 made that the safe default), so reaching here with one is a
  -- bug worth failing on rather than a project with no owner.
  select owner_id into v_owner from public.rooms where id = v_embed.room_id;
  if v_owner is null then
    raise exception 'room % has no owner; cannot own a project', v_embed.room_id
      using errcode = 'not_null_violation';
  end if;

  -- The goal in the person's words, falling back to the plan's title for cards
  -- written before the payload carried it. The fallback is a restatement by the
  -- model, which is worse than the real thing and much better than an empty goal.
  v_goal := coalesce(
    nullif(trim(v_embed.payload->>'goal'), ''),
    nullif(trim(v_embed.payload->>'title'), ''),
    'Untitled goal'
  );

  -- `active` rather than `planning`: planning is what just finished.
  insert into public.projects (owner_id, goal, status, source_embed_id)
  values (v_owner, v_goal, 'active', p_embed_id)
  returning id into v_project;

  -- Link the room to the project. Guarded on being unset, so a room that already
  -- belongs to a project is not silently reassigned by approving a second plan.
  update public.rooms
  set project_id = v_project
  where id = v_embed.room_id and project_id is null;

  -- ---------- Pass 1: the tasks ----------
  --
  -- Unchanged from 20260816120000 except for recording each step's id against the
  -- task it became. A step with no `id` never enters the map, which is exactly
  -- what makes a card written before this migration behave as it always did: no
  -- ids, so nothing to resolve against, so no edges.
  for v_stage in select * from jsonb_array_elements(v_embed.payload->'stages') loop
    for v_step in select * from jsonb_array_elements(v_stage->'steps') loop
      -- The wire spells the owner for a reader (AI / HUMAN / YOU); storage spells
      -- it for a database. An unrecognised value raises rather than defaulting,
      -- because defaulting would silently route a task meant for a person to the
      -- AI, and that is the one direction this mapping must never fail in.
      v_owner_t := case v_step->>'owner'
        when 'AI'    then 'ai'::public.task_owner_type
        when 'HUMAN' then 'human'::public.task_owner_type
        when 'YOU'   then 'user'::public.task_owner_type
      end;
      if v_owner_t is null then
        raise exception 'step "%" has unknown owner %', v_step->>'title', v_step->>'owner'
          using errcode = 'invalid_parameter_value';
      end if;

      -- Absent is a card older than this field, and it lands where those cards
      -- already landed. Present-but-unrecognised is a different thing entirely and
      -- raises, on the same reasoning as the owner mapping above: a step whose
      -- tier we cannot read is a step we cannot say is safe to run unattended.
      v_risk_s := coalesce(nullif(trim(v_step->>'riskTier'), ''), 'reversible');
      v_risk_t := case v_risk_s
        when 'read_only'  then 'read_only'::public.task_risk_tier
        when 'reversible' then 'reversible'::public.task_risk_tier
        when 'external'   then 'external'::public.task_risk_tier
        when 'high_risk'  then 'high_risk'::public.task_risk_tier
      end;
      if v_risk_t is null then
        raise exception 'step "%" has unknown risk tier %', v_step->>'title', v_risk_s
          using errcode = 'invalid_parameter_value';
      end if;

      insert into public.tasks (
        project_id, title, detail, stage, owner_type, risk_tier,
        acceptance_criteria, citations, position
      )
      values (
        v_project,
        v_step->>'title',
        v_step->>'detail',
        v_stage->>'stage',
        v_owner_t,
        v_risk_t,
        -- An older card has no criteria, and an empty list says that honestly.
        -- Coerced to an array rather than stored as whatever the payload held, so
        -- a reader never has to ask which shape a given row is.
        case
          when jsonb_typeof(v_step->'acceptanceCriteria') = 'array'
            then v_step->'acceptanceCriteria'
          else '[]'::jsonb
        end,
        coalesce(
          (select array_agg(c::int) from jsonb_array_elements_text(v_step->'citations') as c),
          '{}'::int[]
        ),
        v_pos
      )
      returning id into v_task;

      v_step_id := nullif(trim(v_step->>'id'), '');
      if v_step_id is not null then
        -- Two steps claiming one id would make any edge naming it bind to
        -- whichever was written last, which is an edge pointing somewhere nobody
        -- chose. The reasoning core drops every edge rather than emit this, so
        -- reaching here means a card that came from somewhere else.
        if v_ids ? v_step_id then
          raise exception 'plan % has two steps with id "%"', p_embed_id, v_step_id
            using errcode = 'invalid_parameter_value',
                  hint = 'A step id must name exactly one step within its plan.';
        end if;
        v_ids := v_ids || jsonb_build_object(v_step_id, v_task);
      end if;

      v_pos := v_pos + 1;
    end loop;
  end loop;

  -- A plan with no steps is a refusal wearing a card's clothing, and `parse_plan`
  -- in the reasoning core already rejects one. Checked again here because a
  -- project with no tasks can never advance and nothing downstream would say why.
  if v_pos = 0 then
    raise exception 'plan % has no steps; refusing to create an empty project', p_embed_id
      using errcode = 'check_violation';
  end if;

  -- ---------- Pass 2: the edges ----------
  --
  -- Separate from pass 1 because a step may depend on one written after it. The
  -- plan is ordered for a reader and nothing requires a dependency to appear
  -- first, so resolving edges as tasks were created would fail a legal plan on
  -- presentation order alone.
  --
  -- Every edge is `hard`. The planner states one relationship, "this step consumes
  -- that step's output", and that is what hard means. `soft` and `resource` exist
  -- in the enum for orderings and shared constraints nothing produces yet, and
  -- choosing between them here would mean guessing which the model meant.
  for v_stage in select * from jsonb_array_elements(v_embed.payload->'stages') loop
    for v_step in select * from jsonb_array_elements(v_stage->'steps') loop
      v_step_id := nullif(trim(v_step->>'id'), '');
      continue when v_step_id is null;
      continue when jsonb_typeof(v_step->'dependsOn') <> 'array';

      v_task := (v_ids->>v_step_id)::uuid;

      for v_dep_id in
        select * from jsonb_array_elements_text(v_step->'dependsOn')
      loop
        -- Raise rather than skip. The reasoning core has already dropped every
        -- reference it could not resolve, on the argument that a missing edge is
        -- the safe direction and that refusing a whole plan over one bad string is
        -- not. By the time a card reaches here that repair has happened, so an
        -- unresolvable reference means the card was built by something else: an
        -- older service, a replay, a hand edit. Guessing on behalf of an unknown
        -- producer is how an invented edge gets in, and this is the layer that
        -- outlives whichever runner is current (20260813120000's argument).
        v_dep_task := (v_ids->>v_dep_id)::uuid;
        if v_dep_task is null then
          raise exception 'step "%" depends on "%", which names no step in plan %',
            v_step->>'title', v_dep_id, p_embed_id
            using errcode = 'invalid_parameter_value',
                  hint = 'A dependency names a step id from the same plan card.';
        end if;

        -- Self-edges are refused by `task_deps_no_self` and cycles by
        -- `task_deps_guard_acyclic`, both from 20260813120000, and neither is
        -- re-checked here on purpose: one definition of the DAG's shape, and it is
        -- the one that also defends every other writer. Either raises inside this
        -- transaction, so the project and its tasks go with it.
        insert into public.task_deps (task_id, depends_on_task_id, dep_kind)
        values (v_task, v_dep_task, 'hard')
        on conflict do nothing;
      end loop;
    end loop;
  end loop;

  -- Counted from the table rather than from the loop, because `on conflict do
  -- nothing` means a card listing one dependency twice writes a single row and an
  -- incremented counter would report two.
  select count(*) into v_edges
  from public.task_deps d
  join public.tasks t on t.id = d.task_id
  where t.project_id = v_project;

  insert into public.events (
    project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload
  )
  values (
    v_project,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind
         else 'user'::public.author_kind end,
    'project.materialised',
    'project',
    v_project,
    jsonb_build_object(
      'embed_id', p_embed_id,
      'room_id', v_embed.room_id,
      'tasks', v_pos,
      -- Recorded because "this plan ran everything at once" and "this plan had no
      -- edges" look identical from outside, and after the fact only this number
      -- tells them apart.
      'edges', v_edges
    )
  );

  return v_project;
end;
$$;

-- `create or replace` keeps the existing ACL, so these two lines change nothing
-- today and are restated anyway: this containment is the only reason a function in
-- `public` (the schema PostgREST publishes) is not an open RPC endpoint, and a
-- future editor who reaches for `drop function` would silently lose it. Cheap to
-- assert, expensive to rediscover.
revoke all on function public.materialise_plan(uuid) from public;
grant execute on function public.materialise_plan(uuid) to service_role;

comment on function public.materialise_plan(uuid) is
  'Turn an approved plan card into a project, its tasks, and the hard dependency '
  'edges the planner stated, in one transaction. Idempotent per embed. Reads the '
  'payload itself so what was approved is what is built. Carries the step''s risk '
  'tier onto the row, which is what the router reads. Infers no edge from stage order.';
