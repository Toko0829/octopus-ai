-- 20260907123000_counterparty_survives_completion.sql — paying somebody must not
-- be what stops you knowing who they were.
-- Owner doc: docs/30-modules/human-nodes-marketplace.md
-- Also: docs/30-modules/payments-billing.md,
--       docs/10-architecture/security-compliance.md,
--       docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md
--
-- ---------- This is forced by the slice rather than planned by it ----------
--
-- `20260904126000` opened the profile pair through `engagements` and made
-- `ended_at is null` "the entire time-box", which was exactly right while the
-- only things that ended a deal were `cancelled` and `reassigned`: nothing was
-- delivered on either, so closing the read cost nobody anything.
--
-- `settle_payout` gives `outcome = 'completed'` its first producer, and that
-- inverts the calculation without changing a line of `20260904126000`. Slice 6
-- had already seen half of it and deferred the other half by name: it declined to
-- end the engagement on approval because "the panel reads live engagements only,
-- so ending it would erase who did this at the moment the owner is about to pay
-- them", and booked the ending to the payout slice. Ending it here without this
-- migration would do precisely what slice 6 refused to do, one step later — the
-- owner's panel would fall back to "An expert" on every step the moment it was
-- paid for, and slice 8 would ask them to rate somebody whose name they can no
-- longer read.
--
-- Recorded as a consequence discovered by building rather than one booked in
-- advance, because the alternative reading — that `20260904126000` got the
-- time-box wrong — is not true. It was right about the deals that could end then.
--
-- ---------- Exactly one outcome opens, and the other two stay shut ----------
--
-- `'completed'` only. Not `'cancelled'`, not `'reassigned'`, and not
-- `'disputed_resolved'` when it gets a producer in slice 8.
--
-- The rule is **whether the two of them finished something together**, which is
-- also the rule for whether there is anything to rate or dispute. A cancelled or
-- reassigned deal produced no work and no payment; a node who was reassigned off
-- a step has no ongoing claim on the owner's name and the owner has no reason to
-- read theirs. `'disputed_resolved'` is left out because slice 8 has not decided
-- what a resolved dispute leaves the two parties entitled to see, and guessing on
-- its behalf here is how a disclosure decision gets made by whoever wrote the
-- migration first.
--
-- **This is permanent rather than a grace window**, which is the part worth
-- arguing. A window would need a duration nobody has a basis for, and it would
-- expire in the middle of the thing it exists to support: ratings and disputes
-- both look backwards, and a dispute raised late is exactly the case where the
-- name matters most. What actually bounds the disclosure is that it is scoped to
-- **one completed deal between these two specific people** — not to the roster,
-- not to the room, and not to anybody else's node.
--
-- ---------- What still does not open ----------
--
-- `public.profiles` and nothing else: a display name and the basics a chat
-- surface needs, in both directions, exactly as `20260904126000` opened it.
-- `node_profiles` stays closed to the owner, `node_verifications` stays closed to
-- everyone including its own subject, `offers` stays closed to the owner, and
-- `private.shares_room_with` is untouched. Widening a time-box is not widening a
-- projection.

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
      -- Live, **or finished together**. See the header: the two of them
      -- completed a piece of work and were paid for it, which is the same
      -- condition under which either has anything to rate or dispute.
      and (e.ended_at is null or e.outcome = 'completed')
      and m.user_id = p_user
      and m.scope = 'room'
      and (m.expires_at is null or m.expires_at > now())
  )
  or exists (
    -- (b) **They are a node with a live or completed engagement on a project I am
    -- a member of.** `private.is_project_member` already requires a live,
    -- room-scoped membership, so the whole owner-side rule is one call and there
    -- is no second copy of the time-box to keep in step.
    select 1
    from public.engagements e
    where e.node_id = p_user
      and (e.ended_at is null or e.outcome = 'completed')
      and private.is_project_member(e.project_id)
  );
$$;

revoke all on function private.engaged_counterparty(uuid) from public;
grant execute on function private.engaged_counterparty(uuid) to anon, authenticated;

comment on function private.engaged_counterparty(uuid) is
  'Whether auth.uid() and p_user are the two sides of an engagement that is live OR was completed. '
  'Joins through engagements rather than room_members.thread_id: a membership row outlives the '
  'work and the owner shares no thread with the node, so the deal is the only row that knows both '
  'when the relationship started and how it ended. Completed deals stay readable permanently '
  'because ratings and disputes both look backwards; cancelled and reassigned deals close, '
  'because nothing was delivered on either.';
