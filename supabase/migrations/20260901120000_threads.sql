-- 20260901120000_threads.sql — a thread exists, and nothing can create one.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/chat-discord.md, docs/30-modules/human-nodes-marketplace.md,
--       docs/10-architecture/security-compliance.md,
--       docs/40-adr/0017-thread-admission-is-a-property-of-the-membership.md
--
-- **Why now, and why nothing can write here.** `escalated` is the last live dead
-- end in the product: `packages/core/src/router.ts` sends every human-owned step
-- there because "it goes to the marketplace", and twelve tasks sit in that state
-- on the live database. The marketplace sequence in human-nodes-marketplace.md
-- puts threads **second**, ahead of every writer, because security-compliance.md
-- requires a human node to see only its engaged task thread, time-boxed, and room
-- membership is coarser than that. Admitting a node to a room today would show
-- them the entire project DAG.
--
-- So this is `20260831120000`'s ordering repeated, which is itself
-- `20260829120000`'s: guards land before writers, because the recorded failure in
-- this repository is the other order five times over (`tasks.risk_tier`
-- unreachable for its whole life, `task_deps` empty for two weeks,
-- `artifacts.storage_path` with no bucket, `projects.budget_ceiling` with no
-- writer, and a role-escalation guard that was only a sentence in a comment).
-- **Zero new capability**: no route, no writer, and no client grant that permits
-- an insert. There is nothing a person can do after this migration that they
-- could not do before it. What changes is what a *future* thread-scoped member
-- will be able to see, and `20260901122000` is where that is decided.
--
-- **`room_id` is denormalised beside `channel_id`**, on `action_embeds`'
-- precedent (`20260812120000`), which carries `room_id` next to `message_id` for
-- exactly this reason: the policy becomes a plain membership call instead of a
-- join, and there is one definition of tenancy to get right rather than one per
-- table. The composite foreign key below is what keeps the denormalised copy
-- honest, so it is a shortcut with a constraint behind it rather than a second
-- source of truth.
--
-- **A thread provably lives in a channel of its own room.** `channels` gains
-- `unique (id, room_id)` purely as a foreign-key target, so `(channel_id,
-- room_id)` can reference it. Postgres then refuses a thread whose channel
-- belongs to some other room. The alternative was a trigger, or a check in the
-- route that will eventually create threads; this repository's stance is the one
-- `task_deps` acyclicity took, which is that a structural truth belongs in the
-- table rather than in whichever caller remembers it.
--
-- **`task_id` is a plain unique: one thread per task, ever.** A no-show and a
-- reassignment produce a second engagement (ADR-0016) and must not produce a
-- second thread, because the audit trail of a task is the thing being read
-- afterwards and fragmenting it per engagement is how "what happened on this
-- task" stops having an answer. `on delete set null` rather than cascade: chat
-- history outlives the work item, the same stance `messages.channel_id` takes.
--
-- **The foreign keys are NO ACTION and that is load-bearing**, argued fully in
-- `20260901121000` where the consequence bites. Briefly: a thread holding
-- messages cannot be deleted, while deleting a whole room still works, because
-- NO ACTION is checked at end of statement and the room's cascade has removed the
-- referencing rows by then. RESTRICT checks immediately and would break the room
-- delete.
--
-- **On the indexes.** `node_credentials` (`20260831122000`) declined an expiry
-- index because it "would serve a sweep that does not exist", and that argument
-- is not this one: a foreign key *is* a query, run on every delete of the parent
-- row, from the moment the constraint exists. Unindexed, each becomes a
-- sequential scan of the child table, and for `20260901121000`'s constraint the
-- child is `messages`, the table that actually grows. These will report as
-- `unused_index` until their readers land, which is the honest lint of the pair:
-- the alternative, `unindexed_foreign_keys`, names a cost that is real today.

-- ---------- Foreign-key target ----------

-- `id` is already unique on its own. This exists so `(channel_id, room_id)` has
-- something to point at, which is what makes the denormalised room_id checkable.
alter table public.channels
  add constraint channels_id_room_key unique (id, room_id);

-- ---------- Table ----------

create table public.threads (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  channel_id uuid not null,
  -- The join that makes "a node sees only its engaged task's thread" expressible
  -- at all. Nullable, because a thread about a subject rather than a work item is
  -- the Zulip-style topic the design spec also asks for.
  task_id    uuid unique references public.tasks (id) on delete set null,
  title      text not null,
  created_at timestamptz not null default now(),

  -- The foreign-key target for messages and room_members, which both need to
  -- prove a thread reference stays inside one room.
  unique (id, room_id),

  -- NO ACTION, deliberately: see the header and 20260901121000.
  foreign key (channel_id, room_id) references public.channels (id, room_id)
);

create index threads_room_idx on public.threads (room_id);
create index threads_channel_idx on public.threads (channel_id, room_id);

-- ---------- RLS and grants ----------

alter table public.threads enable row level security;

-- Lands wide and is narrowed by `20260901122000` to
-- `private.member_scope_covers(room_id, id)`, once that migration defines the
-- helper. The interval is safe rather than merely short: `scope` has no value
-- other than 'room' until the same migration allows one, so no thread-scoped
-- member can exist in between, and all three files land in one push.
create policy "threads_select_member" on public.threads
  for select using (private.is_room_member(room_id));

-- **No insert, update or delete policy, and no client grant beyond select.**
-- Thread creation lands with the writer that first needs it, which is the matcher
-- slice: a thread with no engagement to hold is the `escalated` dead end rebuilt
-- one table over. RLS filters rows a grant already permits; it is not itself a
-- grant, and omitting the grant is what made every table unreachable in
-- `20260728170000`.
grant select on public.threads to authenticated;
grant all on public.threads to service_role;

comment on table public.threads is
  'Sub-conversations within a channel. A node engagement will live in one, which is why '
  'the table exists before any writer: room membership is coarser than the thread-scoped, '
  'time-boxed access a node requires. Client-readable through membership, server-written; '
  'no write policy and no client write grant, deliberately.';

comment on column public.threads.task_id is
  'One thread per task, ever. A reassignment creates a second engagement and must not create '
  'a second thread: the trail of what happened on a task is the thing read afterwards.';

comment on column public.threads.room_id is
  'Denormalised from the channel so tenancy policies are a plain membership call rather than '
  'a join. Kept honest by the composite foreign key on (channel_id, room_id).';
