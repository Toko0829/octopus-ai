# Module: Chat (Discord-style)

> Owns the multiplayer group-chat experience that **is** the product surface: the 5-region Discord layout, channels/threads/topics, roles/mentions/presence, interactive action embeds, and the **server-authoritative** message write path with realtime delivery. The AI and human nodes are first-class members here.
>
> **Owner paths:** `apps/web/**` (chat UI), `packages/realtime/**` · **Depends on:** auth-identity (membership RLS), ai-orchestrator (posts messages/embeds), human-nodes-marketplace (node join/offboard), notifications (unread/mention pushes), design-system-frontend (UI shell), infra-devops (Realtime, Supavisor).
>
> The visual/interaction spec is in [discord-chat-spec.md](../20-design/discord-chat-spec.md); this module doc is the behavior/data view. Update both on any layout, role, embed, or transport change.
>
## Current shape

> What exists today, read out of the migrations and `apps/web`. **Update this section in the
> same change as the code**, and keep its "Not built" list honest: it is what a later session
> trusts instead of reading the whole doc. The narrative of how each piece arrived is under
> History at the bottom and in [status-log.md](../00-overview/status-log.md).

**Tables**, with the migration that landed them.

| Table           | Holds                                                                                        | Notes                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `rooms`         | One workspace: `name`, `owner_id`, optional `project_id`                                     | `20260728120000`; `owner_id` from `20260812130000`                                                  |
| `channels`      | Workstreams inside a room                                                                    | `20260728120000`                                                                                    |
| `threads`       | One task's working conversation: `(id, room_id)` unique, `channel_id`, `task_id`             | `20260901120000`. Written by `accept_offer` under the secret key; SELECT policy only, no write grant |
| `messages`      | `author_id`, `author_kind`, **`persona`**, `body`, `idempotency_key` UNIQUE, `seq`, `thread_id` | `20260728120000`; `thread_id` `20260901121000`; `persona` `20260912120000`                          |
| `room_members`  | `role`, `scope` (`room`/`thread`, checked), `thread_id?`, `expires_at`                        | `20260728120000`; thread scope `20260901122000`                                                     |
| `action_embeds` | The card on a message: `component`, `payload`, `required_role`, `state`; `unique (message_id)` | `20260812120000`                                                                                    |
| `room_profiles` | What the workspace knows about its own business, owner-only                                  | `20260911120000`                                                                                    |

**Who can be an author.** `public.author_kind` is `user | agent | node | system` and has never
been extended. `user` and `node` are client-writable through `messages_insert_own`, which derives
neither from the request: the route reads the caller's own `room_members` row and RLS re-checks
the same fact independently. `agent` and `system` arrive only through the secret key.

**The four agent voices** (`messages.persona`, `20260912120000`). A persona names **who spoke,
never who may act** ([ADR-0031](../40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)): it
is chosen in `apps/api` from the step's own `tasks.stage`, and the DAG keeps its single writer.

| Persona      | In the stream   | Stages                              | Posts                                                                                                                      |
| ------------ | --------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `strategist` | Strategist (ST) | `strategy`, and any unmatched stage | the intake lines, the run notices, the plan card, the question card, the replan card, the waiting digest, a recorded answer |
| `content`    | Content (CO)    | `content`, `creative`, `conversion` | the delivered artifact for those stages                                                                                    |
| `ads`        | Ads (AD)        | `channels`                          | the campaign card, and the publish sweep's three outcome notices                                                           |
| `analyst`    | Analyst (AN)    | `measurement`                       | the metrics sweep's blocked notice, and the optimize sweep's pause and pause-blocked notices                               |

**What stays `system`.** The rule is that **system says what a person or the platform did; a
persona says what it did or found.** So an embed decision, an offer accepted, work started, proof
submitted, a dispute raised or resolved, a payout, a deadline warning, a source-ingest outcome and
a failed run are all `system`, and `messages_persona_agent_only` refuses a persona on any of them.
`postSystemMessage` and `postPersonaMessage` in `apps/api/src/lib/system-message.ts` are two
functions rather than one with a nullable argument, so a caller has to choose.

