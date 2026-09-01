-- 20260908128000_submit_rating.sql — `trust_score` stops being NULL on every row in the database.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/learning-flywheel.md
--
-- Marketplace slice 8, ninth and last migration. `node_profiles.trust_score`
-- landed in `20260831120000:155` with a column comment reading "Written by
-- ratings (slice 8)", and `packages/marketplace/src/matching.ts:13-14` records
-- that it is NULL on every row and that ranking on it "would be arithmetic
-- pretending to be a ranking". This is its first writer.
--
-- ---------- The formula, and everything it is not ----------
--
--     trust_score = round(avg(score) / 5.0, 4)   over ratings where the node is ratee
--
-- The mean of the scores a node has received, normalised to the `[0, 1]` the
-- column's check constraint requires. That is the whole of it, and the
-- restraint is the design rather than a first draft.
--
-- human-nodes-marketplace.md:908 specifies more: "Trust score seeds from KYC +
-- verified credentials and grows with completed jobs/ratings." Three of those
-- four inputs **cannot be computed in this build**, and computing them anyway is
-- how a number becomes false:
--
--   * **KYC** is a single in-repo fake verifier (`carriesRealPii` refuses every
--     real provider at the writer). Every verified node passed the same fake, so
--     a KYC term would be a constant added to every row.
--   * **Verified credentials** cannot exist: `node_credentials.verified` is
--     write-once true and **nothing can set it**, which the module doc states.
--     A credential term would read a column that is `false` on every row.
--   * **Completed jobs** has a real writer (`settle_payout` increments
--     `completed_engagements`), and is deliberately left out anyway. Blending
--     volume into a quality score means a node with twenty mediocre jobs
--     outranks one with three excellent ones, which is a decision about what
--     this marketplace rewards — not a smoothing detail to be settled inside a
--     migration. The column is there and the matcher can weigh it separately
--     when somebody decides it should.
--
-- What is left is the one input that is real, and it is reported as exactly what
-- it is. **No Bayesian prior, no shrinkage toward a mean, no confidence
-- weighting.** Those exist to stop one five-star rating outranking a long good
-- record, which is a genuine problem — and the honest fix is for the matcher to
-- read `completed_engagements` beside the score, where the count is visible,
-- rather than for this function to fold a guess about sample size into the score
-- and hand the matcher a number that silently means something different for a
-- new node than for an established one.
--
-- **NULL until the first rating, never 0.** `20260831120000:324` fixed this
-- meaning before there was a writer: "NULL `trust_score` means cold start, never
-- zero, because zero would mean measured and worthless." A `left join` or a
-- `coalesce` here would quietly rewrite that. The recompute below only ever runs
-- with at least one rating in hand, so the column moves from NULL to a real
-- value and never back.
--
-- ---------- Recomputed, not accumulated ----------
--
-- The whole average is recomputed from `ratings` on every submission rather than
-- folded incrementally into the existing value. `ratings` is append-only
-- including for `service_role`, so the set can only grow and the recompute is
-- cheap and exact; an incremental update would carry rounding error forward
-- forever and would be unrecoverable if it ever drifted. The derived column is a
-- cache of a query, and the query is the truth.

create or replace function public.submit_rating(
  p_engagement_id uuid,
  p_rater         uuid,
  p_score         integer,
  p_comment       text default null
)
returns uuid
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_eng       public.engagements;
  v_owner     uuid;
  v_direction text;
  v_ratee     uuid;
  v_existing  uuid;
  v_rating_id uuid;
  v_score     numeric;
