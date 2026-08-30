-- 20260901121000_messages_thread_id.sql — a message can belong to a thread, and
-- one constraint proves three things about it.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/chat-discord.md
--
-- `data-model.md` has carried `messages.thread_id?` since Phase 0 with nothing
-- behind it. It lands now rather than with the thread writer because
-- `20260901122000` narrows the messages policy to a per-message thread predicate,
-- and a policy cannot read a column that does not exist.
--
-- **The composite foreign key is doing three jobs at once**, which is why it is
-- shaped this way rather than as a plain `references public.threads (id)`.
--
--   1. **Pairing.** A message's thread must be in the message's own room.
--      `messages.ts` already checks the analogous channel/room pairing in the
--      handler, with a comment saying RLS cannot express it; that check exists
--      because a route is the only place it could live. Here it can live in the
--      table, so it does. MATCH SIMPLE is what makes this free for the existing
--      corpus: when any column of the key is null the constraint is not checked
--      at all, so every message written to date is unaffected and no backfill is
--      needed.
--   2. **A nonempty thread cannot be deleted.** This is the half worth arguing.
--      `on delete set null` was the obvious choice, matching `channel_id`
--      directly above, and it is wrong here: silently setting `thread_id` to null
--      would move every message of a deleted thread back into the room's
--      general stream, which both destroys the container the audit trail was
--      being read through and *widens* who can see those messages, since
--      `20260901122000` gives room-scoped members the null-thread messages. A
--      deletion must not be a disclosure.
--   3. **Whole-room deletion still works.** NO ACTION rather than RESTRICT is the
--      difference: RESTRICT is checked immediately, NO ACTION at end of
--      statement. Deleting a room cascades to `messages` and `threads` both, and
--      by the time the check runs there are no referencing rows left. RESTRICT
--      would have made rooms undeletable, which is a real regression rather than
--      a theoretical one. Verified against the live database in a rolled-back
--      transaction rather than argued from the manual.
--
-- **Nothing else changes, on purpose.** The broadcast trigger
-- (`20260728120000`) sends the whole NEW row, so `thread_id` starts travelling on
-- every broadcast the moment this column exists, with no trigger edit. That is
-- precisely why `20260901122000` must make the two `realtime.messages` policies
-- scope-aware in the same push: a future thread-scoped member subscribed to the
-- room topic would otherwise receive the payload of every message in the room
-- while correctly seeing none of the rows.
--
-- `packages/contracts`' `Message` schema and `apps/api`'s `SELECT_COLUMNS` are
-- deliberately untouched. An unpinned PostgREST select simply does not ask for
-- the column, so no response shape changes and no client can observe this
-- migration. The reader lands with the slice that has something to read.
--
-- The index covers the constraint rather than a query: see `20260901120000`'s
-- header on why a foreign key is itself a query, and note that `messages` is the
-- one table here that grows without bound.

alter table public.messages add column thread_id uuid;

alter table public.messages
  add constraint messages_thread_in_same_room
  foreign key (thread_id, room_id) references public.threads (id, room_id);

create index messages_thread_idx on public.messages (thread_id, room_id);

comment on column public.messages.thread_id is
  'The thread this message belongs to, or null for the channel-level stream. Constrained to a '
  'thread in the same room, and NO ACTION rather than SET NULL: re-homing a deleted thread''s '
  'messages into the room stream would widen who can read them.';