**`persona` is null in three cases and the client renders all three the same way**: a person's or
a node's message, a system line, and every agent message written before `20260912120000`. The last
group keeps the single legacy name, `Octopus`. **Nothing was backfilled**, so that rendering is
permanent rather than a migration that finishes.

**Embed components.** Five of the nine enum values are ever written: `plan` (`20260812120000`),
`question` (`20260815120000`), `artifact` (`20260815210000`), `replan` (`20260828130000`),
`campaign` (`20260829130000`). `approval`, `pay`, `sign` and `assign` were declared in Phase 0 and
have no writer.

**Routes** (`apps/api/src/routes/messages.ts`). `POST /api/rooms/:roomId/messages` writes one
message under the caller's own grant; `GET /api/rooms/:roomId/messages` reads history with a
`since` cursor. The read's column list is `MESSAGE_COLUMNS`, exported and pinned against
`MessageRow` by a test, because a PostgREST select is a string and a column it omits fails at
runtime only. Neither `authorKind` nor `persona` is accepted from the request.

**Realtime.** `public.broadcast_message()` sends the whole inserted row to `chat:room:<id>`, and
additionally to `chat:thread:<id>` when the message carries one (`20260906120000`). A new column
therefore reaches subscribers with no trigger change, which `message_persona.sql` asserts rather
than assumes. Presence is Realtime Presence from the client and has no server-side table.

**pgTAP suites and their counts**: `rls_membership.sql` (26), `thread_scope.sql` (55),
`message_persona.sql` (10), `question_answers.sql` (12), `room_profiles.sql` (10).

**Not built.** A thread switcher in the owner's UI. `@user`, `@role` and `#channel` mentions,
reactions, pins and saved messages. Agent mentions, which land in the next slice. The four
unwritten embed components. Message editing or deletion of any kind. Typing indicators and the
activity states the spec describes. A mention feeding [notifications](notifications.md). The top
bar's presence avatars and live budget.

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

**The AI role holds four voices, and the badge does not change.** Strategist, Content, Ads and Analyst all render with `role: 'agent'`: the same accent bar, the same teal avatar, the same `Agent` badge. What differs is the name and the two initials, both read from the registry in `packages/contracts`. That is deliberate under rule 15: the thing a reader must not get wrong is that this was written by the AI rather than by a person, and that claim stays carried by a word rather than by a name they would have to have memorised. See the persona table in **Current shape**.

## AI inline in the stream

Accent bar + Agent tag + **live token streaming** + a **bioluminescent working pulse** while the agent is acting. Not a corner bubble. Its messages double as the audit trail.

**Signed since `20260912120000`.** A message says which of the four voices wrote it, chosen from the step's own `tasks.stage` rather than by any model, and `events.payload.persona` records the same on `task.reviewed` and `task.executed` so the audit trail names a speaker too. A persona is a voice and never a writer: there is still one writer to the task DAG, one router and one spend cap ([ADR-0031](../40-adr/0031-an-agent-persona-is-a-voice-not-a-writer.md)). Live token streaming is still not built.

## Interactive action embeds

Approve / Pay / Sign / Assign / Accept — **permission-gated by role**, carrying state and **tabular-numeric** money. `required_role` enforced server-side, not just in UI. A node cannot see or act on owner-only embeds.

