-- 20260901123000_room_members_thread_scope.sql — a thread-scoped member sees their
-- own membership row and no one else's.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/10-architecture/security-compliance.md,
--       docs/30-modules/human-nodes-marketplace.md
--
-- **Found by running the suite rather than by reading it**, which is the second
-- time this repository has recorded that sentence and the first time it caught a
-- policy rather than a fixture.
--
-- `20260901122000` gave `room_members` the same predicate as `messages`:
-- `private.member_scope_covers(room_id, thread_id)`. On `messages` that is exactly
-- right, because the argument is the row's own thread and the question is "does
-- the caller's scope reach this row". On `room_members` the same expression
-- quietly asks a different question, because the rows *are* the scopes: a
-- thread-scoped member matched **every membership row pointing at their own
-- thread**, not merely their own. `thread_scope.sql` asserted 1 and measured 2.
--
-- The second row was `texpired`: a node whose access to that very thread had
-- already lapsed. So the shape of the leak is worth stating precisely, since the
-- count alone understates it. A node would have learned the `user_id`, `role`,
-- `joined_at` and `expires_at` of **other people admitted to their task**,
-- including people already removed from it. `profiles` is closed to them by the
-- same slice, so it is a bare identifier rather than a name, and it is still a
-- fact about a third party that the reader has no need for and no relationship
-- with. That is the concern `node_verifications` was given no policy at all for
-- (`20260831123000`): a row that names somebody other than its subject does not
-- belong to its subject.
--
-- **Own row only, and the narrowing is deliberate rather than minimal.** Two
-- nodes working the same thread arguably should see each other eventually, and
-- that is precisely the counterparty question this slice has already refused to
-- answer approximately twice: `private.shares_room_with` was closed on both sides
-- and `node_profiles` has no counterparty policy, both deferred to the slice where
-- `engagements` exists to join through. Answering it here, for one table, in the
-- migration that cannot see an engagement, would be the third representation of a
-- rule the other two are waiting to state once.
--
-- The predicate is two clauses and each earns its place:
--
--   * `member_scope_covers(room_id, null)` is the established reading of that
--     helper for "room-scoped members only" (`feedback_events` uses it the same
--     way), so the roster is unchanged for everybody who has it today.
--   * `user_id = auth.uid() and is_room_member(room_id)` gives a thread-scoped
--     member their own row. The second half is not redundant: without it an
--     **expired** member would read their own row back, because `user_id =
--     auth.uid()` is true regardless of the time-box, and "an expired node sees
--     nothing at all" is a property `rls_membership.sql` has asserted since
--     `20260728160000`. Measured both ways in `thread_scope.sql`.
--
-- `20260901122000` is left exactly as it was applied. It is recorded in
-- `schema_migrations` with its statements, and editing an applied migration to
-- hide a correction is how the recorded body stops matching the file, which is
-- the drift `supabase/README.md` exists to catch.

alter policy "room_members_select_member" on public.room_members
  using (
    private.member_scope_covers(room_id, null)
    or (user_id = auth.uid() and private.is_room_member(room_id))
  );
