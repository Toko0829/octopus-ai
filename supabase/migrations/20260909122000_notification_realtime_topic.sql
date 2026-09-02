-- 20260909122000_notification_realtime_topic.sql — the bell rings without a reload.
-- Owner doc: docs/30-modules/notifications.md
-- Also: docs/30-modules/chat-discord.md,
--       docs/10-architecture/security-compliance.md,
--       docs/40-adr/0003-realtime-broadcast-not-postgres-changes.md,
--       docs/40-adr/0028-a-notification-is-derived-from-the-event.md
--
-- Notifications slice 1, third migration. The table exists and derives itself;
-- this is what makes a row arrive at a person who is already looking at the page.
--
-- ---------- A third topic namespace ----------
--
-- `chat:room:<id>` and `chat:thread:<id>` have been the whole namespace since
-- `20260728120000` and `20260906120000`. This adds `notify:user:<uid>`, and it is
-- a different kind of topic from both: the chat topics address a **place** and
-- are joined by membership in it, while this one addresses a **person** and is
-- joined by being them.
--
-- That difference is the entire argument for the shape below, and it is worth
-- being precise because `20260906120000:47-56` refused a third policy in terms
-- that sound absolute:
--
--   > A separate additive policy would union to the same rows and leave **two
--   > copies of the `expires_at` time-box** to keep in step, which is the
--   > two-representations defect in the one place it must not be: an expired node
--   > would keep a live socket while correctly losing the rows.
--
-- Every word of that stands, and none of it reaches this topic. The thing it
-- protects is the time-box, and the time-box lives on `room_members.expires_at`.
-- **This topic has no membership row and therefore no time-box**: the predicate
-- is `auth.uid()`, which cannot go stale, cannot be revoked by a sweep, and has
-- no second copy to keep in step. Folding it into the room policies as a third
-- `OR` would bolt a predicate about a person onto two predicates about rooms,
-- and the next person to alter those policies would have to reason about all
-- three to change any one. A separate policy is the smaller object.
--
-- Recorded because it is checkable: `supabase/tests/thread_scope.sql` asserted
-- that `realtime.messages` carries exactly two policies. That assertion is
-- **amended rather than deleted** in this push, to three, with the reason above
-- written beside it, and `security-compliance.md:79` gets the same dated
-- amendment. An assertion about a count is only useful if changing the count is
-- something somebody has to argue for.
--
-- ---------- Receive only, and no send policy ----------
--
-- `20260728200000` added the INSERT half because `channel.track()` makes the
-- **client** write to `realtime.messages`, so without it every member silently
-- showed offline. There is no presence on an inbox: nobody is "in" their
-- notifications, the client calls `subscribe()` and never `track()`, and a send
-- policy would grant a write nothing performs. It is left out deliberately rather
-- than forgotten, which the pgTAP suite pins by asserting a node cannot push to
-- their own inbox topic.
--
-- The parity argument that carried the thread topic into both policies does not
-- transfer for the same reason it applied there: those two have been altered as a
-- pair since they were created and describe one thing from two directions. This
-- policy is not one of that pair.

-- ---------- The broadcaster ----------
--
-- `public.broadcast_message`'s call, unchanged, on one topic. In `private` rather
-- than `public` because every trigger function since `20260815` lives there and
-- `broadcast_message` predates that rule (`20260728160000`, the advisor lesson in
-- supabase/README.md:92).
--
-- `realtime.send()` traps its own exceptions, which `20260728120000` relies on
-- and this relies on harder: this trigger runs inside `settle_payout`, so a
-- broadcast that could raise would be a broadcast that could refuse to pay
-- somebody. The row is committed either way and the client's catch-up on
-- reconnect is what makes a dropped broadcast a delay rather than a loss.
create function private.broadcast_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform realtime.broadcast_changes(
    'notify:user:' || new.user_id::text, -- topic
    tg_op,                               -- event
    tg_op,                               -- operation
    tg_table_name,                       -- table
    tg_table_schema,                     -- schema
    new,                                 -- new record
    null                                 -- old record
  );
  return new;
end;
$$;

revoke all on function private.broadcast_notification() from public;

comment on function private.broadcast_notification() is
  'Broadcasts a new notification to its recipient''s own topic, notify:user:<uid>. One topic, '
  'because unlike a message a notification has exactly one audience. realtime.send traps its own '
  'exceptions, which matters here because this trigger runs inside settle_payout.';

create trigger notifications_broadcast
  after insert on public.notifications
  for each row
  execute function private.broadcast_notification();

-- ---------- The policy ----------
--
-- The narrowest predicate in this schema: the topic names a user and the reader
-- must be that user. No join, no helper, no time-box. Inlined like its two
-- neighbours because the input is `realtime.topic()` and a helper would not be
-- picked up by them either (`20260901122000:80-84`).
create policy "realtime_own_inbox_can_receive" on realtime.messages
  for select
  to authenticated
  using (realtime.topic() = 'notify:user:' || auth.uid()::text);
