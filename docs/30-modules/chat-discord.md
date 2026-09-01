# Module: Chat (Discord-style)

> Owns the multiplayer group-chat experience that **is** the product surface: the 5-region Discord layout, channels/threads/topics, roles/mentions/presence, interactive action embeds, and the **server-authoritative** message write path with realtime delivery. The AI and human nodes are first-class members here.
>
> **Owner paths:** `apps/web/**` (chat UI), `packages/realtime/**` · **Depends on:** auth-identity (membership RLS), ai-orchestrator (posts messages/embeds), human-nodes-marketplace (node join/offboard), notifications (unread/mention pushes), design-system-frontend (UI shell), infra-devops (Realtime, Supavisor).
>
> The visual/interaction spec is in [discord-chat-spec.md](../20-design/discord-chat-spec.md); this module doc is the behavior/data view. Update both on any layout, role, embed, or transport change.
>
> **Implementation status (Phase 2, in progress):** the chat runs entirely on live data. The **server-authoritative write path and persistence are live**: `POST /api/rooms/:roomId/messages` and `GET /api/rooms/:roomId/messages` (since-cursor catch-up) in `apps/api`, with delivery to Realtime subscribers verified end-to-end, and `apps/web` reads sign-in, rooms, channels, members, message history, live Realtime delivery and Realtime Presence with **no mock data left**. **The AI is a member rather than a widget:** a posted goal starts an agent run and the reply arrives as an ordinary message with `author_kind='agent'`, rendered inline. **Four embed components are live**, each described below: `plan` (`20260812120000`), `question` (`20260815120000`), `artifact` (`20260815210000`) and `replan` (`20260828130000`). **Threads are live and written** as of slice 5 of the marketplace sequence (`20260904125000`): `public.accept_offer` creates a task's thread and admits the expert who took it, thread-scoped, in the same transaction. `threads` still has **one policy, for SELECT, and no client write grant** — the writer runs under the secret key, so creating a thread needed a grant rather than a policy. **`author_kind = 'node'` gained its writer in the same slice** (`20260904127000`): a node posts **through their own grant, on the existing client path**, because every participant INSERTs like any member (rule 5) and a server-mediated route would have been a second write path to keep in step. The route derives `author_kind` from the caller's own membership row and RLS re-checks it. **The owner's stream interleaves both conversations**, marked with a "in a task thread" label rather than filtered, because hiding rows the owner may read is the fetched-never-rendered defect. **Not built yet:** thread realtime topics (a node polls, see below), a thread switcher in the owner's UI, reactions, pins, mentions, saved messages, and the remaining embed components (approval, pay, sign, assign), which land with the marketplace and payments. See [design-system-frontend.md](design-system-frontend.md).

## 5-region layout

Guild rail (businesses) · channel sidebar (workstreams) · message list (the stream) · context panel (members / task / RAG sources) · composer. Top bar: business · phase · budget (tabular) · ⌘K · presence. Full spec in [discord-chat-spec.md](../20-design/discord-chat-spec.md).

## Message model (server-authoritative)

**Persist-then-broadcast:** client → Next BFF → Fastify `POST /rooms/:id/messages` (JWT) → RLS membership check → `INSERT` with `idempotency_key` + `seq` → Postgres trigger `realtime.broadcast_changes()` → topic `chat:room:{id}`. Optimistic UI reconciled on broadcast. This keeps Postgres the source of truth and lets the AI participate simply by inserting rows.

Implementation notes that callers depend on:

- **`authorId` / `authorKind` are never taken from the request body.** The server sets them from the verified JWT and the `messages_insert_own` policy re-checks both, so a client cannot post as the agent or as another user.
- **`idempotencyKey` is client-generated and required**, one per composed message and reused across retries. A replayed key returns the original message with `200` instead of `201`; a key already used by a different author or room is refused with `409`.
- **Presence needs its own INSERT policy on `realtime.messages`.** Receiving broadcasts only needs SELECT, because the broadcast originates from a `SECURITY DEFINER` trigger (the sender is the database). `channel.track()` is the client writing directly, so without an INSERT policy every member silently renders as offline with no error anywhere.
- **Broadcast failures are silent by construction.** `realtime.send()` traps its own exceptions, so a dropped broadcast still commits the row and returns `201`. Delivery cannot be inferred from a successful write and must be monitored separately (see [observability.md](../10-architecture/observability.md)); the since-cursor endpoint is the durable fallback.

## Roles & identity

`You` / `AI Agent` / `Human Node` / `Verified Pro` / `Admin` — **color + badge + icon, never color alone**. Enforced by role claims + RLS + each embed's `required_role`.

## AI inline in the stream

Accent bar + Agent tag + **live token streaming** + a **bioluminescent working pulse** while the agent is acting. Not a corner bubble. Its messages double as the audit trail.

## Interactive action embeds

Approve / Pay / Sign / Assign / Accept — **permission-gated by role**, carrying state and **tabular-numeric** money. `required_role` enforced server-side, not just in UI. A node cannot see or act on owner-only embeds.

> **Live (Phase 1):** the `action_embeds` table (`20260812120000`) and its first component, `plan`. Rows are **client-readable, server-written**: membership is inherited from the message's room, and there is no client INSERT or UPDATE policy, because a client that could insert here could fabricate an approval card. `unique (message_id)` keeps it one card per message.
>
> **The action route is live**, re-checking membership, `required_role` and `state` server-side, with a conditional update so two concurrent approvals cannot both win. The `state` column is what makes an embed single-use, which matters far more for Pay and Sign than for a plan: without it, approving twice is two approvals.
>
> **Approving a plan card now creates work**, not just a verdict: `public.materialise_plan` turns it into a project and one task per step, in one transaction, reading the payload from the card so what was approved is what gets built ([architecture.md](../10-architecture/architecture.md)). The embed is therefore the authorisation boundary between a proposal and execution, which is the shape Pay and Sign inherit.
>
> **The `question` component is live** (`20260815120000`), which is the spec's batched user-only question finally having something that produces one: intake asks before a vague goal reaches retrieval. The card additionally **carries the intake's state** between rounds, because the AI service is stateless (ADR-0006) and this row is already written, already RLS-scoped to the room, and already visible to the person whose answers it holds.
>
> Its answer path is different from every other embed's, and that matters. An answer is an ordinary **chat message**, not a write to `action_embeds`, so it never reaches the action route where `required_role` is checked. The owner-only rule is therefore enforced in the agent run instead: a reply from anyone else is treated as a new goal rather than as an answer, which is what it would have been without an intake in flight. `required_role` is still set, for the UI.
>
> **A question card expires.** It claims every message the owner writes while it is pending, so an unbounded one puts the room into a mode that outlives the conversation. Two hours, filtered on read; the row stays for the audit trail. Details and the reasoning in [architecture.md](../10-architecture/architecture.md).
>
> `embed_state` gains **`answered`**, because the four original states describe a verdict and a question has none. Recording one as `approved` would put an untrue sentence in the audit trail and, worse, hand the flywheel a labelled example of a person approving something they were never shown.
>
> **The `replan` component is live** (`20260828130000`): a diff against a project that is already running, proposing steps to add, cancel or correct. It reuses the plan card's approve / request-changes path exactly, and the action route's component allow-list gained one entry rather than a branch, because approving either card means the same thing (commit what it proposes) through a different function.
>
> It needed **no new `embed_state`**, unlike the question card. A diff is a proposal with a verdict, so `pending`, `approved` and `rejected` already mean what they need to mean; `answered` had to be added for a question precisely because a question has no verdict to record.
>
> Two things the card shows that the payload has to carry for it. A cancelled step is named, because the op references a task by UUID and asking somebody to approve `3f2a-...` is not asking them anything: `taskTitle` is filled in by Node from the DAG it already sent to the core, never by the model, since it is a fact about a row. And the card states that **cancelling a step does not release what waits on it**, which is the consequence people do not expect and the worst possible thing to discover after approving.
>
> **A card arrives on fetch, not on broadcast.** The Postgres trigger broadcasts the `messages` row and cannot see another table, so a plan card appears on the next load rather than instantly. Visible latency, never a wrong render.

