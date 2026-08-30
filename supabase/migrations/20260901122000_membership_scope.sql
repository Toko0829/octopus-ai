-- 20260901122000_membership_scope.sql — `scope` stops being a column nobody reads,
-- and the narrowing recorded twice finally lands.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/10-architecture/security-compliance.md,
--       docs/30-modules/human-nodes-marketplace.md, docs/30-modules/chat-discord.md,
--       docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md
--
-- `room_members.scope` has existed since `20260728120000` as `text not null
-- default 'room'` with **no check constraint and not one reader**: no policy, no
-- helper, no index, no trigger, and no server code. Every row on the live
-- database is 'room'. It is the fifth member of this repository's most-recorded
-- defect family, and the second of the worst-shaped kind, the kind that
-- announces itself as a control: `20260728120000` shipped it beside `expires_at`,
-- which *is* enforced everywhere, so the pair reads as though both are.
--
-- Two migrations have recorded the consequence as a KNOWN NARROWING landing
-- "with threads" (`20260813120000`, restated verbatim in `20260827110000`), and
-- security-compliance.md dates it to this slice. It lands here.
--
-- **One file, because a half-applied narrowing is a leak.** Every predicate that
-- must distinguish a room-scoped member from a thread-scoped one changes
-- together: nine policies and two helpers. Splitting them per table would create
-- an interval in which `threads` is narrow and `messages` is not, which is
-- exactly the state this migration exists to prevent.
--
-- ---------- What a thread-scoped member can see ----------
--
-- `private.is_room_member` is deliberately **unchanged** and still backs
-- `rooms_select_member`: a thread-scoped member sees the room row itself, because
-- a client that cannot read the room cannot render anything at all, and the room
-- row carries a name rather than any work. Everything below the shell narrows:
--
--   * their own thread's row in `threads`, and no other;
--   * only the channel their thread lives in;
--   * only messages carrying their `thread_id` — **never the null-thread room
--     stream**, which is the general conversation between the owner and the AI
--     and is the bulk of what a node must not read;
--   * only the embeds on messages they can already see;
--   * `room_members` rows of their own thread only;
--   * no `feedback_events` at all, since a verdict on the owner's plan is not
--     thread work;
--   * no project, no task, no artifact, no realtime.
--
-- **`member_scope_covers(room, null)` means "room-scoped members only"**, which
-- is a deliberate reading of the same helper rather than a second one, and is how
-- `feedback_events` is expressed. A null thread cannot be matched by
-- `m.thread_id = p_thread`, and the explicit `p_thread is not null` guard makes
-- that intentional rather than incidental: without it the expression would rest
-- on null comparison semantics to get the right answer, which is a correct result
-- for a reason the next reader has to derive.
--
-- ---------- Projects: the narrowing itself ----------
--
-- `private.is_project_member` gains `and m.scope = 'room'`, so a thread-scoped
-- member is **not a project member at all**. Not their task, not their project:
-- nothing. The alternative, scoping project visibility to the member's own task,
-- would have to join through `engagements`, which does not exist. That is the
-- same argument `20260831120000` made for leaving `node_profiles` with no
-- counterparty policy: a policy that cannot yet be written correctly should not
-- be written approximately. `private.artifact_object_project`
-- (`20260829124000`) terminates in this helper and inherits the narrowing with
-- no edit, which is the payoff for there being one definition.
--
-- ---------- Profiles: the leak nobody had named ----------
--
-- `private.shares_room_with` (`20260728190000`) backs `profiles_select_co_member`
-- and asks only whether two people share a room. Neither KNOWN NARROWING comment
-- mentions it, and it would have handed a thread-scoped node the display name,
-- jurisdiction and languages of **every member of the whole room**. It now
-- requires `scope = 'room'` on both sides. The consequence is stated rather than
-- glossed: the owner will eventually need to see their engaged node's profile,
-- and that policy joins through `engagements` too, so it is a named obligation on
-- the engagement slice rather than something approximated here.
-- `profiles_select_own` is untouched, so everyone still reads their own row.
--
-- ---------- Realtime: extended, not replaced ----------
--
-- security-compliance.md requires that thread topics **extend**
-- `realtime_room_members_can_receive` rather than replace it, "or an expired node
-- keeps a live socket to the room while correctly losing the rows". Both
-- `realtime.messages` policies inline their membership predicate rather than
-- calling a helper, because the input is `realtime.topic()` and the room id has to
-- be derived from the topic string, so neither picks up anything from the helper
-- rewrites above and both must be altered here explicitly.
--
-- They gain `and m.scope = 'room'` **in place**, via `alter policy`, which is the
-- move `20260728160000` used and is what "extend rather than replace" means: the
-- same policy, the same time-box, one more conjunct. A separate additive policy
-- would union correctly and leave two copies of the `expires_at` check to keep in
-- step, which is the two-representations defect (ADR-0015) in the one place it
-- must not be.
--
-- **There are no thread topics in this slice**, and that is deliberate rather
-- than forgotten. A `'chat:thread:' || m.thread_id` branch would have no
-- broadcaster (`broadcast_message()` emits one room topic) and no subscriber
-- (`ChatApp.tsx` subscribes per room), so it would be a third guard with no
-- writer in a migration whose entire subject is that anti-pattern. Until the
-- slice that first admits a node lands them, a thread-scoped member has **no
-- realtime at all** and reads through the since-cursor `GET`, which runs as the
-- caller and therefore returns exactly their thread. Slower, and correct: the
-- failure mode is a delay, not a disclosure. That obligation is written into
-- human-nodes-marketplace.md rather than left implied.
--
-- ---------- What is still not decided here ----------
--
-- `messages_insert_own` keeps `author_kind = 'user'`. A node posting as
-- `author_kind = 'node'` has no client path and gains none today; whether nodes
-- write through the server or through their own grant is the writer slice's
-- decision, and pre-deciding it here would be this repository's other recorded
-- mistake, a lifecycle guard landing before the writer whose transitions could be
-- wrong.

