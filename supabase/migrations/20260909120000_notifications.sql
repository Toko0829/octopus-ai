-- 20260909120000_notifications.sql — the row that says somebody was told.
-- Owner doc: docs/30-modules/notifications.md
-- Also: docs/10-architecture/data-model.md,
--       docs/30-modules/human-nodes-marketplace.md,
--       docs/30-modules/chat-discord.md,
--       docs/40-adr/0028-a-notification-is-derived-from-the-event.md
--
-- Notifications slice 1, first migration. `notifications.md:51` has named this
-- table since Phase 0 and nothing has ever created it. Every marketplace slice
-- from 4 to 8 closes with the same sentence, and slice 8's is the plainest:
-- "Nobody is notified of anything, still ... an owner learns their step was taken
-- from a system message in their room, and a node learns nothing until they open
-- `/node`" (human-nodes-marketplace.md:710).
--
-- That is not a missing convenience. It is what sizes two constants:
-- `OFFER_TTL_MS` is 48 hours and `WORK_TTL_HOURS` is 168 **because** nobody is
-- told, and `matching.ts:36` says so in as many words — "anything shorter would
-- expire against people who had not looked yet". A market whose deadlines are set
-- by the absence of a doorbell is a market with a doorbell-shaped hole in it.
--
-- ---------- What this table is, and what it deliberately is not ----------
--
-- It is **one row per person per moment**, and nothing else. It is not a queue
-- (nothing drains it), not a delivery record (`delivery_log` is a later slice
-- with a provider behind it), and not a lifecycle: there is no `status` column,
-- because `read_at is null` is the only distinction anybody makes and a column
-- would be a second way to say it. That is `disputes`' derivation argument
-- (`20260908122000:26-30`) applied to a much smaller table.
--
-- ---------- The copy is not here, and that is a decision ----------
--
-- The row stores the **facts a sentence is made from** — `kind`, and a `payload`
-- the trigger enriches with the title, the money, the deadline — and never the
-- sentence. Three reasons, in the order they weigh
-- ([ADR-0028](../../docs/40-adr/0028-a-notification-is-derived-from-the-event.md)):
--
--   1. Text in a row needs a **migration** to fix a typo, and product copy is the
--      thing in this system most likely to be rewritten.
--   2. AGENTS.md rule 22 bans em dashes in notification copy **by name**. A
--      template in TypeScript is unit-tested against that rule over every kind;
--      a string built in plpgsql is reviewed by whoever happens to read the
--      migration.
--   3. Composing it in SQL would put product voice in the one place nobody
--      reviews for voice.
--
-- The cost is real and is accepted: a reader of this table alone sees
-- `work.rejected` and a jsonb blob rather than a sentence. `events` already has
-- that property and is already the trail a dispute reads.
--
-- ---------- `recipient_role` is not redundant with `user_id` ----------
--
-- One person is an owner on their own project and could be a node on somebody
-- else's, and `dispute.resolved` writes a row to both parties from one event.
-- The sentence and the link differ by which hat the row was written for, and
-- deriving the hat at read time would mean re-querying the engagement from the
-- inbox. It is stored because it is a fact about the row, not about the person.
--
-- ---------- Deleting is refused, including for `service_role` ----------
--
-- The `disputes` / `offers` / `node_verifications` posture, for this table's own
-- reason: a notification row is the record **that somebody was told**, and the
-- first place that matters is a dispute where one party says they never heard.
-- A record trusted code can delete is not a record. `read_at` is the only column
-- a client may write, enforced twice: a column grant, and a trigger.

-- ---------- Table ----------