## Threads & topics

Threads per subtask; Zulip-style **named topics** for resumable subtasks. A node engagement lives in its own thread; node membership is **scoped + time-boxed** (`room_members.scope`, `expires_at`).

> **Live, and written since `20260904125000`.** `threads` carries `id`, `room_id` (denormalised so tenancy policies are a membership call rather than a join), `channel_id`, `task_id?` and `title`; `messages.thread_id` is nullable and constrained by a composite foreign key so a message's thread is provably in the message's own room. `room_members.scope` is finally enforced, having been unconstrained text with no reader for 44 migrations.
>
> **The writer is `accept_offer` and nothing else**, which is why `threads` still needs no INSERT policy. It creates-or-finds (`on conflict (task_id) do nothing`, then select), resolves the room the `is_project_member` way (through the plan card, with the legacy `rooms.project_id` link unioned in), and picks the room's **first channel by position, then creation, then id**. Deterministic rather than arbitrary: a crashed accept that retried into a different channel would put the thread somewhere else on the second attempt. There is no `channelForRoom` helper anywhere and this is the only caller, so the pick lives there rather than becoming a one-use export.
>
> **A thread holding messages cannot be deleted.** `on delete set null` would re-home them into the null-thread room stream, which room-scoped members read, so a deletion would be a disclosure. NO ACTION rather than RESTRICT, so deleting a whole room still cascades.
>
> **One thread per task, ever** (`task_id` is a plain unique). A reassignment after a no-show creates a second engagement and must continue in the same thread, because the trail of what happened on a task is the thing read afterwards.
>
> **A thread-scoped member still has no realtime, and slice 5 accepted that explicitly.** Thread topics are not built: both `realtime.messages` policies were narrowed to `scope = 'room'` in place, extending rather than replacing them so the time-box survives. The obligation offered a choice, land thread topics or explicitly accept polling, and the node console takes the second: it reads its thread through the since-cursor `GET` on a ten-second interval. That runs as the caller, so RLS returns exactly their thread and **the failure mode is a delay of up to one interval rather than a disclosure**, which is what makes deferring the broadcaster acceptable. A `'chat:thread:'` branch lands in slice 6, as an `OR` inside these same two policies rather than as a third one. Full posture in [security-compliance.md](../10-architecture/security-compliance.md) and [ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md).
>
> **Admission has no clock, and that is a decision rather than an omission.** `accept_offer` writes the membership with `expires_at` **null**, because there is no deadline source: `engagements.deadline_at` has no writer, and a number invented at acceptance would cut somebody off mid-task. The time-box is therefore explicit rather than automatic: access is revoked by stamping `expires_at` when the engagement ends, which the reconcile sweep does. This doc says node membership is "scoped + time-boxed", and this is the honest reading of that in a slice with no deadlines.
>
> **One thread per person per room**, because `room_members` is keyed on `(room_id, user_id)` (ADR-0017). A node therefore works one step of a project at a time, and `accept_offer` refuses a second acceptance in the same room with a sentence rather than absorbing it silently: reusing the existing membership row would admit them to the wrong thread. A real product limit, and lifting it is a change to that ADR.

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

`rooms` · `channels` · `threads` (**live**, written by `accept_offer`) · `messages` (idempotency key, `seq` ordering cursor, `author_kind`, `thread_id?`) · `room_members` (`scope`, `thread_id?`, `expires_at`) · `reactions` / `pins` · `action_embeds` (component, payload, `required_role`, state) · presence (ephemeral, Realtime).
