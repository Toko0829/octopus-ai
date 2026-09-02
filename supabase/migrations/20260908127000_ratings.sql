-- 20260908127000_ratings.sql — the first thing in this system that measures a person.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/learning-flywheel.md,
--       docs/40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md
--
-- Marketplace slice 8, eighth migration. `data-model.md:1074` has carried this as
-- "⏳ slice 8. Written after `paid`. Feeds `trust_score`, which lands now as a
-- nullable column so the writer arrives to a column rather than a migration."
-- `20260831120000:155` is that column, NULL on every row in the database.
--
-- ---------- Two-sided, because one-sided is a different product ----------
--
-- human-nodes-marketplace.md:1040 says "two-sided rating updates the trust
-- graph", and both directions land together rather than the node's arriving in
-- a later slice. A market where only the buyer rates is one where the seller
-- carries all the reputational risk, and this market's sellers are individual
-- people being paid from a stranger's budget. Shipping the owner's half first
-- would also have meant `direction` existing with one value, which is the
-- `task_deps` anti-pattern this repository has recorded: a rule enforced over an
-- empty set.
--
--     owner_of_node   the owner rates the expert who did the work
--     node_of_owner   the expert rates the owner who commissioned it
--
-- ---------- Immediately visible, not mutual-blind ----------
--
-- The obvious objection to visible two-sided rating is retaliation: I see your
-- three stars and answer with one. Escrow-style markets usually answer it with a
-- blind window — neither score shows until both are in or a clock runs out.
--
-- That is not built here, and the reason is that a reveal mechanism is a
-- lifecycle: a hidden state, a visible state, a clock that moves rows between
-- them, a sweep to run the clock, and a decision about what a half-blind pair
-- means when one side never rates. That is a slice, and it would be a slice whose
-- entire content is machinery for a risk this build cannot yet observe, in a
-- market with **no self-service registration** (`invite_node` is `service_role`
-- alone) and therefore a node population an operator personally invited.
--
-- The honest version is: visible now, recorded as a decision rather than as an
-- oversight, with the trigger to revisit named — the first retaliatory pattern
-- an operator sees in `ratings`, or self-service node registration, whichever
-- comes first. Written into human-nodes-marketplace.md so it is somebody's to
-- notice rather than nobody's.
--
-- ---------- Only completed deals, and this is where disputes sit ----------
--
-- `submit_rating` requires `engagements.outcome = 'completed'`. A deal that
-- ended `cancelled` or `reassigned` delivered nothing and has nothing to score.
-- A deal that ended **`disputed_resolved`** is the interesting exclusion: work
-- happened, both parties have opinions, and they are excluded anyway.
--
-- Because an operator has already decided it. A dispute produces a finding, a
-- reason, an `ops_actions` row and a money outcome — a far better record of what
-- went wrong than a number out of five — and inviting both parties to score each
-- other **after** losing an adjudication would collect the one rating most
-- likely to be about the verdict rather than about the work. `trust_score` is
-- read by the matcher to decide who gets offered paid work; feeding it the
-- output of a grievance is how a scoring system becomes a punishment system.
--
-- `20260908126000` still opens the counterparty pair for those deals, so both
-- parties keep the record. They keep the record and do not get the scoreboard.

-- ---------- Table ----------

create table public.ratings (
  id            uuid primary key default gen_random_uuid(),

  -- The deal. Both directions hang off one engagement, which is what makes
  -- "one rating per side per deal" a single unique constraint below.
  engagement_id uuid not null references public.engagements (id) on delete cascade,

  -- Denormalised on this domain's standing reason: the member policy is a helper
  -- call on a column rather than a join through two tables.
  project_id    uuid not null references public.projects (id) on delete cascade,

  rater_id      uuid not null references auth.users (id),
  ratee_id      uuid not null references auth.users (id),

  -- Which side this is. Derived by `submit_rating` from the engagement rather
  -- than passed in, so a caller cannot mislabel a score.
  direction     text not null check (direction in ('owner_of_node', 'node_of_owner')),

  -- One to five. An integer rather than a decimal because the surface is five
  -- stars and storing 4.5 would let an API write a score no person could enter.
  score         integer not null check (score between 1 and 5),

  -- Optional words. The score feeds `trust_score`; this feeds a human reading the
  -- row, and it is what makes a low score answerable.
  comment       text check (comment is null or char_length(comment) <= 2000),

  created_at    timestamptz not null default now(),

  -- Nobody rates themselves. Unreachable through `submit_rating`, which derives
  -- both sides from the engagement, and asserted here because a constraint that
  -- depends on one function being the only writer is a comment.
  constraint ratings_not_self check (rater_id <> ratee_id)
);

-- **One rating per side per deal.** The whole of "you may not rate twice", as one
-- index rather than as a rule in the RPC, so a second submission collides in the
-- database and `submit_rating`'s idempotent read is an optimisation rather than
-- the control.
create unique index ratings_one_per_direction_idx
  on public.ratings (engagement_id, direction);

-- `trust_score` recomputes over every rating a person has received; the panel
-- and the node console read by engagement.
create index ratings_ratee_idx on public.ratings (ratee_id, created_at desc);
create index ratings_project_idx on public.ratings (project_id);

-- ---------- RLS and grants ----------

alter table public.ratings enable row level security;

-- **Both parties to the deal read both ratings on it**, which is the whole
-- content of "visible immediately". The node's arm is their own engagement; the
-- owner's is project membership, which `private.is_project_member` scopes to
-- `scope = 'room'` so an admitted node does not read other people's ratings
-- through it.
create policy "ratings_select_node" on public.ratings
  for select using (
    exists (
      select 1
      from public.engagements e
      where e.id = ratings.engagement_id
        and e.node_id = auth.uid()
    )
  );

create policy "ratings_select_member" on public.ratings
  for select using (private.is_project_member(project_id));

-- **Select only.** `submit_rating` is the writer and it is `service_role` alone,
-- because writing a rating also writes `node_profiles.trust_score`, and
-- `20260831120000:243-248` deliberately gives `authenticated` no write grant on
-- that table at all: "kyc_status and trust_score are exactly what a fraudster
-- would set on themselves." A client INSERT here would be that write one join
-- away.
grant select on public.ratings to authenticated;
grant all on public.ratings to service_role;

-- **Append-only, including for `service_role`.** Stricter than the money tables,
-- which keep UPDATE because settling is an update; nothing here is ever settled.
-- An editable rating is one that can be changed after the other side reads it,
-- and a deletable one is a trust graph that can be quietly cleaned up. A score
-- somebody regrets is answered by the comment on the deal, not by a rewrite.
revoke update, delete, truncate on public.ratings from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.ratings is
  'Two-sided scores on a finished deal, one per side, append-only including for service_role. '
  'Visible immediately rather than mutual-blind: a reveal mechanism is a lifecycle with a clock '
  'and a sweep, and this build has no self-service node registration, so the risk it manages is '
  'not yet observable. Revisit on the first retaliatory pattern or on open registration.';

comment on column public.ratings.direction is
  'Which side is speaking. Derived by submit_rating from the engagement rather than passed in, '
  'so a caller cannot mislabel a score. Both values land together: a market where only the buyer '
  'rates puts all the reputational risk on individual people being paid from a stranger''s budget.';

comment on column public.ratings.score is
  'One to five, integer because the surface is five stars and a decimal would let an API write a '
  'score no person could enter. Feeds node_profiles.trust_score through submit_rating, in the '
  'same transaction, and only for deals that ended completed - never for a disputed_resolved '
  'one, because that score would be about the verdict rather than about the work.';
