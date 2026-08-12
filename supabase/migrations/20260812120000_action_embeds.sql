-- 20260812120000_action_embeds.sql — interactive cards attached to messages.
-- Owner doc: docs/10-architecture/data-model.md
--
-- The first of the action embeds described in discord-chat-spec.md: a plan card
-- rendered in the stream, carrying structured data the message body cannot hold.
-- Approve / Pay / Sign / Assign follow on the same table.
--
-- Two properties this table exists to enforce, both of which a JSON blob on the
-- message would lose:
--
--   * `required_role` is checked in the DATABASE, not the UI. The spec is explicit
--     that a node must not be able to act on an owner-only embed, and a rule that
--     lives only in React is a rule that a crafted request ignores.
--   * `state` makes an embed single-use. Without it, approving twice is two
--     approvals, which for Pay and Sign later means paying twice.
--
-- Membership is inherited from the message's room rather than duplicated, so an
-- embed can never be visible to someone who cannot see the message it belongs to.

create type public.embed_component as enum (
  'plan',
  'approval',
  'pay',
  'sign',
  'assign'
);

create type public.embed_state as enum (
  'pending',
  'approved',
  'rejected',
  'expired'
);

create table public.action_embeds (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.messages (id) on delete cascade,
  room_id       uuid not null references public.rooms (id) on delete cascade,
  component     public.embed_component not null,
  -- The structured card. Validated by Zod in packages/contracts before it is
  -- written; Postgres stores it as data because its shape varies by component.
  payload       jsonb not null,
  -- Who may act. 'owner' means the room's creator only. Enforced by policy below,
  -- not by the client.
  required_role text not null default 'owner',
  state         public.embed_state not null default 'pending',
  -- Set when the state last changed, so an audit answers "who approved, and when".
  acted_by      uuid references auth.users (id),
  acted_at      timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),

  -- One embed per message. A message is a single utterance; two cards on one
  -- utterance would have no defined render order and no way to address either.
  unique (message_id)
);

create index action_embeds_room_idx on public.action_embeds (room_id, created_at desc);

alter table public.action_embeds enable row level security;

-- Visible to exactly whoever can see the room. Reuses the hardened helper rather
-- than re-deriving membership, so there is one definition to get right.
create policy "action_embeds_select_member" on public.action_embeds
  for select using (private.is_room_member(room_id));

-- Writes are server-only. The agent proposes an embed and Node writes it with the
-- secret key; a client that could INSERT here could fabricate an approval card,
-- and one that could UPDATE freely could approve on someone else's behalf.
-- Acting on an embed goes through an API route that checks required_role, so it
-- is deliberately NOT expressed as a client-writable policy.

-- RLS filters rows a grant already permits; it is not itself a grant. Both are
-- required, and omitting the grant is what made every table unreachable in
-- 20260728170000.
grant select on public.action_embeds to authenticated;
grant all on public.action_embeds to service_role;

comment on table public.action_embeds is
  'Interactive cards attached to messages (plan, approval, pay, sign, assign). '
  'Client-readable, server-written; required_role is enforced server-side.';