begin
  if p_rater is null then
    raise exception 'a rating has to name who is giving it' using errcode = 'check_violation';
  end if;

  if p_score is null or p_score < 1 or p_score > 5 then
    raise exception 'a rating is a whole number of stars from 1 to 5, not %', p_score
      using errcode = 'check_violation';
  end if;

  select * into v_eng from public.engagements where id = p_engagement_id;
  if not found then
    raise exception 'engagement % not found', p_engagement_id using errcode = 'no_data_found';
  end if;

  -- (1) **Only a finished, undisputed deal.** See `20260908127000`'s header: a
  -- cancelled or reassigned deal delivered nothing, and a `disputed_resolved` one
  -- has already been adjudicated by an operator, so a score collected afterwards
  -- would be about the verdict rather than about the work.
  if v_eng.outcome is distinct from 'completed' then
    raise exception
      'engagement % is %, so there is nothing to rate',
      v_eng.id, coalesce(v_eng.outcome, 'still running')
      using errcode = 'check_violation',
            hint = 'Only a deal that ended completed can be rated; a disputed one has its resolution instead.';
  end if;

  -- (2) **The two parties are resolved from rows, and the direction is derived
  -- rather than passed.** The node is on the engagement; the owner is the room's
  -- `owner_id`, resolved the way `private.is_project_member` and
  -- `resolveProjectOwner` both resolve it — the plan card first, the legacy
  -- `rooms.project_id` link unioned in, because `20260827110000` showed that
  -- reading only the second makes every project after a room's first one
  -- invisible.
  --
  -- **`owner_id` rather than room membership**, which is narrower than the read
  -- policies on `ratings` and deliberately so: a room can hold collaborators who
  -- may read the deal, and rating somebody is not reading about them. The person
  -- whose budget paid for the work is the person whose opinion this records.
  --
  -- `private.is_project_member` is unusable here whatever the rule: it tests
  -- `auth.uid()`, and this function runs as `service_role` where that is null by
  -- construction.
  select r.owner_id into v_owner
  from public.rooms r
  where r.id in (
    select ae.room_id
    from public.projects p
    join public.action_embeds ae on ae.id = p.source_embed_id
    where p.id = v_eng.project_id
    union
    select r2.id from public.rooms r2 where r2.project_id = v_eng.project_id
  )
  limit 1;

  if v_owner is null then
    raise exception 'engagement % has no owning room, so its parties cannot be resolved', v_eng.id
      using errcode = 'no_data_found';
  end if;

  if p_rater = v_eng.node_id then
    v_direction := 'node_of_owner';
    v_ratee     := v_owner;
  elsif p_rater = v_owner then
    v_direction := 'owner_of_node';
    v_ratee     := v_eng.node_id;
  else
    raise exception 'only the two parties to engagement % can rate it', v_eng.id
      using errcode = 'insufficient_privilege',
            hint = 'The node who did the work and the owner who commissioned it, and nobody else.';
  end if;

  -- (3) **Idempotency before the write**, this domain's ordering. The unique
  -- index is the actual control — a second submission collides there whatever
  -- this read saw — so this exists to hand a retry its own row back instead of a
  -- constraint violation.
  select id into v_existing
  from public.ratings
  where engagement_id = p_engagement_id and direction = v_direction;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.ratings (engagement_id, project_id, rater_id, ratee_id, direction, score, comment)
  values (
    p_engagement_id, v_eng.project_id, p_rater, v_ratee, v_direction, p_score,
    nullif(btrim(coalesce(p_comment, '')), '')
  )
  returning id into v_rating_id;

  -- (4) **`trust_score`, in the same transaction as the rating that moves it**,
  -- so the column and the rows it summarises cannot disagree. Only when the
  -- ratee is a node: an owner has no `node_profiles` row and this market does not
  -- score buyers into a graph anything reads. The owner's rating is recorded and
  -- readable, and it is the node console that shows it.
  if v_direction = 'owner_of_node' then
    select avg(score) into v_score
    from public.ratings
    where ratee_id = v_ratee and direction = 'owner_of_node';

    update public.node_profiles
    set trust_score = round(v_score / 5.0, 4), updated_at = now()
    where user_id = v_ratee;
  end if;

  insert into public.events (project_id, actor_id, actor_kind, verb, subject_type, subject_id, payload)
  values (
    v_eng.project_id, p_rater, 'user',
    'rating.submitted', 'rating', v_rating_id,
    jsonb_build_object(
      'engagement_id', p_engagement_id,
      'task_id', v_eng.task_id,
      'direction', v_direction,
      'ratee_id', v_ratee,
      'score', p_score
    )
  );

  return v_rating_id;
end;
$function$;

-- **`service_role` alone**, like every writer in this domain, and here the reason
-- is one join away rather than abstract: this function writes
-- `node_profiles.trust_score`, and `20260831120000:243-248` gives `authenticated`
-- no write grant on that table because "kyc_status and trust_score are exactly
-- what a fraudster would set on themselves". The party check is inside the
-- function rather than at the grant, because both parties are ordinary
-- authenticated users and the route calls this with the caller's own id.
revoke all on function public.submit_rating(uuid, uuid, integer, text) from public;
grant execute on function public.submit_rating(uuid, uuid, integer, text) to service_role;

comment on function public.submit_rating(uuid, uuid, integer, text) is
  'Records one side''s score on a completed deal and recomputes node_profiles.trust_score in the '
  'same transaction. trust_score is avg(score)/5 over ratings received, and deliberately nothing '
  'else: KYC is a single fake verifier, no credential can be verified in this build, and folding '
  'completed_engagements into a quality score is a decision about what this market rewards '
  'rather than a smoothing detail. NULL until the first rating, never 0. Direction and ratee are '
  'derived from the engagement, so a caller cannot mislabel a score.';
