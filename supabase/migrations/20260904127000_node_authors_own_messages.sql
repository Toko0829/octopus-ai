-- 20260904127000_node_authors_own_messages.sql — `author_kind = 'node'` gets its
-- writer, and the node posts through their own grant.
-- Owner doc: docs/30-modules/chat-discord.md
-- Also: docs/10-architecture/data-model.md,
--       docs/10-architecture/security-compliance.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md
--
-- The third of three obligations `20260901122000` and the marketplace doc booked
-- to "the writer slice", and the only one that was left as an open question
-- rather than a deferred implementation: "**Whether nodes write through the
-- server or through their own grant is the writer slice's decision.**" This file
-- decides it.
--
-- ---------- The decision: their own grant, through the existing client path ----------
--
-- **Rule 5 is the argument.** "The AI participates by INSERTing message rows like
-- any member — no special path." That is stated about the agent and it is a claim
-- about the shape of chat rather than about who the agent is: every participant
-- writes the same way, and Postgres decides who may. A node is a participant.
--
-- The alternative was a server-mediated write: a `POST /api/node/messages` route
-- inserting with the secret key. It was rejected for a specific, checkable
-- reason rather than a stylistic one. **It would be a second write path to keep
-- in step with the first**, and the two would drift on exactly the things that
-- are easy to forget and expensive to get wrong: the idempotency key contract,
-- the channel/room pairing check, the thread/room pairing check, the broadcast
-- trigger's payload, and the shape of a 409 on a replayed send. `messages.ts`
-- already implements all five, and a node posting through it inherits every one.
--
-- It also inverts the security posture in the wrong direction. A server-mediated
-- write is a `service_role` insert whose only control is the route; this widening
-- is a client insert that RLS re-checks independently, which is defense in depth
-- (rule 6) rather than a route somebody could later call with a different
-- `thread_id`.
--
-- **The route derives `author_kind`, and RLS re-checks it.** `messages.ts` reads
-- the caller's OWN membership row: `human_node` + `scope = 'thread'` becomes
-- `'node'`, everything else stays `'user'`. The client never sends it, exactly as
-- it never sends `author_id`. The policy below then asserts the same fact from
-- the same row, so a caller who forged `author_kind` in a hand-rolled request
-- gets an RLS refusal rather than a mislabelled message in somebody's audit
-- trail.
--
-- ---------- Widened, not moved ----------
--
-- The existing predicate is kept whole and a disjunct is added beside it.
-- `private.member_scope_covers(room_id, thread_id)` and `author_id = auth.uid()`
-- are unchanged, so:
--
--   * a room-scoped member still posts to the room stream as `'user'`, which is
--     the assertion `thread_scope.sql` already makes and which must keep passing;
--   * a thread-scoped node posting as `'user'` **still works**, because the first
--     disjunct is `author_kind = 'user'` with no scope condition on it. That is
--     deliberate: `thread_scope.sql` asserts exactly that today, and a narrowing
--     that broke it would be this migration quietly removing a capability while
--     appearing to add one;
--   * nobody gains `'agent'` or `'system'`. Both are still refused to every
--     client, and both still arrive only through the secret key.
--
-- The `human_node` role is required as well as the thread scope. `scope =
-- 'thread'` alone would let any future thread-scoped membership author as a node,
-- and the role is what says which kind of participant this is. `accept_offer` is
-- the only writer of such a row and it sets both.

alter policy "messages_insert_own" on public.messages
  with check (
    private.member_scope_covers(room_id, thread_id)
    and author_id = auth.uid()
    and (
      author_kind = 'user'
      or (
        author_kind = 'node'
        and thread_id is not null
        and exists (
          select 1
          from public.room_members m
          where m.room_id = messages.room_id
            and m.user_id = auth.uid()
            and m.role = 'human_node'
            and m.scope = 'thread'
            and m.thread_id = messages.thread_id
            and (m.expires_at is null or m.expires_at > now())
        )
      )
    )
  );

comment on column public.messages.author_kind is
  'Who wrote this. user and node are client-writable through messages_insert_own; node requires '
  'a live human_node thread-scoped membership matching the message''s room AND thread, so a node '
  'can only author inside the thread they were admitted to. agent and system arrive only through '
  'the secret key. The route derives the value from the caller''s membership row and RLS '
  're-checks it independently.';
