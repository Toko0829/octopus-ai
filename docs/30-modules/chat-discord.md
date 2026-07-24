# Module: Chat (Discord-style)

> Owns the multiplayer group-chat experience that **is** the product surface: the 5-region Discord layout, channels/threads/topics, roles/mentions/presence, interactive action embeds, and the **server-authoritative** message write path with realtime delivery. The AI and human nodes are first-class members here.
>
> **Owner paths:** `apps/web/**` (chat UI), `packages/realtime/**` · **Depends on:** auth-identity (membership RLS), ai-orchestrator (posts messages/embeds), human-nodes-marketplace (node join/offboard), notifications (unread/mention pushes), design-system-frontend (UI shell), infra-devops (Realtime, Supavisor).
>
> The visual/interaction spec is in [discord-chat-spec.md](../20-design/discord-chat-spec.md); this module doc is the behavior/data view. Update both on any layout, role, embed, or transport change.
>
> **Implementation status (Phase 1, in progress):** the chat **UI shell** is built (mock-driven) at `apps/web/app/app` — 5 regions, roles/badges/presence, inline agent stream, plan-card action surface, ⌘K palette. The **server-authoritative write path + Supabase Realtime transport + persistence** are not wired yet (next Phase-1 step). See [design-system-frontend.md](design-system-frontend.md).

## 5-region layout

Guild rail (businesses) · channel sidebar (workstreams) · message list (the stream) · context panel (members / task / RAG sources) · composer. Top bar: business · phase · budget (tabular) · ⌘K · presence. Full spec in [discord-chat-spec.md](../20-design/discord-chat-spec.md).

## Message model (server-authoritative)

**Persist-then-broadcast:** client → Next BFF → Fastify `POST /rooms/:id/messages` (JWT) → RLS membership check → `INSERT` with `idempotency_key` + `seq` → Postgres trigger `realtime.broadcast_changes()` → topic `chat:room:{id}`. Optimistic UI reconciled on broadcast. This keeps Postgres the source of truth and lets the AI participate simply by inserting rows.

## Roles & identity

`You` / `AI Agent` / `Human Node` / `Verified Pro` / `Admin` — **color + badge + icon, never color alone**. Enforced by role claims + RLS + each embed's `required_role`.

## AI inline in the stream

Accent bar + Agent tag + **live token streaming** + a **bioluminescent working pulse** while the agent is acting. Not a corner bubble. Its messages double as the audit trail.

## Interactive action embeds

Approve / Pay / Sign / Assign / Accept — **permission-gated by role**, carrying state and **tabular-numeric** money. `required_role` enforced server-side, not just in UI. A node cannot see or act on owner-only embeds.

## Threads & topics

Threads per subtask; Zulip-style **named topics** for resumable subtasks. A node engagement lives in its own thread; node membership is **scoped + time-boxed** (`room_members.scope`, `expires_at`).

## Mentions, reactions, pins

`@user` / `@agent` / `@role` / `#channel` (autocomplete), reactions, pins, saved messages. Mentions + pending-action counts feed [notifications](notifications.md).

## Presence

Supabase Presence: online / idle / dnd, typing, activity states ("Agent is retrieving sources…", "Node is on-site"). Member panel shows live state.

## System messages (audit trail)

Distinctly rendered: join / task-complete / escrow-held / registered / payout. The human-readable projection of the event-sourced log.

## Composer & command palette

Slash commands (`/plan`, `/status`, `/approve`, `/hire`, `/budget`), autocomplete, attachments, markdown; global **⌘K** action layer.

## Realtime scaling

`packages/realtime` abstraction (write-via-Fastify, subscribe-to-topic). Broadcast-from-Postgres now (**not** Postgres Changes — [ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)); since-cursor catch-up for reconnects/late joiners; documented migration to a Fastify uWebSockets + Redis gateway past the ~500-concurrent ceiling.

## Density & theming

Warm Chat skin by default; compact density for power users; per-business accent tints chrome, never message text.

## Key entities

`rooms` · `channels` / `threads` · `messages` (idempotency key, `seq` ordering cursor, `author_kind`) · `reactions` / `pins` · `action_embeds` (component, payload, `required_role`, state) · presence (ephemeral, Realtime).
