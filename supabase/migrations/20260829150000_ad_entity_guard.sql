-- 20260829150000_ad_entity_guard.sql — the ad tree gets its state machine.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md
--
-- `20260829122000` landed `ad_entities` with a hierarchy guard and no lifecycle
-- guard at all, which was right then and is not right now: that table had no
-- writer, and a state machine enforcing transitions nobody could make is the
-- `task_deps` defect this repository has already paid for twice. The publish
-- executor is its first writer, so the guard lands in the same change as the
-- writer rather than after it.
--
-- Two triggers, because they answer two different questions and one `when`
-- clause cannot carry both.
--
-- The first is the lifecycle, in the shape `campaigns` and `tasks` already use: a
-- map, a BEFORE UPDATE trigger that consults it, and the audit event written by
-- that same trigger so a transition cannot be recorded without having happened
-- and cannot happen without being recorded.
--
-- The second makes `external_id` write-once. That column has carried the phrase
-- "written exactly once" as a comment since it was created, and a comment is not
-- enforcement. Overwriting it orphans a live object that is still spending, with
-- nothing left in our database pointing at it, which is the worst row-level
-- outcome available in this domain.

-- ---------- The lifecycle ----------

-- `archived` and `failed` are the ends of the line. **`rejected` is deliberately
-- NOT terminal**, and that is the line here worth reading twice: a platform
-- disapproving an entity is a verdict on that entity, and the module rule is
-- revise-and-resubmit. Revising produces a NEW entity, so the disapproved one is
-- closed out (`archived`) rather than resurrected. Making `rejected` terminal
-- would leave a row stuck forever in a state that reads like a question nobody
-- answered.
create function private.ad_entity_state_is_terminal(s public.ad_entity_state)
returns boolean
language sql
immutable
set search_path = public
as $$
  select s in ('archived', 'failed');
$$;

-- The map. Terminal is checked first so no arc can resurrect an archived entity,
-- which is the ordering `task_transition_allowed` and
-- `campaign_transition_allowed` both use for the same reason.
create function private.ad_entity_transition_allowed(
  p_from public.ad_entity_state,
  p_to   public.ad_entity_state
)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  if private.ad_entity_state_is_terminal(p_from) then
    return false;
  end if;

  return case p_from
    -- Written but not sent. `archived` is the exit for an entity abandoned
    -- before anything reached a platform.
    when 'draft'      then p_to in ('publishing', 'archived')
    -- The three answers a platform can give: it worked, it was refused on
    -- policy, or the call failed. Nothing else leaves `publishing`, for the
    -- reason the campaign machine gives: a request in flight has not been
    -- cancelled, it has been sent.
    when 'publishing' then p_to in ('live', 'failed', 'rejected')
    -- A platform can disapprove an entity that is already running, which is why
    -- `rejected` is reachable from here and not only from `publishing`.
    when 'live'       then p_to in ('paused', 'rejected', 'archived')
    when 'paused'     then p_to in ('live', 'archived')
    -- Revise-and-resubmit means a new entity. This one gets closed out.
    when 'rejected'   then p_to in ('archived')
    else false
  end;
end;
$$;

-- Validate, stamp, record. One trigger for all three so an audit entry cannot be
-- forgotten by a caller and cannot describe a transition that did not happen.
--
-- SECURITY DEFINER with a pinned `search_path`, which is the `20260815200000`
-- lesson rather than a preference: a guard meant to bind trusted code must not
-- depend on that code holding EXECUTE on the guard's internals. It is also what
-- lets the two helpers above stay granted to nobody at all.
create function private.guard_ad_entity_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.ad_entity_transition_allowed(old.state, new.state) then
    raise exception
      'illegal ad entity transition % -> % for % %',
      old.state, new.state, old.kind, old.id
      using errcode = 'check_violation',
            hint = 'See the ad entity lifecycle in docs/30-modules/marketing-growth-engine.md.';
  end if;

  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    new.project_id,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'ad_entity.transitioned',
    'ad_entity',
    new.id,
    jsonb_build_object(
      'from', old.state,
      'to', new.state,
      'kind', new.kind,
      'campaign_id', new.campaign_id,
      -- Carried because "which object at the platform did this become" is the
      -- question anyone reading this log has, and the id is written in the same
      -- statement as the transition that confirms it.
      'external_id', new.external_id
    )
  );

  return new;
end;
$$;

-- ---------- `external_id` is written once ----------
--
-- A separate trigger rather than three lines inside the one above, because the
-- two bind on different conditions. The lifecycle guard fires only on a state
-- change; write-once has to hold on EVERY update, including the ones that touch
-- no state at all. Folding it in would have left the hole exactly where somebody
-- eventually writes a plain `update ... set external_id = ...`.
--
-- The `when` clause is the whole check, which is what makes the resume path free:
-- a publisher re-driving a crashed publish writes the SAME id back, and an
-- identical value is not a change, so this never fires on it.
create function private.guard_ad_entity_external_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception
    'ad entity % already carries external id %; refusing to change it',
    old.id, old.external_id
    using errcode = 'check_violation',
          hint = 'Overwriting a published id orphans a live object that is still spending.';
end;
$$;

revoke all on function private.ad_entity_state_is_terminal(public.ad_entity_state) from public;
revoke all on function private.ad_entity_transition_allowed(public.ad_entity_state, public.ad_entity_state) from public;
revoke all on function private.guard_ad_entity_transition() from public;
revoke all on function private.guard_ad_entity_external_id() from public;

-- `when` matters here for the same reason it does on `campaigns` and on `tasks`:
-- without it every ordinary edit would be validated as a transition from a state
-- to itself, which the map correctly refuses.
create trigger ad_entities_guard_transition
  before update on public.ad_entities
  for each row
  when (old.state is distinct from new.state)
  execute function private.guard_ad_entity_transition();

create trigger ad_entities_guard_external_id
  before update on public.ad_entities
  for each row
  when (old.external_id is not null and new.external_id is distinct from old.external_id)
  execute function private.guard_ad_entity_external_id();

-- Nothing restricts the state an INSERT may choose, deliberately, and that
-- matches `campaigns` (`materialise_campaign` inserts at `ready`, never at
-- `draft`). The publisher writes its intent row at `publishing` in one statement
-- rather than inserting a draft and immediately transitioning it, which would put
-- a row in the audit trail describing a state the system was never in. Only
-- `service_role` can insert at all.

comment on function private.ad_entity_transition_allowed(public.ad_entity_state, public.ad_entity_state) is
  'The ad entity lifecycle. `rejected` is not terminal: revise-and-resubmit makes a new '
  'entity and the disapproved one is archived.';

comment on function private.guard_ad_entity_external_id() is
  'Makes `external_id` write-once. Fires only when a non-null id would change, so a '
  'republish writing the same id back is not refused.';

comment on column public.ad_entities.external_id is
  'The platform''s own id. Null until published, and written exactly once, enforced by '
  'ad_entities_guard_external_id (20260829150000): overwriting it orphans a live object '
  'that is still spending.';
