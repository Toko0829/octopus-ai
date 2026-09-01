-- 20260908126000_counterparty_admits_disputed_resolved.sql — the decision 20260907123000 deferred.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/10-architecture/security-compliance.md,
--       docs/30-modules/admin-ops.md,
--       docs/40-adr/0026-the-dispute-exit-map.md
--
-- Marketplace slice 8, seventh migration. `20260907123000:46` widened this
-- projection to admit `'completed'` and stopped there, in as many words:
--
--   > `'cancelled'`, `'reassigned'` and the future `'disputed_resolved'` all stay
--   > shut — the first two because nothing was delivered, the third because
--   > **slice 8 has not decided what a resolved dispute leaves the two parties
--   > entitled to see, and guessing on its behalf is how a disclosure decision
--   > gets made by whoever wrote the migration first.**
--
-- This is slice 8 deciding. `'disputed_resolved'` is admitted;
-- `'cancelled'` and `'reassigned'` stay shut.
--
-- ---------- Why a resolved dispute stays readable ----------
--
-- Three reasons, in the order they weigh.
--
-- **1. Closing it would erase a name at the exact moment it matters most.** The
-- projection's whole purpose is that each party can see who the other one is. A
-- dispute is the one point in an engagement where that is not a convenience: it
-- is a decision made about somebody's money, by an operator, against a named
-- person, and both parties have a legitimate interest in continuing to know who
-- the counterparty was. Shutting the pair at resolution would mean the panel
-- renders "somebody" beside the outcome of the most consequential thing that
-- happened between them. `20260907123000` refused precisely this shape one step
-- earlier — "paying somebody is not what erases their name" — and the argument
-- does not weaken when the ending is contested rather than clean.
--
-- **2. `'cancelled'` and `'reassigned'` are shut for a reason that does not
-- apply here.** They close because *nothing was delivered*: the deal ended
-- before either party did anything the other needs to remember. A resolved
-- dispute is the opposite. Work was done, or was alleged to have been done, and
-- an operator adjudicated it. There is a shared history; the disagreement is
-- about what it was worth.
--
-- **3. It is not a widening of what can be seen, only of when.** The pair was
-- open for the entire life of the engagement — `ended_at is null` covers every
-- moment up to the resolution, including the whole period the dispute was open.
-- Both parties have already seen each other's display name, in the panel and in
-- the thread. Closing it now would withdraw information already disclosed, which
-- protects nobody and only breaks the record.
--
-- ---------- What this deliberately does not open ----------
--
-- The same list `20260907123000` and `20260904126000` both end on, because it is
-- the answer to "was this a widening of the time-box or of the projection". It
-- is the time-box. `node_profiles` stays closed to the owner, `node_verifications`
-- stays closed to everyone including its own subject, `offers` stays closed to
-- the owner, `ledger_entries` and `ops_actions` stay closed to every client role,
-- and `private.shares_room_with` is untouched.
--
-- **Ratings do not read this.** `20260908127000` gates rating on
-- `outcome = 'completed'` alone, so a disputed deal is readable and not
-- rateable. That is the intended asymmetry: the parties keep the record, and the
-- trust graph does not take a score from a deal an operator had to decide. The
-- reason this projection widens anyway is reason 1 above — the record, not the
-- rating.
--
-- The whole body is restated, per this repository's convention for a
-- `create or replace`. The only differences from the applied version are the two
-- `outcome` predicates.

create or replace function private.engaged_counterparty(p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    -- (a) **I am the node, and they are a room member of the project I am
    -- engaged on.** Not "any member of my thread": the person a node needs to see
    -- is the owner, who is room-scoped and shares no thread with them. The
    -- time-box on the other side is still checked, because an expired member is
    -- somebody who has left and an admitted node should not read them.
    --
    -- The project resolves to its room the way `private.is_project_member`
    -- resolves it: the plan card first, the legacy `rooms.project_id` link
    -- unioned in. Both links are accepted, because `20260827110000` showed that
    -- reading only the second makes every project after a room's first one
    -- invisible.
    select 1
    from public.engagements e
    join public.room_members m on m.room_id in (
      select ae.room_id
      from public.projects p
      join public.action_embeds ae on ae.id = p.source_embed_id
      where p.id = e.project_id
      union
      select r.id from public.rooms r where r.project_id = e.project_id
    )
    where e.node_id = auth.uid()
      -- Live, **or ended in a way that leaves a shared history**. Completed is
      -- work delivered and paid for; disputed_resolved is work an operator had
      -- to adjudicate, which is the ending where knowing who the other party was
      -- matters most. Cancelled and reassigned stay out: nothing was delivered.
      and (e.ended_at is null or e.outcome in ('completed', 'disputed_resolved'))
      and m.user_id = p_user
      and m.scope = 'room'
      and (m.expires_at is null or m.expires_at > now())
  )
  or exists (
    -- (b) **They are a node with a live, completed or adjudicated engagement on a
    -- project I am a member of.** `private.is_project_member` already requires a
    -- live, room-scoped membership, so the whole owner-side rule is one call and
    -- there is no second copy of the time-box to keep in step.
    select 1
    from public.engagements e
    where e.node_id = p_user
      and (e.ended_at is null or e.outcome in ('completed', 'disputed_resolved'))
      and private.is_project_member(e.project_id)
  );
$$;

revoke all on function private.engaged_counterparty(uuid) from public;
grant execute on function private.engaged_counterparty(uuid) to anon, authenticated;

comment on function private.engaged_counterparty(uuid) is
  'Whether auth.uid() and p_user are the two sides of an engagement that is live, was completed, '
  'or was resolved by an operator after a dispute. Joins through engagements rather than '
  'room_members.thread_id: a membership row outlives the work and the owner shares no thread '
  'with the node. Completed and disputed_resolved deals stay readable permanently - the first '
  'because ratings look backwards, the second because a decision made about somebody''s money '
  'should not be the thing that erases their name. Cancelled and reassigned close, because '
  'nothing was delivered on either. A disputed_resolved deal is readable and NOT rateable.';