-- ---------- The column, and the constraints that make `scope` mean something ----------

alter table public.room_members add column thread_id uuid;

-- `on delete cascade`, unlike every other reference to `threads` in this slice: a
-- deleted thread is necessarily an empty one (`20260901121000` makes a thread
-- holding messages undeletable), and an admission to a thread that no longer
-- exists is not a record worth keeping. SET NULL would leave `scope = 'thread'`
-- with a null `thread_id` and trip the check below, which is a constraint
-- violation raised at the wrong moment about the wrong thing.
alter table public.room_members
  add constraint room_members_thread_in_same_room
  foreign key (thread_id, room_id) references public.threads (id, room_id)
  on delete cascade;

create index room_members_thread_idx on public.room_members (thread_id, room_id);

-- Checked text rather than an enum, and the reason is reversibility: `alter type
-- ... add value` cannot be rolled back (supabase/README.md), while a check
-- constraint is dropped and re-added in a normal migration. Converting the
-- existing column to an enum would also be a table rewrite bought for no
-- enforcement the check does not already give.
alter table public.room_members
  add constraint room_members_scope_known
  check (scope in ('room', 'thread'));

-- The pairing, both ways. A thread-scoped membership without a thread would be
-- invisible to every predicate below and would read as a bug in the policy; a
-- room-scoped membership carrying a thread would claim a narrowing it does not
-- have.
alter table public.room_members
  add constraint room_members_thread_iff_thread_id
  check ((scope = 'thread') = (thread_id is not null));

-- ---------- Scope-aware membership helpers ----------
--
-- SECURITY DEFINER for the reason `private.is_room_member` is: a policy on
-- `messages` that queried `room_members` would otherwise evaluate that table's
-- own policies. In `private` so PostgREST does not expose them as RPC (advisor
-- lints 0028 / 0029, which `20260728160000` exists to clear).

create function private.member_scope_covers(p_room uuid, p_thread uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = p_room
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
      and (
        m.scope = 'room'
        or (p_thread is not null and m.thread_id = p_thread)
      )
  );
$$;

create function private.member_scope_covers_channel(p_room uuid, p_channel uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = p_room
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
      and (
        m.scope = 'room'
        or exists (
          select 1
          from public.threads t
          where t.id = m.thread_id
            and t.channel_id = p_channel
        )
      )
  );
$$;

-- Takes the message rather than its room and thread, because `action_embeds`
-- carries `message_id` and a denormalised `room_id` but no thread, and inventing
-- one there would be a second place for the same fact. `20260812120000` states
-- the invariant this preserves: an embed is never visible to somebody who cannot
-- see the message it belongs to. Plain `is_room_member(room_id)` stopped
-- guaranteeing that the moment messages became thread-scoped.
create function private.member_scope_covers_message(p_message uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.messages msg
    join public.room_members m on m.room_id = msg.room_id
    where msg.id = p_message
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
      and (
        m.scope = 'room'
        or (msg.thread_id is not null and m.thread_id = msg.thread_id)
      )
  );
$$;

