-- 20260728200000_realtime_presence_policy.sql — let room members publish presence.
-- Owner doc: docs/10-architecture/data-model.md · spec: docs/20-design/discord-chat-spec.md
--
-- 20260728120000_chat.sql added only a SELECT policy on realtime.messages, which is
-- enough to RECEIVE broadcasts (they originate from a SECURITY DEFINER trigger, so
-- the sender is the database, not the user). Presence is different: channel.track()
-- makes the client itself write to realtime.messages, so without an INSERT policy
-- every member silently shows as offline. Caught in the browser, where the signed-in
-- user appeared offline in their own room.

create policy "realtime_room_members_can_send" on realtime.messages
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and realtime.topic() = 'chat:room:' || m.room_id::text
    )
  );
