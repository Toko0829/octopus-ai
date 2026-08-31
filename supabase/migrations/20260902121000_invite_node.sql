-- 20260902121000_invite_node.sql — the invite is the row, and it is the only way
-- a node comes into existence.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md, docs/30-modules/auth-identity.md,
--       docs/10-architecture/security-compliance.md
--
-- `human-nodes-marketplace.md:70-76` states the cold-start rule this function
-- exists to enforce: slice 3 ships **ops-invited onboarding, not open
-- self-registration**, because "an empty marketplace with three invited notaries
-- is a decision; an empty marketplace with a public sign-up form is a dead end."
-- The enforcement is structural rather than procedural. There is no route, no
-- policy and no client grant that can produce a `node_profiles` row; this
-- function is reachable by `service_role` alone, and the only caller is
-- `scripts/invite-node.mjs`, run by a person holding the secret key. **The invite
-- is the row**: it cannot exist unless an operator made it.
--
-- **Why a function and not two statements in Node.** supabase-js speaks PostgREST
-- and has no transaction, and this commit spans two tables. A `node_profiles` row
-- without the role promotion is a node the rest of the system does not recognise;
-- the promotion without the row is a `human_node` with nothing behind it. The
-- third writer of this shape after `materialise_plan` and `materialise_campaign`,
-- and for the same first reason each of those gives.
--
-- **The role promotion is the interesting half.** `20260831110000` made
-- `profiles.role` server-written only: the column grant excludes it and
-- `profiles_guard_role_self_service` raises on any role change made by a caller
-- carrying a JWT. That guard's bypass is `auth.uid() is null`, which is exactly
-- the condition a `service_role` connection satisfies, and
-- `supabase/tests/rls_membership.sql:281-288` already pins that this path
-- succeeds. So the trigger does not fire here, by the design it was written with
-- rather than by an exemption added for this function. `profiles.role` gains its
-- first writer in this migration and still authorises nothing anywhere; see
-- docs/30-modules/auth-identity.md.
--
-- **It never demotes.** A promotion that can run backwards is a privilege bug
-- wearing the shape of an onboarding call: an operator with a typo in an email
-- would turn an `ops` account into a node. `admin` and `ops` are refused
-- outright; `human_node` and `verified_pro` are already nodes and pass through
-- without a write.
--
-- **A re-invite is idempotent and does not reset anybody.** `on conflict do
-- nothing` on the primary key, so the jurisdictions and languages passed on a
-- second call are ignored rather than clobbering what the node has since set on
-- their own surface. An operator re-running the script after a network failure
-- gets the same row, not a reset KYC.

create function public.invite_node(
  p_user_id       uuid,
  p_jurisdictions text[],
  p_languages     text[]
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role     public.user_role;
  v_created  boolean := false;
  v_promoted boolean := false;
begin
  if p_user_id is null then
    raise exception 'invite_node needs a user id'
      using errcode = 'invalid_parameter_value';
  end if;

  -- An account, not an email. Inventing a user here would be creating a
  -- credential, which is the one thing an invite must not do; the operator's
  -- script resolves the address and refuses when nobody has signed up.
  select role into v_role
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'no profile for user %', p_user_id
      using errcode = 'no_data_found',
            hint = 'The person must sign up first. An invite attaches to an account.';
  end if;

  if v_role in ('admin', 'ops') then
    raise exception 'refusing to make % a node: they are %', p_user_id, v_role
      using errcode = 'insufficient_privilege',
            hint = 'An invite never demotes. Check the email address.';
  end if;

  -- Both lists are required, and that is a cold-start rule rather than a schema
  -- one: the table's own constraint accepts an empty array, but a node who serves
  -- nowhere and speaks nothing can never be matched, so inviting one would create
  -- the dead end this whole ordering exists to avoid. The node edits both
  -- afterwards on their own surface.
  if p_jurisdictions is null or cardinality(p_jurisdictions) = 0 then
    raise exception 'a node needs at least one service jurisdiction'
      using errcode = 'invalid_parameter_value',
            hint = 'Hierarchical codes, for example US or US-TX. See ADR-0015.';
  end if;

  if p_languages is null or cardinality(p_languages) = 0 then
    raise exception 'a node needs at least one language'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Malformed codes are caught by `node_profiles_jurisdictions_wellformed`, which
  -- calls `private.is_jurisdiction_code_array`. Not re-checked here: one
  -- implementation of the shape, and it is the one that cannot be bypassed.
  insert into public.node_profiles (user_id, service_jurisdictions, languages)
  values (p_user_id, p_jurisdictions, p_languages)
  on conflict (user_id) do nothing;

  v_created := found;

  if v_role = 'user' then
    update public.profiles
    set role = 'human_node'
    where user_id = p_user_id;

    v_promoted := true;
  end if;

  -- The invite is audited in its own right. The KYC trigger records status
  -- changes and this changes none: a new node lands at `unverified`, which is the
  -- default rather than a transition, so without this row the act of admitting
  -- somebody to paid work funded from another person's authorised budget would
  -- leave no trail at all. `actor_kind` resolves to `system` because `auth.uid()`
  -- is null under `service_role`; the operator is identified by the fact that
  -- only a secret-key holder can reach this function.
  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    null,
    auth.uid(),
    case when auth.uid() is null then 'system'::public.author_kind else 'user'::public.author_kind end,
    'node.invited',
    'node',
    p_user_id,
    jsonb_build_object(
      'created', v_created,
      'promoted', v_promoted,
      'role_before', v_role,
      'service_jurisdictions', to_jsonb(p_jurisdictions),
      'languages', to_jsonb(p_languages)
    )
  );

  return p_user_id;
end;
$$;

revoke all on function public.invite_node(uuid, text[], text[]) from public;
grant execute on function public.invite_node(uuid, text[], text[]) to service_role;

-- `security invoker`, so it runs as `service_role`, which already holds
-- `grant all` on both tables (`20260831120000:250`, `20260728170000:23`). No new
-- table grant is needed and none is taken: `authenticated` gains nothing from
-- this migration, and the ten privilege assertions in
-- `supabase/tests/marketplace_rls.sql:232-282` stay green.
--
-- One consequence worth stating rather than discovering: because this is
-- `security invoker`, it needs `execute` on the constraint helper in its own
-- right. `private.is_jurisdiction_code_array` was granted to `service_role` at
-- `20260831120000:137` for exactly this, which is the pairing `20260813130000`
-- had to correct after `20260813120000`, gotten right in advance this time.

comment on function public.invite_node(uuid, text[], text[]) is
  'The only way a node comes into existence. Creates the node_profiles row and '
  'promotes profiles.role to human_node in one transaction, reachable by '
  'service_role alone. Idempotent on re-invite and never demoting: admin and ops '
  'are refused. Ops-invited rather than self-service is the cold-start decision '
  'in docs/30-modules/human-nodes-marketplace.md.';