> **Live (Phase 1):** the `action_embeds` table (`20260812120000`) and its first component, `plan`. Rows are **client-readable, server-written**: membership is inherited from the message's room, and there is no client INSERT or UPDATE policy, because a client that could insert here could fabricate an approval card. `unique (message_id)` keeps it one card per message.
>
> **The action route is live**, re-checking membership, `required_role` and `state` server-side, with a conditional update so two concurrent approvals cannot both win. The `state` column is what makes an embed single-use, which matters far more for Pay and Sign than for a plan: without it, approving twice is two approvals.
>
> **Approving a plan card now creates work**, not just a verdict: `public.materialise_plan` turns it into a project and one task per step, in one transaction, reading the payload from the card so what was approved is what gets built ([architecture.md](../10-architecture/architecture.md)). The embed is therefore the authorisation boundary between a proposal and execution, which is the shape Pay and Sign inherit.
>
> **The `question` component is live** (`20260815120000`) and, since `20260910120000`, **answered on the card**. Intake asks before a vague goal reaches retrieval, and the plan asks when a step needs a decision only the owner can make; both write one card. A budget band or a timeline is a row of chips, an audience or an offer is a short field with its own Save, and a step is one field, so an answer is one act rather than a paragraph typed into the composer for a model to parse back into slots. The card still **carries the intake's state** between rounds, because the AI service is stateless (ADR-0006), and now carries the answers as they land.
>
> **An answer is an embed action**, `answer` with a slot or a task and a value, or `finish`, on the same route every other card is acted on through. That is what makes `required_role` the enforcement rather than a hint. An answer used to be an ordinary chat message that never reached the route, so the owner-only rule had to be enforced inside the agent run, and to know which message was an answer a pending card had to **claim every message the owner wrote** until it was dealt with. Two cards were found holding rooms for nearly two days that way, one having swallowed a request meant as a new goal. Nothing claims a message now: **every message is a goal**, and an owner's new goal dismisses the intake cards that were about the previous one. A task card is never dismissed by a goal, because it belongs to a plan that is still running.
>
> **Each answer is one statement.** `answer_question_slot` and `answer_question_task` write the one value they were given with `jsonb_set`, conditional on `state = 'pending'` in the same statement, so two chips clicked in the same second cannot lose one another and a closed card takes nothing. The response carries the card's new payload and the required slots still missing, which the client patches in place, since Realtime broadcasts message inserts only. The card closes itself when the last required slot lands, or when the owner presses "Plan with what I have said", and the run that asked continues from what the card collected. **No `expires_at` is written on a question card**: a card that claims nothing has no reason to expire.
>
> **The plan does not wait for the card.** Intake posts the card and the same run plans, so the room reads "Working on a plan for: ..." at once and the plan card lands beside the questions. Finishing the card then does one of two things, decided by what the plan has become: a plan still `pending` is moved to `expired` (its window closed because a sharper one arrived; not a verdict, so not `rejected`) and the new plan names it in `supersedes`, which the client uses to mark the old card on screen; a plan already approved gets a `replan` card through the same diff path the panel uses, with a templated reason naming what was answered, and nothing is applied without that card. Each answer on the card is also **remembered for the workspace** in `room_profiles`, so the next goal in the room starts with the questions already answered. Details in [architecture.md](../10-architecture/architecture.md).
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
> **A thread has its own realtime topic now** (`20260906120000`), which is the obligation slice 5 re-dated twice and accepted polling for in the meantime. `broadcast_message` emits `'chat:thread:' || thread_id` **beside** the room topic rather than instead of it, and both `realtime.messages` policies gained one `OR` disjunct **inside the existing predicate**, so a thread-scoped member joins exactly their own thread's topic and the `expires_at` time-box is still written once per policy. The node console subscribes and the ten-second poll is gone; the since-cursor `GET` stays as catch-up on `SUBSCRIBED`, because a live subscription says nothing about what arrived while the tab was shut.
>
> **Two topics rather than one, and the owner is the reason.** The owner is room-scoped, is entitled to read their node's thread messages, and already does. Moving a thread message onto the thread topic alone would have taken that away **in realtime only**, so the row would arrive on the next fetch and not on the socket, which presents as "the chat is slow for some messages and not others" — the worst shape a delivery bug can take. `realtime.send()` traps its own exceptions, so neither broadcast can undo the committed INSERT.
>
> **The disjunct is narrower than the room half in both directions**, asserted rather than argued (`thread_scope.sql`, 8 realtime assertions, verified green against the live database): a thread-scoped member reaches their own thread topic and **not** the room topic, not another thread's topic, and not their own once expired; the owner reaches the room topic and **not** any thread topic. Full posture in [security-compliance.md](../10-architecture/security-compliance.md) and [ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md).
>
> **Admission has no clock, and that is a decision rather than an omission.** `accept_offer` writes the membership with `expires_at` **null**, because there is no deadline source: `engagements.deadline_at` has no writer, and a number invented at acceptance would cut somebody off mid-task. The time-box is therefore explicit rather than automatic: access is revoked by stamping `expires_at` when the engagement ends, which the reconcile sweep does. This doc says node membership is "scoped + time-boxed", and this is the honest reading of that in a slice with no deadlines.
>
> **One thread per person per room**, because `room_members` is keyed on `(room_id, user_id)` (ADR-0017). A node therefore works one step of a project at a time, and `accept_offer` refuses a second acceptance in the same room with a sentence rather than absorbing it silently: reusing the existing membership row would admit them to the wrong thread. A real product limit, and lifting it is a change to that ADR.

