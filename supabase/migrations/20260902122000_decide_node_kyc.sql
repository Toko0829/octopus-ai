-- 20260902122000_decide_node_kyc.sql — the verification writer, whose shape was
-- decided by the table's own grants rather than the other way round.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md,
--       docs/10-architecture/security-compliance.md
--
-- `node_verifications` has held its guards since `20260831123000` with no writer.
-- Two of them decide everything about this function:
--
--   1. **`update`, `delete` and `truncate` are revoked from `service_role` too**
--      (`20260831123000:140`), so `insert ... on conflict do nothing` is the only
--      idiom available. `on conflict do update` fails on privilege rather than on
--      conflict, which is a confusing way to learn a design decision, so it is
--      never reached for.
--   2. **The table is append-only and `idempotency_key` is nullable-unique**, so
--      the key is the entire replay contract. One key per check, derived from a
--      prefix the caller supplies and the check's own kind.
--
-- **The verdict is derived from the rows, not from the payload.** That is the
-- non-obvious half. A replay inserts nothing, so re-deciding from the argument
-- would work by accident while re-deciding from the table works by construction:
-- the answer is a function of what is durably recorded, and two calls with the
-- same prefix converge on the same status whether or not the first one committed.
-- This is `campaign_outcomes`' lesson (`20260829123000`) applied to identity: when
-- the only available write is an append, the read has to be the source of truth.
--
-- **It cannot route around the lifecycle map.** The status change goes through an
-- ordinary `update`, so `private.guard_node_kyc_audit` (`20260902120000`) refuses
-- an illegal arc and writes the audit row. Calling this on a node who never
-- submitted raises rather than quietly verifying them, because
-- `unverified -> verified` is not an arc. Submission preceding decision is
-- therefore enforced in Postgres and not merely in the order the route happens to
-- do things.
--
-- **The provider is not checked here**, deliberately, and `20260831123000:70-73`
-- says why: "a provider is a reviewed file, and a check constraint would need a
-- migration per provider." The registry is `packages/marketplace`, and the route
-- refuses an unregistered provider before it ever reaches this function, the way
-- `carriesRealCredentials` refuses one at the connection writer.
--
-- **`detail` is not inspected.** It holds verdicts, scores and references and
-- never a document, an image, a date of birth or a number
-- (`20260831123000:75-79`). Keeping real PII out of it is the registry's job at
-- the boundary, not a shape this function could usefully assert.
--
-- One arc that does not exist, stated rather than left to be discovered: a
-- `verified` node cannot return to `pending`, so nothing here re-verifies anybody.
-- Renewal and re-screening are an ops concern with no writer, and they gain their
-- arc from the slice that first performs one.

create function public.decide_node_kyc(
  p_node_id            uuid,
  p_provider           text,
  p_checks             jsonb,
  p_idempotency_prefix text
) returns public.kyc_status
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_check    jsonb;
  v_keys     text[] := '{}';
  v_key      text;
  v_verdict  public.kyc_status;
  v_current  public.kyc_status;
begin
  if p_node_id is null then
    raise exception 'decide_node_kyc needs a node id'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(p_provider, '') = '' then
    raise exception 'decide_node_kyc needs a provider'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(p_idempotency_prefix, '') = '' then
    raise exception 'decide_node_kyc needs an idempotency prefix'
      using errcode = 'invalid_parameter_value',
            hint = 'The prefix is the whole replay contract: this table has no UPDATE.';
  end if;

  if p_checks is null
     or jsonb_typeof(p_checks) <> 'array'
     or jsonb_array_length(p_checks) = 0 then
    raise exception 'decide_node_kyc needs a non-empty array of checks'
      using errcode = 'invalid_parameter_value';
  end if;

  select kyc_status into v_current
  from public.node_profiles
  where user_id = p_node_id;

  if not found then
    raise exception 'no node profile for %', p_node_id
      using errcode = 'no_data_found',
            hint = 'A node exists only by invitation. See public.invite_node.';
  end if;

  -- A loop rather than one set-based insert, because the key has to be built per
  -- row and collected for the read-back below. Three checks is the realistic
  -- count; readability wins over a CTE nobody would enjoy amending.
  for v_check in select * from jsonb_array_elements(p_checks)
  loop
    if v_check->>'kind' is null or v_check->>'result' is null then
      raise exception 'each check needs a kind and a result'
        using errcode = 'invalid_parameter_value';
    end if;

    v_key := p_idempotency_prefix || ':' || (v_check->>'kind');
    v_keys := v_keys || v_key;

    -- An unknown kind or result raises on the cast (22P02), which is the
    -- "unknown values raise" rule `materialise_campaign` states: a payload can
    -- arrive from an older service or a hand edit, and guessing on its behalf is
    -- how a verification nobody performed gets recorded as one.
    insert into public.node_verifications (
      node_id, credential_id, kind, provider, provider_ref, result, detail, idempotency_key
    )
    values (
      p_node_id,
      nullif(v_check->>'credential_id', '')::uuid,
      (v_check->>'kind')::public.verification_kind,
      p_provider,
      nullif(v_check->>'provider_ref', ''),
      (v_check->>'result')::public.verification_result,
      coalesce(v_check->'detail', '{}'::jsonb),
      v_key
    )
    on conflict do nothing;
  end loop;

  -- The read-back. Matched on the exact keys just built rather than on a `like`
  -- against the prefix, because a prefix is caller-supplied text and `%` in it
  -- would silently widen the query into somebody else's decision.
  select case
    when bool_or(result = 'failed') then 'rejected'::public.kyc_status
    when bool_or(result in ('inconclusive', 'error')) then 'unverified'::public.kyc_status
    else 'verified'::public.kyc_status
  end
  into v_verdict
  from public.node_verifications
  where node_id = p_node_id
    and idempotency_key = any(v_keys);

  if v_verdict is null then
    -- Every insert was skipped and nothing matched, which means the keys belong
    -- to another node. Refusing beats returning a status derived from no rows.
    raise exception 'no verification rows for node % under this prefix', p_node_id
      using errcode = 'no_data_found',
            hint = 'An idempotency prefix is per node. Reusing one across nodes is a bug.';
  end if;

  -- No-op when the node already carries the verdict, which is what makes a replay
  -- safe: the trigger's `when` clause does not fire, so no second audit row is
  -- written describing a transition that did not happen.
  if v_verdict is distinct from v_current then
    update public.node_profiles
    set kyc_status = v_verdict
    where user_id = p_node_id;
  end if;

  return v_verdict;
end;
$$;

revoke all on function public.decide_node_kyc(uuid, text, jsonb, text) from public;
grant execute on function public.decide_node_kyc(uuid, text, jsonb, text) to service_role;

-- No table grant changes. `service_role` already holds `insert` and `select` on
-- `node_verifications` and `grant all` on `node_profiles`; `authenticated` gains
-- nothing, so `supabase/tests/marketplace_rls.sql` stays at 46/46 including its
-- assertion that the subject of a verification record is refused it.

comment on function public.decide_node_kyc(uuid, text, jsonb, text) is
  'Records a provider''s checks and moves the node''s kyc_status accordingly, in one '
  'transaction. Append-only by grant, so insert ... on conflict do nothing is the only '
  'idiom and the verdict is derived from the recorded rows rather than the payload, '
  'which is what makes a replay converge. The status change passes through the '
  'lifecycle map, so a node who never submitted cannot be verified.';
