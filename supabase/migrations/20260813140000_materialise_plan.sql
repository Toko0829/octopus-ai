-- 20260813140000_materialise_plan.sql — approving a plan turns it into work.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md, docs/30-modules/chat-discord.md
--
-- The previous migration built the DAG's tables. Nothing wrote to them. This is
-- the step that does: approving a plan card creates a `projects` row and one
-- `tasks` row per step, which is what turns the card's `owner` field (AI / HUMAN
-- / YOU) from decoration into the thing the router will read.
--
-- Two properties this exists to guarantee, both of which application code cannot.
--
--   * **All of it, or none of it.** supabase-js has no transactions: it speaks
--     PostgREST, one statement per call. A project created without its tasks, or
--     with half of them, is a project the scheduler will happily call finished.
--     A function is one statement from the caller's side and one transaction from
--     the database's.
--
--   * **What was approved is what gets built.** The function reads the payload
--     from `action_embeds` itself rather than accepting a task list from the
--     caller. Passing the steps in would mean the rows materialised are whatever
--     the caller says they are, and the whole point of the card is that a person
--     read a specific plan and agreed to it.

-- Provenance, and the idempotency key.
--
-- The approve route already guards double submits with a conditional update, but
-- that guard protects the embed, not this. If materialising succeeded and then
-- anything downstream failed, a retry would otherwise build a second project from
-- the same card. Unique, so the second attempt cannot.
alter table public.projects
  add column source_embed_id uuid unique references public.action_embeds (id) on delete set null;

comment on column public.projects.source_embed_id is
  'The plan card this project was materialised from. Unique: one card, one project.';

create function public.materialise_plan(p_embed_id uuid)
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

  -- `active` rather than `planning`: planning is what just finished. Nothing
  -- dispatches yet because the scheduler does not exist, but that is a gap in our
  -- infrastructure and not a statement about this project's lifecycle.
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

      insert into public.tasks (
        project_id, title, detail, stage, owner_type, citations, position
      )
      values (
        v_project,
        v_step->>'title',
        v_step->>'detail',
        v_stage->>'stage',
        v_owner_t,
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

-- Callable by trusted server code only. It is in `public` because that is the
-- schema PostgREST exposes and supabase-js can only reach an RPC there, so the
-- containment has to come from the grant instead of from the schema.
--
-- SECURITY INVOKER, so it runs with the caller's privileges and cannot become a
-- way for a client to write rows it has no grant for. Combined with the revoke
-- below, `anon` and `authenticated` cannot call it at all, which is what keeps it
-- clear of advisor lints 0028 / 0029 (see 20260813130000, where exactly that was
-- got wrong).
revoke all on function public.materialise_plan(uuid) from public;
grant execute on function public.materialise_plan(uuid) to service_role;

comment on function public.materialise_plan(uuid) is
  'Turn an approved plan card into a project and its tasks, in one transaction. '
  'Idempotent per embed. Reads the payload itself so what was approved is what is built.';