-- 20260904126000_counterparty_via_engagements.sql — the counterparty pair,
-- deferred three times and opened here through the table it was always waiting
-- for.
-- Owner doc: docs/10-architecture/security-compliance.md
-- Also: docs/10-architecture/data-model.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/30-modules/auth-identity.md,
--       docs/40-adr/0016-an-engagement-has-no-state-of-its-own.md
--
-- **Three migrations deferred this by name, and all three named this slice.**
--
--   * `20260831120000` left `node_profiles` with no counterparty policy, because
--     "a policy that cannot yet be written correctly should not be written
--     approximately".
--   * `20260901122000` narrowed `private.shares_room_with` to require `scope =
--     'room'` on **both** sides, closing a leak neither KNOWN NARROWING comment
--     had named, and said in its own header that the owner reading their engaged
--     node's profile "joins through `engagements` too, so it is a named
--     obligation on the engagement slice".
--   * `20260901123000` refused to answer it for one table, saying that doing so
--     "in the migration that cannot see an engagement, would be the third
--     representation of a rule the other two are waiting to state once".
--
-- `engagements` exists now, so it is stated once, here.
--
-- ---------- The join is through `engagements`, never through `room_members` ----------
--
-- The tempting shortcut is `room_members.thread_id`: two people pointing at the
-- same thread must be counterparties. It is wrong in both directions and the
-- difference is not academic.
--
--   * **It is too wide.** A membership row survives the work. When the reconcile
--     sweep or slice 6 ends an engagement it stamps `expires_at`, and an expired
--     row is still a row; a predicate reading memberships would have to
--     re-implement the time-box, which is the duplicated-`expires_at` problem
--     `20260901122000` refused for realtime.
--   * **It is too narrow.** The owner is room-scoped and carries no `thread_id`
--     at all, so "we share a thread" is false for exactly the person the owner
--     half of this pair exists to serve.
--   * **It answers the wrong question.** Sharing a thread is a chat fact. Being
--     counterparties is a *deal* fact, and the deal is the row that knows when it
--     started and when it stopped.
--
-- `ended_at is null` is therefore the whole time-box: **ending the engagement
-- closes the pair again**, with no second copy of any expiry rule.
--
-- ---------- What this does NOT open, and why each stays shut ----------
--
--   * **`node_profiles` stays closed.** The owner learns who took their step from
--     the engagement projection the API builds: a display name, the agreed price,
--     the date. What `node_profiles` additionally carries is the node's rate,
--     their service jurisdictions, their trust score and their availability, and
--     none of that is a fact about *this deal*. The projection is the access
--     control, exactly as it is for `offers` and for channel connections.
--   * **`offers` stays closed**, and this migration is the reason to say so
--     again rather than the reason to change it. An offer names every node who
--     was *asked*, including the ones who declined and the one whose offer
--     expired. Publishing a decline trail to the owner is a disclosure decision
--     with real consequences for people who said no, and this slice does not have
--     to make it in order to ship acceptance. `marketplace_offers.sql` keeps
--     asserting the owner's zero; only the message changes, to name the
--     projection rather than to promise this slice would open it.
--   * **`node_verifications` is untouched.** It has no policy at all and refuses
--     even its own subject, because a face-search result names a third party. A
--     counterparty is the last person who should read it.
--   * **`private.shares_room_with` is untouched.** It answers "we are in the same
--     room, both fully", which is the member-list question, and it is still
--     exactly right for that. This is a **second policy** on `profiles` rather
--     than a widening of the first, so the two questions stay separable and the
--     roster narrowing cannot be lost by editing the counterparty rule.

-- ---------- The helper ----------
--
-- SECURITY DEFINER for the reason every membership helper here is: a policy on
-- `profiles` that queried `engagements` would otherwise evaluate that table's own
-- policies, and `engagements_select_node` would make the answer depend on who is
-- asking in a way the policy is trying to decide. In `private` so PostgREST does
-- not expose it as RPC (advisor lints 0028 / 0029, which `20260728160000` exists
-- to clear).
--
-- `stable`, not `immutable`: it reads tables.
--
-- **`anon` keeps EXECUTE**, the standing reason: an unauthenticated select must
-- resolve to zero rows (`auth.uid()` is null on both sides) rather than to a
-- permission error, because through PostgREST those look identical and one of
-- them is a bug.
create function private.engaged_counterparty(p_user uuid)
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
      and e.ended_at is null
      and m.user_id = p_user
      and m.scope = 'room'
      and (m.expires_at is null or m.expires_at > now())
  )
  or exists (
    -- (b) **They are a node with a live engagement on a project I am a member
    -- of.** `private.is_project_member` already requires a live, room-scoped
    -- membership, so the whole owner-side rule is one call and there is no second
    -- copy of the time-box to keep in step.
    select 1
    from public.engagements e
    where e.node_id = p_user
      and e.ended_at is null
      and private.is_project_member(e.project_id)
  );
$$;

revoke all on function private.engaged_counterparty(uuid) from public;
grant execute on function private.engaged_counterparty(uuid) to anon, authenticated;

comment on function private.engaged_counterparty(uuid) is
  'Whether auth.uid() and p_user are the two sides of a live engagement. Joins through '
  'engagements rather than room_members.thread_id: a membership row outlives the work and the '
  'owner shares no thread with the node, so the deal is the only row that knows both when the '
  'relationship started and when it stopped. ended_at is null is the entire time-box.';

-- ---------- The policy ----------
--
-- A second policy on `profiles`, unioned by Postgres with the two that exist.
-- `profiles_select_own` and `profiles_select_co_member` are both untouched.
--
-- What this opens is `profiles`, which carries display name, avatar and the
-- basics a chat surface needs to render a person. That is precisely what both
-- sides need and no more: the owner sees who took their step, and the node sees
-- who they are working for instead of an empty room with a bare uuid in it.
create policy "profiles_select_counterparty" on public.profiles
  for select using (private.engaged_counterparty(user_id));
