-- 20260910120000_answer_question_slot.sql — an answer on a question card is one statement.
-- Owner doc: docs/30-modules/chat-discord.md
-- Also: docs/10-architecture/architecture.md, docs/10-architecture/data-model.md
--
-- A question card used to be answered by typing every answer into one chat
-- message, which a model then parsed back into slots. While the card was
-- pending it claimed every message the owner wrote for two hours, and two such
-- cards were found holding rooms for nearly two days, one having swallowed a
-- request its author meant as a new goal. Answers now arrive on the card, one
-- slot or one task at a time, through the embed action route.
--
-- **One slot per statement, under the row's own state check.** Two chips clicked
-- in the same second are two requests; if each read the payload, edited it and
-- wrote the whole thing back, the second write would drop the first answer and
-- nothing would say so. So the write is a single `UPDATE ... jsonb_set` that
-- replaces-or-appends the one slot it was given and touches nothing else, and it
-- is conditional on `state = 'pending'` in the same statement, exactly as the
-- verdict path's conditional update is. A miss returns null rather than raising,
-- because "this card is closed" is an answer the route turns into a 409, not a
-- fault.
--
-- **The functions validate their own input**, on the rule this seam follows
-- everywhere: unknown values raise rather than default. A slot name outside the
-- five the playbook defines, or an empty answer, is refused here even though the
-- route already checked it, because the row is what the planner reads and a
-- guard that lives only in TypeScript is not a guard on the row.
--
-- `security invoker` and executable by `service_role` only, as `apply_plan_diff`
-- is: the route has already read the card as the caller and checked the owner,
-- and a client that could call this directly could answer somebody else's
-- question. `action_embeds` keeps no client UPDATE policy, so the grant is the
-- whole control.

create function public.answer_question_slot(p_embed_id uuid, p_slot text, p_value text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_value   text := btrim(coalesce(p_value, ''));
  v_payload jsonb;
begin
  if p_slot not in ('icp', 'offer', 'target_metric', 'budget_band', 'timeline') then
    raise exception 'unknown intake slot: %', p_slot using errcode = '23514';
  end if;
  if length(v_value) = 0 or length(v_value) > 400 then
    raise exception 'an answer is 1 to 400 characters' using errcode = '23514';
  end if;

  update public.action_embeds
     set payload = jsonb_set(
       payload,
       '{slots}',
       (
         -- Every slot but this one, in the order they were stored, then this one
         -- marked as stated: a person's answer replaces a model's inference and
         -- an earlier answer of their own alike.
         select coalesce(jsonb_agg(s), '[]'::jsonb)
           from jsonb_array_elements(coalesce(payload -> 'slots', '[]'::jsonb)) as s
          where s ->> 'key' <> p_slot
       ) || jsonb_build_array(
         jsonb_build_object('key', p_slot, 'value', v_value, 'source', 'stated')
       ),
       true
     )
   where id = p_embed_id
     and component = 'question'
     and state = 'pending'
  returning payload into v_payload;

  -- Null when the card is not pending or not a question: the route reports that
  -- as "already acted on" rather than as an error, because it is one.
  return v_payload;
end $$;

revoke all on function public.answer_question_slot(uuid, text, text) from public;
grant execute on function public.answer_question_slot(uuid, text, text) to service_role;

comment on function public.answer_question_slot(uuid, text, text) is
  'Write one stated slot into a pending question card, replacing any earlier value '
  'for that slot. Returns the new payload, or null when the card is not pending.';

-- The plan's own questions, one answer per step. The task must be one this card
-- asked about: a task id outside `taskIds` finds no row and returns null, so the
-- route cannot be used to write an answer against a step the card never named.
create function public.answer_question_task(p_embed_id uuid, p_task_id uuid, p_value text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_value   text := btrim(coalesce(p_value, ''));
  v_payload jsonb;
begin
  if length(v_value) = 0 or length(v_value) > 400 then
    raise exception 'an answer is 1 to 400 characters' using errcode = '23514';
  end if;

  update public.action_embeds
     set payload = jsonb_set(
       payload,
       '{taskAnswers}',
       coalesce(payload -> 'taskAnswers', '{}'::jsonb)
         || jsonb_build_object(p_task_id::text, v_value),
       true
     )
   where id = p_embed_id
     and component = 'question'
     and state = 'pending'
     and payload ->> 'awaiting' = 'task_answers'
     and (payload -> 'taskIds') ? p_task_id::text
  returning payload into v_payload;

  return v_payload;
end $$;

revoke all on function public.answer_question_task(uuid, uuid, text) from public;
grant execute on function public.answer_question_task(uuid, uuid, text) to service_role;

comment on function public.answer_question_task(uuid, uuid, text) is
  'Record the owner''s answer for one task named on a pending task-answers card. '
  'Returns the new payload, or null when the card is not pending or never asked about the task.';
