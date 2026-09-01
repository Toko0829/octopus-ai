-- 20260906120000_thread_realtime_topics.sql — a thread-scoped member finally gets a socket.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/chat-discord.md, docs/10-architecture/security-compliance.md,
--       docs/30-modules/human-nodes-marketplace.md
--
-- Slice 6 of the marketplace sequence, first migration.
--
-- `20260901122000` narrowed both `realtime.messages` policies with `and m.scope =
-- 'room'`, which is correct and left a thread-scoped node with **no realtime at
-- all**. Slice 5 accepted that explicitly rather than deferring the question a
-- third time: the node console reads its thread through the since-cursor `GET` on
-- a ten-second interval, which runs as the caller, so the failure mode is a delay
-- rather than a disclosure. Three files then booked topics to this slice by name
-- (`chat-discord.md`, `security-compliance.md`, and `thread_scope.sql`'s own
-- assertion message).
--
-- **The broadcaster and the policy land in one file, and that is the whole point
-- of the ordering.** `20260901122000:93-102` refused to add a `'chat:thread:'`
-- branch to the policies on the grounds that it "would have no broadcaster and no
-- subscriber, so it would be a third guard with no writer in a migration whose
-- entire subject is that anti-pattern". Splitting them here would reproduce
-- exactly that, in either direction: a policy with nothing emitting is a guard
-- over an empty set, and an emitter with no policy is a topic nobody may join.
-- The subscriber lands in the same push, in `apps/web/app/node/NodeConsole.tsx`.
--
-- ---------- Two topics, not one, and the owner is the reason ----------
--
-- A thread message now broadcasts to **both** `chat:room:<room>` and
-- `chat:thread:<thread>`, rather than being moved from the first to the second.
--
-- The owner is room-scoped. They are entitled to read their node's thread
-- messages and already do: `messages_select_member` returns them, and the stream
-- marks them "in a task thread" rather than hiding them, because hiding work the
-- owner is paying for is the fetched-never-rendered defect this repository has
-- recorded twice. Moving a thread message onto the thread topic alone would take
-- that away from them **in realtime only**, so the row would arrive on the next
-- fetch and not on the socket. That is a regression that presents as "the chat is
-- slow for some messages and not others", which is the worst shape a delivery bug
-- can take.
--
-- Broadcasting twice is therefore not redundancy, it is the two audiences the row
-- actually has. `realtime.send()` traps its own exceptions
-- (`20260728120000`), so neither call can undo the INSERT that is already
-- committed, and a client subscribed to both topics (nobody today) would dedupe
-- on `messages.id` the way `ChatApp.tsx` already does.
--
-- ---------- Extended in place, never a third policy ----------
--
-- Both policies gain **one `OR` disjunct** through `alter policy`, which is the
-- move `20260728160000` used and `20260901122000` used again. A separate additive
-- policy would union to the same rows and leave **two copies of the `expires_at`
-- time-box** to keep in step, which is the two-representations defect
-- ([ADR-0015](../../docs/40-adr/0015-service-geo-is-a-jurisdiction-code.md)) in
-- the one place it must not be: an expired node would keep a live socket while
-- correctly losing the rows. security-compliance.md requires the extension shape
-- in as many words.
--
-- The disjunct is deliberately **narrower than the room half**. A room-scoped
-- member may only ever match the room topic; a thread-scoped member may only ever
-- match their own thread's topic. Neither can reach the other, which is what
-- keeps the node off the owner's conversation with the AI (the null-thread room
-- stream) and keeps the owner's socket unchanged.
--
-- **The send half gains the same disjunct**, for parity rather than for a
-- feature. It is the INSERT policy, so it governs `channel.track()` presence, and
-- there is no thread presence UI: nothing pushes on a thread topic today, and the
-- only member whose scope covers a given thread topic is the node themselves. It
-- is extended anyway because these two policies have been written and altered as
-- a pair since they were created, a private channel evaluates both on join, and a
-- pair that disagrees about which topics exist is a difference somebody has to
-- rediscover. When thread presence gets a surface it needs no migration.
--
-- ---------- What this does not do ----------
--
-- No table changes, no grants, no helper. `member_scope_covers` is not called
-- here for the reason `20260901122000:80-84` gives: the input is
-- `realtime.topic()`, so the room and thread ids have to be derived from the
-- topic string and neither policy can pick anything up from a helper rewrite.
-- Both predicates stay inlined, and that is why both had to be altered
-- explicitly.

-- ---------- The broadcaster ----------

create or replace function public.broadcast_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The room topic, unchanged and unconditional. Every member who may read this
  -- row through `messages_select_member` is either room-scoped (and reads it
  -- here) or thread-scoped (and reads it below).
  perform realtime.broadcast_changes(
    'chat:room:' || new.room_id::text, -- topic
    tg_op,                             -- event
    tg_op,                             -- operation
    tg_table_name,                     -- table
    tg_table_schema,                   -- schema
    new,                               -- new record
    null                               -- old record
  );

  -- The thread topic, when there is one. A room-scoped member is not subscribed
  -- to it and does not need to be; this exists so the one person who cannot
  -- subscribe to the room topic still hears their own thread.
  if new.thread_id is not null then
    perform realtime.broadcast_changes(
      'chat:thread:' || new.thread_id::text,
      tg_op,
      tg_op,
      tg_table_name,
      tg_table_schema,
      new,
      null
    );
  end if;

  return new;
end;
$$;

comment on function public.broadcast_message() is
  'Broadcasts a new message to its room topic, and additionally to its thread topic when '
  'it carries one. Two topics rather than one because the row has two audiences: the '
  'room-scoped owner, who is entitled to read thread messages and reads them on the room '
  'topic, and the thread-scoped node, who may not subscribe to the room topic at all.';

-- ---------- The two policies, one conjunct wider each ----------

alter policy "realtime_room_members_can_receive" on realtime.messages
  using (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and (
          (m.scope = 'room' and realtime.topic() = 'chat:room:' || m.room_id::text)
          or (
            m.scope = 'thread'
            and m.thread_id is not null
            and realtime.topic() = 'chat:thread:' || m.thread_id::text
          )
        )
    )
  );

alter policy "realtime_room_members_can_send" on realtime.messages
  with check (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and (
          (m.scope = 'room' and realtime.topic() = 'chat:room:' || m.room_id::text)
          or (
            m.scope = 'thread'
            and m.thread_id is not null
            and realtime.topic() = 'chat:thread:' || m.thread_id::text
          )
        )
    )
  );
