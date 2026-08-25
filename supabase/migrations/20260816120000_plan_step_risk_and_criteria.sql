-- 20260816120000_plan_step_risk_and_criteria.sql — the router's first rule has
-- never been able to fire, because nothing has ever written the column it reads.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md
--
-- `packages/core/src/router.ts` sends a `high_risk` task to `needs_user` whatever
-- the plan said its owner was. That is AGENTS.md rules 7 and 11 applied to the
-- router, and `20260813120000` says so on the column itself: "carried on the task
-- so the router can refuse to auto-run something irreversible without asking".
-- The rule is implemented and tested.
--
-- `20260813140000` inserts seven columns and `risk_tier` is not one of them, so
-- **every task ever materialised from a plan card has taken the default
-- `reversible`**, and the rule has been unreachable since the day it shipped.
-- `acceptance_criteria` is the same story: never written, so every task carries an
-- empty object and the marketplace's maker-checker would have nothing to check a
-- node's proof against.
--
-- Costless today and not for much longer. The only thing an AI task can currently
-- do is write prose. The next milestone adds `connect_channel`, `create_campaign`,
-- `publish_content` and `set_budget`, at which point the first line of defence
-- against a planner handing one of those to the AI is a column nothing populates.
--
-- **Absent and unrecognised are treated differently, on purpose.** Cards written
-- before this change carry no tier; absent means `reversible`, which is exactly
-- what they already materialised as, so nothing regresses and no old card breaks.
-- A tier that is present and unrecognised raises, exactly like the owner mapping
-- beside it and for the same reason: defaulting a step somebody labelled
-- dangerous down to reversible is the one direction this must never fail in.
--
-- `create or replace` rewrites the whole body, so everything below is restated
-- unchanged apart from the two new columns in the insert and the tier mapping
-- above it.

-- The column defaults to an empty *object* while every writer and reader wants a
-- list of statements. Corrected here rather than left for the maker-checker to
-- trip over: a shape mismatch that no current code reads is exactly the kind that
-- survives until something depends on it.
alter table public.tasks
  alter column acceptance_criteria set default '[]'::jsonb;

comment on column public.tasks.acceptance_criteria is
  'Checkable statements about what the finished work must contain, as a JSON array. '
  'Written from the plan card; read by the maker-checker when the marketplace lands.';

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
      );
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

  -- NO task_deps are written, deliberately. The planner returns stages and steps,
  -- not dependencies, and inferring "strategy must finish before content" from
  -- the stage order would be inventing a constraint nobody stated. An invented
  -- edge is worse than a missing one: a missing edge lets things run in parallel
  -- that maybe should not, while an invented one blocks work for a reason that
  -- does not exist and cannot be traced to anything. Edges arrive when the
  -- planner emits them.

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
    jsonb_build_object('embed_id', p_embed_id, 'room_id', v_embed.room_id, 'tasks', v_pos)
  );

  return v_project;
end;
$$;

-- `create or replace` keeps the existing ACL, so these two lines change nothing
-- today and are restated anyway: this containment is the only reason a function
-- in `public` (the schema PostgREST publishes) is not an open RPC endpoint, and a
-- future editor who reaches for `drop function` would silently lose it. Cheap to
-- assert, expensive to rediscover. See 20260813140000, and 20260813130000 for the
-- 0028 / 0029 lint this avoids.
revoke all on function public.materialise_plan(uuid) from public;
grant execute on function public.materialise_plan(uuid) to service_role;

comment on function public.materialise_plan(uuid) is
  'Turn an approved plan card into a project and its tasks, in one transaction. '
  'Idempotent per embed. Reads the payload itself so what was approved is what is built. '
  'Carries the step''s risk tier onto the row, which is what the router reads.';