create table public.notifications (
  id             uuid primary key default gen_random_uuid(),

  -- The person told. `auth.users` rather than `profiles` because the KYC verdict
  -- reaches somebody whose node profile may be the thing under decision.
  user_id        uuid not null references auth.users (id) on delete cascade,

  -- Which hat. See the header: one person can hold both on different projects.
  recipient_role text not null check (recipient_role in ('owner', 'node')),

  -- The event verb, carried through unchanged so the two vocabularies cannot
  -- drift. Checked rather than enumerated, on `20260908122000:110-118`'s
  -- reasoning: `alter type ... add value` cannot be rolled back, while a check
  -- constraint is dropped and re-added in a normal migration, and this list will
  -- grow every time a slice adds a moment.
  kind           text not null check (kind in (
                   'offer.created',
                   'offer.accepted',
                   'proof.submitted',
                   'proof.bounced',
                   'work.approved',
                   'work.rejected',
                   'engagement.reassigned',
                   'payout.settled',
                   'dispute.raised',
                   'dispute.resolved',
                   'node.kyc_status_changed',
                   'task.transitioned'
                 )),

  -- Carried from the event, so a reader can reach the thing itself.
  subject_type   text not null check (char_length(btrim(subject_type)) between 1 and 32),
  subject_id     uuid not null,

  -- Nullable, and the null case is real rather than lazy: `node.kyc_status_changed`
  -- is written with `project_id` null (`20260902120000:123`) because becoming a
  -- verified node is not about a project.
  project_id     uuid references public.projects (id) on delete cascade,

  -- The moment this was derived from. Not decorative: it is what makes the row
  -- auditable back to the fact, and what a later channel would log a send against.
  event_id       uuid not null references public.events (id) on delete cascade,

  -- `<verb>:<subject_id>:<user_id>`. **`events` has no unique key** and says so
  -- (`20260813120000` declares none, and `match.ts:478-481` writes `offer.created`
  -- only after the task moved precisely because a replay would otherwise double-log).
  -- So the dedup lives here, and the trigger inserts `on conflict do nothing`.
  key            text not null unique,

  -- The facts the sentence is made from. Never the sentence.
  payload        jsonb not null default '{}',

  created_at     timestamptz not null default now(),

  -- Null until read. The whole lifecycle.
  read_at        timestamptz,

  constraint notifications_read_after_created check (read_at is null or read_at >= created_at)
);

-- The inbox query, exactly: one person's rows, newest first, `id` breaking ties
-- so keyset paging on `created_at` cannot loop on a tie.
create index notifications_inbox_idx
  on public.notifications (user_id, created_at desc, id desc);

-- The badge query. Partial, because the count that matters is over the rows that
-- are still unread and that set stays small while the table does not.
create index notifications_unread_idx
  on public.notifications (user_id)
  where read_at is null;

create index notifications_event_idx on public.notifications (event_id);

-- ---------- Read is written once, by the person, at the time they read ----------
--
-- `guard_dispute_resolve`'s shape and its reasons, one table down in stakes.
-- SECURITY DEFINER so it binds `service_role` too (the `20260815200000` lesson):
-- a route that marked somebody else's inbox read would be indistinguishable from
-- one that worked.
create function private.guard_notification_read()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Everything except `read_at` is derived from an event that already happened.
  -- Editing any of it would make this row describe a moment that did not occur.
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.recipient_role is distinct from old.recipient_role
     or new.kind is distinct from old.kind
     or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id
     or new.project_id is distinct from old.project_id
     or new.event_id is distinct from old.event_id
     or new.key is distinct from old.key
     or new.payload is distinct from old.payload
     or new.created_at is distinct from old.created_at then
    raise exception
      'notification % is derived from event %; only read_at may change',
      old.id, old.event_id
      using errcode = 'check_violation',
            hint = 'A different moment is a different event, which derives its own notification.';
  end if;

  -- Unread-again is refused rather than supported. "Mark as unread" is a feature
  -- request, and if it ever arrives it is a separate column (`dismissed_at`, or a
  -- `seen_at` distinct from `read_at`), not a nullable timestamp that means two
  -- things depending on how it got there. Naming the null case explicitly matters
  -- because a client sending `{ read_at: null }` is otherwise a silent no-op that
  -- looks like it worked.
  if old.read_at is not null and new.read_at is null then
    raise exception 'notification % has already been read', old.id
      using errcode = 'check_violation',
            hint = 'Marking something unread is not a thing this table does.';
  end if;

  -- Read once. A second click is not a second reading, and re-stamping would move
  -- a timestamp the recipient can see.
  if old.read_at is not null and new.read_at is distinct from old.read_at then
    raise exception 'notification % was read at %; that is written once', old.id, old.read_at
      using errcode = 'check_violation';
  end if;

  -- The client says *that* it was read; the database says *when*. A caller
  -- supplying its own clock could backdate the one fact this row is asked to
  -- prove, and the caller here is a browser.
  if old.read_at is null and new.read_at is not null then
    new.read_at := now();
  end if;

  return new;