## Mentions, reactions, pins

`@user` / `@agent` / `@role` / `#channel` (autocomplete), reactions, pins, saved messages. Mentions + pending-action counts feed [notifications](notifications.md).

## Presence

Supabase Presence: online / idle / dnd, typing, activity states ("Agent is retrieving sources…", "Node is on-site"). Member panel shows live state.

**Two kinds of presence, from two sources.** A person's dot is Realtime Presence, so it says who is subscribed right now. **The four agent voices are not present in that sense and the panel does not claim they are**: they hold no membership row, are never offline, and sit in their own group below the people. A voice shows the pulse while a step it owns is in `ai_running` or `ai_self_check`, read from `ProjectSummary.working` on the project list the client already refetches on every message. No polling, no second subscription, and no server-side agent presence table.

**The Strategist has one extra source, and it is client-local.** Planning happens before a project exists, so the longest wait in the product has no task row to be found. This browser marks the Strategist busy when its own run is accepted, and clears it on a Strategist message, on a system notice, or after three minutes. That last one is the honest part: a run can end in ways this client never sees, and a pulse with no way to stop would outlive what it described. **The known gap:** intake declining the subject clears it correctly, but a tab backgrounded through a whole run keeps pulsing until the timeout.

Typing indicators and the activity states quoted above are still not built.

## System messages (audit trail)

Distinctly rendered: join / task-complete / escrow-held / registered / payout. The human-readable projection of the event-sourced log.

## Composer & command palette

Slash commands (`/plan`, `/status`, `/approve`, `/hire`, `/budget`), autocomplete, attachments, markdown; global **⌘K** action layer.

## Realtime scaling

`packages/realtime` abstraction (write-via-Fastify, subscribe-to-topic). Broadcast-from-Postgres now (**not** Postgres Changes — [ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md)); since-cursor catch-up for reconnects/late joiners; documented migration to a Fastify uWebSockets + Redis gateway past the ~500-concurrent ceiling.

## Density & theming

Warm Chat skin by default; compact density for power users; per-business accent tints chrome, never message text.

## Key entities

`rooms` · `channels` · `threads` (**live**, written by `accept_offer`) · `messages` (idempotency key, `seq` ordering cursor, `author_kind`, `persona?`, `thread_id?`) · `room_members` (`scope`, `thread_id?`, `expires_at`) · `reactions` / `pins` · `action_embeds` (component, payload, `required_role`, state) · presence (ephemeral, Realtime).

## A third topic namespace: `notify:user:<uid>` (notifications slice 1, `20260909122000`)