-- anon keeps EXECUTE for the standing reason: an unauthenticated select must
-- resolve to zero rows (auth.uid() is null) rather than a permission error.
revoke all on function private.member_scope_covers(uuid, uuid) from public;
grant execute on function private.member_scope_covers(uuid, uuid) to anon, authenticated;

revoke all on function private.member_scope_covers_channel(uuid, uuid) from public;
grant execute on function private.member_scope_covers_channel(uuid, uuid) to anon, authenticated;

revoke all on function private.member_scope_covers_message(uuid) from public;
grant execute on function private.member_scope_covers_message(uuid) to anon, authenticated;

-- ---------- Repoint the policies ----------
--
-- `rooms_select_member` is NOT in this list, deliberately: see the header.

alter policy "messages_select_member" on public.messages
  using (private.member_scope_covers(room_id, thread_id));

alter policy "messages_insert_own" on public.messages
  with check (
    private.member_scope_covers(room_id, thread_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

alter policy "channels_select_member" on public.channels
  using (private.member_scope_covers_channel(room_id, id));

alter policy "room_members_select_member" on public.room_members
  using (private.member_scope_covers(room_id, thread_id));

alter policy "threads_select_member" on public.threads
  using (private.member_scope_covers(room_id, id));

alter policy "action_embeds_select_member" on public.action_embeds
  using (private.member_scope_covers_message(message_id));

-- Room-scoped members only. A plan verdict is the owner's, not thread work.
alter policy "feedback_events_select_member" on public.feedback_events
  using (private.member_scope_covers(room_id, null));

-- ---------- Realtime: the same policies, one conjunct wider ----------

alter policy "realtime_room_members_can_receive" on realtime.messages
  using (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and m.scope = 'room'
        and realtime.topic() = 'chat:room:' || m.room_id::text
    )
  );

alter policy "realtime_room_members_can_send" on realtime.messages
  with check (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and m.scope = 'room'
        and realtime.topic() = 'chat:room:' || m.room_id::text
    )
  );

-- ---------- The workflow narrowing ----------

create or replace function private.is_project_member(p_project uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  with rooms_for_project as (
    -- The durable link: the room the project's plan card was posted in.
    select ae.room_id
    from public.projects p
    join public.action_embeds ae on ae.id = p.source_embed_id
    where p.id = p_project

    union

    -- The legacy link, for projects that predate source_embed_id.
    select r.id
    from public.rooms r
    where r.project_id = p_project
  )
  select exists (
    select 1
    from rooms_for_project rp
    join public.room_members m on m.room_id = rp.room_id
    where m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
      and m.scope = 'room'
  );
$$;

comment on function private.is_project_member(uuid) is
  'Membership for every workflow table. Resolves the project to its room through '
  'the plan card it was materialised from (projects.source_embed_id), because '
  'rooms.project_id is claimed by the first project approved in a room and is '
  'therefore not an access path. Both links are accepted; both require a live '
  'room_members row for auth.uid() whose scope is the whole room. A thread-scoped '
  'member is not a project member: task-level project visibility joins through '
  'engagements, which does not exist yet.';

revoke all on function private.is_project_member(uuid) from public;
grant execute on function private.is_project_member(uuid) to anon, authenticated;

-- ---------- The profile narrowing ----------

create or replace function private.shares_room_with(p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user
      and (mine.expires_at is null or mine.expires_at > now())
      and (theirs.expires_at is null or theirs.expires_at > now())
      and mine.scope = 'room'
      and theirs.scope = 'room'
  );
$$;

comment on function private.shares_room_with(uuid) is
  'Profile basics for the member list. Both sides must be room-scoped: a thread-scoped node '
  'must not read the room roster, and the owner reading their engaged node''s profile is a '
  'counterparty policy that joins through engagements and is deferred to that slice.';

revoke all on function private.shares_room_with(uuid) from public;
grant execute on function private.shares_room_with(uuid) to anon, authenticated;

-- ---------- Column documentation ----------

comment on column public.room_members.scope is
  'Whether this membership covers the whole room or exactly one thread. Enforced since '
  '20260901122000: it had been an unread column with no check constraint since 20260728120000. '
  'A thread-scoped member sees the room shell, their thread, its channel and its messages, '
  'and is not a project member.';

comment on column public.room_members.thread_id is
  'The thread a thread-scoped membership is confined to, null for a room-scoped one; the check '
  'constraint binds the two together. Thread admission is a property of the membership rather '
  'than a second table, so there is one predicate family to keep right (ADR-0017).';