end;
$$;

revoke all on function private.guard_notification_read() from public;

create trigger notifications_guard_read
  before update on public.notifications
  for each row
  execute function private.guard_notification_read();

-- ---------- RLS and grants ----------
--
-- RLS filters rows a grant already permits; it is not itself a grant, and
-- omitting the grant is what made every table unreachable in `20260728170000`.
-- Both, always.

alter table public.notifications enable row level security;

-- Your inbox is yours. There is no counterparty policy, no member policy and no
-- ops policy on this table, and that is the whole access model: a notification is
-- addressed to exactly one person, so "who may read it" has a one-word answer.
create policy "notifications_select_own" on public.notifications
  for select using (user_id = auth.uid());

create policy "notifications_update_own" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.notifications to authenticated;

-- **The column grant is the control**, the trigger is the backstop. A bare
-- `grant update` would let a client rewrite `payload` and the policy above would
-- happily permit it, because RLS filters rows and not columns
-- (`20260831123000`'s recorded lesson on `node_verifications`).
grant update (read_at) on public.notifications to authenticated;

-- No client INSERT, ever. Nothing writes this table but the trigger in
-- `20260909121000`, which runs as the definer of `notify_from_event`. A client
-- insert would be a notification about a moment that did not happen.
grant all on public.notifications to service_role;

revoke insert on public.notifications from authenticated, anon;
revoke delete, truncate on public.notifications from authenticated, anon, service_role;

-- ---------- Comments ----------

comment on table public.notifications is
  'One row per person per moment, derived from public.events by a trigger (ADR-0028) rather '
  'than written by callers, because half the moments in this system are recorded by SQL '
  'functions and half by application code. No status column: read_at is null is the only '
  'distinction anybody makes. Deleting is revoked including for service_role, because this row '
  'is the record that somebody was told and the first place that matters is a dispute.';

comment on column public.notifications.key is
  'Deduplication, as <verb>:<subject_id>:<user_id>. public.events carries no unique key and a '
  'replay can write the same event twice, so the trigger inserts on conflict do nothing against '
  'this column. It is the only thing standing between a retried sweep and a doubled inbox.';

comment on column public.notifications.payload is
  'The facts a sentence is made from, never the sentence: task_title, agreed_price, currency, '
  'deadline_at, expires_at, resolution and so on, enriched by the deriving trigger. Copy lives '
  'in apps/web/lib/notification-copy.ts so it can be changed without a migration and unit-tested '
  'against AGENTS.md rule 22, which bans em dashes in notification copy by name.';

comment on column public.notifications.recipient_role is
  'Which hat this row was written for. Not redundant with user_id: one person is an owner on '
  'their own project and may be a node on another, and dispute.resolved writes to both parties '
  'from one event. The sentence and the link differ by this.';

comment on column public.notifications.project_id is
  'Null for node.kyc_status_changed, which is written with a null project_id (20260902120000) '
  'because becoming a verified node is not about a project.';

comment on function private.guard_notification_read() is
  'read_at is the only column a client may write, and it is written once, by the database clock. '
  'SECURITY DEFINER so it binds service_role too. Marking unread is refused explicitly rather '
  'than ignored, because a silent no-op looks like it worked.';
