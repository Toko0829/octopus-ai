-- 20260902120000_node_kyc_transition_map.sql — the map that was deferred until
-- there was a writer whose transitions could be wrong, arriving with that writer.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/10-architecture/security-compliance.md
--
-- `20260831120000:252-268` landed the audit half of `private.guard_node_kyc_audit`
-- and deliberately not the lifecycle map, on the rule that "a guard lands here if
-- and only if it is decidable from the row in front of it". A structural
-- invariant needs no writer's cooperation to be right; a lifecycle map is only
-- correct with respect to a sequence a writer drives, and landing one for
-- transitions nobody can make is the `task_deps` defect. It named this slice, and
-- it named where the map goes: **into this same function, beside the insert
-- rather than instead of it**, "because the house rule is one trigger for both so
-- that an audit entry cannot be forgotten by a caller and cannot describe a
-- transition that did not happen."
--
-- So the trigger is untouched. Its `when (old.kyc_status is distinct from
-- new.kyc_status)` clause still decides when this runs, and the same function now
-- refuses before it records. An illegal arc raises rather than writing an event
-- that describes it.
--
-- **Only the arcs this slice's writer can make land.** `decide_node_kyc`
-- (`20260902122000`) and the submit route are the whole set of callers, and
-- between them they produce five transitions. Nothing here touches `suspended`,
-- and that absence is the same discipline the deferred map was: suspension has no
-- writer until an ops console exists (Phase 3, docs/30-modules/admin-ops.md), and
-- permitting a transition nobody can make is the defect this file exists to
-- avoid repeating. `node_profiles_suspended_has_reason` stays as an unreachable
-- structural constraint, which is fine and is exactly the split above: a
-- constraint is decidable from the row, a map is not.
--
-- **No `kyc_status` is terminal.** `rejected` reads as one and is not: a person
-- whose document was blurred resubmits, and a lifecycle with no way back is the
-- dead-end shape this repository has recorded five times. Offboarding is
-- `availability`, not `kyc_status`, which is why `20260831120000:57-59` refused a
-- `expired` value here.
--
-- **The trigger binds `service_role` too**, because a trigger is not a grant.
-- That is the point rather than an inconvenience: `decide_node_kyc` runs as
-- `service_role` and cannot route around this map, so the only way to reach an
-- illegal status is to change this file in a diff somebody reads.
--
-- On the trap recorded at `20260831120000:102-105`: Postgres does not re-validate
-- an existing CHECK when a function it calls changes. Nothing here is called from
-- a CHECK -- this is a trigger function and a helper only it calls -- so no
-- constraint needs revalidating. Written down so the next person editing a
-- function in this domain does not have to re-derive which case they are in.

-- ---------- The map ----------
--
-- A separate helper rather than a `case` inlined in the trigger, matching
-- `private.task_transition_allowed`, `private.campaign_transition_allowed` and
-- `private.ad_entity_transition_allowed`. The reason is the same in all four: a
-- suite can assert the map directly, one arc per assertion, without writing a row
-- and without arranging the fixture each arc would otherwise need.

create function private.node_kyc_transition_allowed(
  p_from public.kyc_status,
  p_to   public.kyc_status
) returns boolean
language sql
immutable
set search_path = public
as $$
  select case p_from
    -- Invited, and nothing asked of a provider yet. The node submits.
    when 'unverified' then p_to = 'pending'

    -- We asked and are waiting. Three answers, and `unverified` is the third:
    -- an inconclusive or errored check is not a refusal, so it returns the node
    -- to the start with a way forward rather than parking them in a status whose
    -- only exit is a resubmission we have not offered.
    when 'pending' then p_to in ('verified', 'rejected', 'unverified')

    -- A refusal is appealable by resubmitting. Not terminal, deliberately.
    when 'rejected' then p_to = 'pending'

    -- `verified` and `suspended` have no outward arc in this slice, because
    -- nothing can make one. Both gain theirs from the writer that first needs
    -- them, never earlier.
    else false
  end;
$$;

revoke all on function private.node_kyc_transition_allowed(public.kyc_status, public.kyc_status) from public;

-- No grant to any client role. The only caller is `private.guard_node_kyc_audit`,
-- which is `security definer` and therefore executes it as its own owner. The
-- pairing `20260813130000` had to correct after `20260813120000` -- a
-- `security invoker` caller needing the grant in its own right -- does not apply
-- here, and will apply the moment somebody calls this from one.

-- ---------- The guard, with both halves ----------
--
-- Replaced rather than added to, because the house rule is one trigger for both.
-- The body below is `20260831120000:274-304` with the refusal in front of the
-- insert; the signature, the volatility, the `security definer` and the
-- `set search_path` are unchanged, so the existing trigger keeps pointing at it.

create or replace function private.guard_node_kyc_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.node_kyc_transition_allowed(old.kyc_status, new.kyc_status) then
    raise exception
      'node % cannot go from % to %',
      old.user_id, old.kyc_status, new.kyc_status
      using errcode = 'check_violation',
            hint = 'Legal KYC arcs: unverified->pending, pending->verified|rejected|unverified, '
                   'rejected->pending. Suspension has no writer until the ops console exists. '
                   'See docs/30-modules/human-nodes-marketplace.md.';
  end if;

  new.kyc_status_changed_at := now();
  new.updated_at := now();

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    null,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'node.kyc_status_changed',
    'node',
    new.user_id,
    jsonb_build_object(
      'from', old.kyc_status,
      'to', new.kyc_status,
      'availability', new.availability,
      'suspended_reason', new.suspended_reason
    )
  );

  return new;
end;
$$;

-- `create or replace` preserves the privileges the original acquired, so the
-- `revoke all ... from public` at `20260831120000:306` still stands. Repeated
-- here anyway: replaying the migrations in order must reproduce this state, and a
-- reader should not have to know which DDL verbs preserve grants to be sure.
revoke all on function private.guard_node_kyc_audit() from public;

-- ---------- Comments ----------

comment on function private.node_kyc_transition_allowed(public.kyc_status, public.kyc_status) is
  'The KYC lifecycle map. Five arcs, one per transition a writer in this repository '
  'can actually make. Nothing reaches suspended: it has no writer until the ops '
  'console, and a map permitting an unmakeable transition is the task_deps defect.';

comment on function private.guard_node_kyc_audit() is
  'Refuses an illegal KYC transition, then stamps kyc_status_changed_at and writes '
  'the audit event. One trigger for both halves so that an audit entry cannot be '
  'forgotten by a caller and cannot describe a transition that did not happen. '
  'Binds service_role as well, because a trigger is not a grant.';
