-- 20260728120000_chat.sql — Discord-style chat: schema + RLS + Realtime broadcast.
-- Owner docs: docs/30-modules/chat-discord.md, docs/10-architecture/data-model.md.
-- Server-authoritative: the AI/system insert rows via the secret (service) key,
-- which bypasses RLS; end users insert their own messages under RLS.

-- ---------- Enums ----------
create type public.author_kind as enum ('user', 'agent', 'node', 'system');
create type public.channel_kind as enum ('text', 'topic');

-- ---------- Tables ----------
create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.channels (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  name       text not null,
  section    text not null default 'General',
  kind       public.channel_kind not null default 'text',
  position   int not null default 0,
  created_at timestamptz not null default now()
);
create index channels_room_idx on public.channels (room_id);

-- Who is in a room and with what role. The AI is a synthetic member; nodes are time-boxed.
create table public.room_members (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.user_role not null default 'user',
  scope      text not null default 'room',
  expires_at timestamptz,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user_idx on public.room_members (user_id);

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms (id) on delete cascade,
  channel_id      uuid references public.channels (id) on delete set null,
  author_id       uuid,                           -- null for system/agent
  author_kind     public.author_kind not null default 'user',
  body            text,
  idempotency_key text unique,
  seq             bigint generated always as identity,
  created_at      timestamptz not null default now()
);
create index messages_room_seq_idx on public.messages (room_id, seq);

-- ---------- Membership helper (SECURITY DEFINER avoids recursive RLS on room_members) ----------
create or replace function public.is_room_member(p_room uuid)
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
  );
$$;

-- ---------- RLS ----------
alter table public.rooms enable row level security;
alter table public.channels enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;

create policy "rooms_select_member" on public.rooms
  for select using (public.is_room_member(id));

create policy "channels_select_member" on public.channels
  for select using (public.is_room_member(room_id));

create policy "room_members_select_member" on public.room_members
  for select using (public.is_room_member(room_id));

create policy "messages_select_member" on public.messages
  for select using (public.is_room_member(room_id));

-- Users may post their own text messages; agent/system/node writes go through the
-- server (secret key) which bypasses RLS.
create policy "messages_insert_own" on public.messages
  for insert with check (
    public.is_room_member(room_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

-- ---------- Realtime: broadcast new messages from Postgres ----------
create or replace function public.broadcast_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform realtime.broadcast_changes(
    'chat:room:' || new.room_id::text, -- topic
    tg_op,                             -- event
    tg_op,                             -- operation
    tg_table_name,                     -- table
    tg_table_schema,                   -- schema
    new,                               -- new record
    null                               -- old record
  );
  return new;
end;
$$;

create trigger on_message_broadcast
  after insert on public.messages
  for each row
  execute function public.broadcast_message();

-- Realtime Authorization: only current members may subscribe to a room's private topic.
create policy "realtime_room_members_can_receive" on realtime.messages
  for select to authenticated
  using (
    exists (
      select 1
      from public.room_members m
      where m.user_id = auth.uid()
        and (m.expires_at is null or m.expires_at > now())
        and realtime.topic() = 'chat:room:' || m.room_id::text
    )
  );
