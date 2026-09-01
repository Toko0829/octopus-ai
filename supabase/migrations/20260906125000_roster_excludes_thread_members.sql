-- 20260906125000_roster_excludes_thread_members.sql — the roster stops listing people
-- who cannot read the room.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/design-system-frontend.md, docs/30-modules/chat-discord.md,
--       docs/10-architecture/security-compliance.md
--
-- **A correction, and the second one this policy has needed.** It is not part of
-- slice 6's subject; it was found by looking at a real room with a real node in
-- it for the first time, which is the first moment this was observable at all.
--
-- ---------- What was wrong ----------
--
-- `design-system-frontend.md` states, as the reason a node's messages are badged
-- by role rather than by name:
--
--   "`room_members_select_member` gives a room-scoped member the room-scoped
--    roster plus their own row, so a thread-scoped membership is invisible to the
--    owner."
--
-- Measured against the live database as the owner: **two rows visible, one of
-- them thread-scoped.** The claim is false and has been since `20260901123000`.
--
-- The misreading is specific and worth naming, because it is the same one that
-- migration was written to fix, surviving on the other side of the same policy.
-- `private.member_scope_covers(room_id, null)` asks whether **the caller** is
-- room-scoped. It does not filter which **rows** come back. So a room-scoped
-- caller passes the predicate once and then sees every membership row in the
-- room. `20260901123000`'s header calls `room_members` "the one table where the
-- rows *are* the scopes"; that is exactly why a predicate about the caller reads
-- as though it were about the row.
--
-- ---------- Why narrow rather than rewrite the doc ----------
--
-- Both readings were defensible and this one is chosen for three reasons.
--
-- **The roster was making a false claim.** It listed a node under "in this room"
-- when that node cannot read the room, the channel list, or the room stream. An
-- affordance that overstates somebody's access is the shape this design system
-- already refuses elsewhere.
--
-- **The owner loses nothing.** They learn who took their step, at what price and
-- on what date, from the engagement line on the project panel, and they can read
-- the node's `profiles` row through `private.engaged_counterparty`
-- (`20260904126000`). That line is the designed channel for it, and this
-- migration does not touch it.
--
-- **The grant was to the wrong population.** It gave every room-scoped member
-- sight of every thread-scoped membership, not the owner specifically. Rooms have
-- one owner today, so nobody has been shown anything they should not be; but the
-- whole thread narrowing exists because room membership is coarser than the
-- access a node should have, and this was the mirror of that: node membership
-- visible at room granularity when the relationship is per-engagement.
--
-- ---------- What changes, and what deliberately does not ----------
--
-- One conjunct. `scope = 'room'` is added to the first disjunct, so it now reads
-- "a room-scoped caller sees room-scoped rows" rather than "a room-scoped caller
-- sees rows".
--
-- **The second disjunct is untouched**, and it is what keeps a thread-scoped
-- member able to see their own row: `user_id = auth.uid() and
-- private.is_room_member(room_id)`. `20260901123000` records why the second
-- conjunct is not redundant, and that reason is unchanged: without it an expired
-- member reads their own row back.
--
-- So the node's view does not move at all. `thread_scope.sql` asserts they see
-- exactly one row, and it still passes for exactly the same reason. What changes
-- is only what a room-scoped caller sees.
--
-- ---------- Why nothing caught it ----------
--
-- `thread_scope.sql` pins the narrow side hard: what a thread-scoped member sees,
-- what an expired one sees, and the one-row correction that migration was written
-- for. **It has never asserted what the OWNER sees on this table.** A policy too
-- generous to room-scoped callers therefore had nothing watching it, and the
-- symptom was invisible until a node existed in a real room, which happened for
-- the first time today. Both directions are asserted now.

alter policy "room_members_select_member" on public.room_members
  using (
    -- A room-scoped caller sees the room-scoped roster. The `scope = 'room'`
    -- here is about the ROW; the helper is about the CALLER. Conflating the two
    -- is the defect this migration corrects.
    (scope = 'room' and private.member_scope_covers(room_id, null))
    -- Anybody live sees their own row, whatever its scope. Unchanged.
    or (user_id = auth.uid() and private.is_room_member(room_id))
  );

comment on policy "room_members_select_member" on public.room_members is
  'A room-scoped member sees the room-scoped roster; anybody live sees their own row. '
  'The scope test is on the row and the helper is on the caller, and keeping those apart is '
  'the whole content of this policy: room_members is the one table where the rows are '
  'themselves the scopes. A thread-scoped node is deliberately absent from the roster, '
  'because they cannot read the room; the owner learns who took their step from the '
  'engagement line and from profiles through private.engaged_counterparty.';