`chat:room:<id>` and `chat:thread:<id>` are joined by membership in a **place**.
The inbox topic is joined by **being a person**, which is the difference that
decides its shape ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)).

It is a **separate SELECT policy** on `realtime.messages`, not a third `OR`
disjunct inside the two above. What `20260906120000` refused to duplicate was the
`expires_at` time-box, which lives on `room_members`; this topic has no membership
row and no time-box, so there is nothing to keep in step, and folding a predicate
about a person into two predicates about rooms would mean the next person to edit
either had to reason about all three. There is **no send policy**, because nobody
is present in their notifications: the client subscribes and never calls
`track()`, and the pgTAP suite pins that a node cannot push to their own inbox
topic.

The client is `apps/web/components/inbox/useInbox.ts`, and it is this shell's
subscription pattern copied deliberately rather than abstracted: `getSession()`,
`realtime.setAuth`, a private channel, `broadcast` on `INSERT`, a since-cursor
catch-up on `SUBSCRIBED` because a live subscription is not durable catch-up, and
a visible line when the socket drops. That makes three copies of the sequence
(`ChatApp`, `ThreadPanel`, `useInbox`); the note in that file says the third is
where extracting it becomes worth doing, and what stopped it is that the two chat
copies also carry presence, message merging and embed dedupe, so the shared thing
would be four lines of setup behind six parameters.

**Scoping is the point.** A room topic tells somebody about the room they are
looking at. An owner running two businesses, and a node whose work lives in
threads their access to has been revoked, are both people the chat topics
structurally cannot reach.

## History (slice by slice)

> How the module got here. The current state is summarised in **Current shape** at the top,
> which is what a later session should read instead of this.

> **Implementation status (Phase 2, in progress):** the chat runs entirely on live data. The **server-authoritative write path and persistence are live**: `POST /api/rooms/:roomId/messages` and `GET /api/rooms/:roomId/messages` (since-cursor catch-up) in `apps/api`, with delivery to Realtime subscribers verified end-to-end, and `apps/web` reads sign-in, rooms, channels, members, message history, live Realtime delivery and Realtime Presence with **no mock data left**. **The AI is a member rather than a widget:** a posted goal starts an agent run and the reply arrives as an ordinary message with `author_kind='agent'`, rendered inline. **Four embed components are live**, each described below: `plan` (`20260812120000`), `question` (`20260815120000`), `artifact` (`20260815210000`) and `replan` (`20260828130000`). **Threads are live and written** as of slice 5 of the marketplace sequence (`20260904125000`): `public.accept_offer` creates a task's thread and admits the expert who took it, thread-scoped, in the same transaction. `threads` still has **one policy, for SELECT, and no client write grant** — the writer runs under the secret key, so creating a thread needed a grant rather than a policy. **`author_kind = 'node'` gained its writer in the same slice** (`20260904127000`): a node posts **through their own grant, on the existing client path**, because every participant INSERTs like any member (rule 5) and a server-mediated route would have been a second write path to keep in step. The route derives `author_kind` from the caller's own membership row and RLS re-checks it. **The owner's stream interleaves both conversations**, marked with a "in a task thread" label rather than filtered, because hiding rows the owner may read is the fetched-never-rendered defect. **Thread realtime topics landed in slice 6** (`20260906120000`), emitted **beside** the room topic rather than instead of it, so the node console subscribes and its ten-second poll is gone while the owner keeps reading thread messages in realtime. **Slice 8 adds two system-message keys and no new component**: `dispute-raised:<id>` when either party raises, and `dispute-resolved:<id>` when an operator decides. Both land in the **room** and deliberately not in the working thread, because a dispute is decided by an operator rather than negotiated between the parties and a line in that thread would invite exactly that negotiation. **Not built yet:** a thread switcher in the owner's UI, reactions, pins, mentions, saved messages, and the remaining embed components (approval, pay, sign, assign), which land with the marketplace and payments. See [design-system-frontend.md](design-system-frontend.md).
