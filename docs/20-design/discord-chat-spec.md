# Discord-style Chat Spec

> The chat **is** the product surface. This spec defines the 5-region layout, roles, interactive embeds, presence, and the server-authoritative write path. Pairs with the [chat-discord](../30-modules/chat-discord.md) module doc (behavior/data) and [design-system.md](design-system.md) (tokens/motion). Update on any layout, role, embed, or transport change.

## Design intent

A **Discord-shaped** collaboration space where the **user, the AI agent, and human nodes are all first-class members**. Familiar (people already know Discord), multiplayer, and built for a long-running project rather than ephemeral chatter. Warm and alive (presence, tactile motion), but calm enough to hold money and legal decisions.

## 5-region layout

```
┌──────┬───────────────┬───────────────────────────────┬──────────────┐
│ Guild│  Channel       │  Message list (the stream)     │ Context panel │
│ rail │  sidebar       │                                │ (members /    │
│      │  (workstreams) │  [inline AI stream + embeds]   │  task / RAG   │
│ =    │                │                                │  sources)     │
│ your │  #registration │                                │              │
│ biz- │  #location     │                                │              │
│ ness-│  #suppliers    │                                │              │
│ es   │  #licensing    │                                │              │
│      │  #branding     │                                │              │
├──────┴───────────────┴───────────────────────────────┴──────────────┤
│ Composer (slash commands · autocomplete · attachments · markdown)     │
└───────────────────────────────────────────────────────────────────────┘
   Top bar: business name · phase · budget (tabular) · ⌘K · presence avatars
```

1. **Guild rail** (far left) — one entry per **business/venture** the user runs (the octopus's parallel arms). Per-business accent color.
2. **Channel sidebar** — **workstreams** as channels (`#registration`, `#location`, `#suppliers`, `#licensing`, `#hiring`, `#branding`, `#budget`) + threads/topics for subtasks.
3. **Message list** — the stream. The AI posts **inline** here; human nodes post here when engaged; system messages record the audit trail.
4. **Context panel** (right) — members (with roles/presence), the current task card, and **RAG sources/citations** for what the AI just claimed.
5. **Composer** — slash commands (`/plan`, `/status`, `/approve`, `/hire`, `/budget`), autocomplete, attachments, markdown.

Top bar carries business name, current phase, live **budget (tabular numerics)**, ⌘K, and presence avatars.

## Roles & identity

| Role         | Token          | Badge                         |
| ------------ | -------------- | ----------------------------- |
| You (owner)  | `--role-you`   | "You"                         |
| AI Agent     | `--role-agent` | "Agent" + working pulse       |
| Human Node   | `--role-node`  | "Node"                        |
| Verified Pro | `--role-pro`   | "Verified" ✓ (license-backed) |
| Admin/Ops    | `--role-admin` | "Ops"                         |

**Never color alone** — every role is color **+ badge + icon** (accessibility, and to survive colorblind/low-contrast).

**The AI Agent row is four voices, one badge.** Strategist, Content, Ads and Analyst share `--role-agent`, the teal avatar and the "Agent" badge; only the name and the two initials differ (`messages.persona`, `20260912120000`). The badge deliberately does not fork: what a reader must not get wrong is that the AI wrote this rather than a person, and that claim stays carried by a word. A message with no persona renders under the single legacy name, `Octopus`. See [chat-discord.md](../30-modules/chat-discord.md) for the stage-to-voice table.

## The AI, inline (not a bubble)

- The agent's messages render with a subtle **accent bar** + **Agent** tag, in the normal stream position — it is a member, not a widget.
- **Live token streaming**: responses stream in; a gentle **bioluminescent working pulse** shows the agent is actively doing something (tool call, retrieval, drafting).
- The agent's messages **double as the audit trail** — plan diffs, tool results, escalations, and payments appear as first-class (and system) messages.

## Interactive action embeds

Rich cards embedded in the stream, **permission-gated by role**:

| Embed                    | Primary action                                           | Who can act            |
| ------------------------ | -------------------------------------------------------- | ---------------------- |
| **Plan card**            | Approve plan / request changes                           | Owner                  |
| **Approval**             | Approve / reject an irreversible step                    | Owner                  |
| **Pay / release escrow** | Release funds to node                                    | Owner                  |
| **Sign**                 | Route a document to the owner/node to sign               | Owner / node           |
| **Assign / Offer**       | Send/accept a node offer (scope, escrow price, deadline) | Node (accept) / system |
| **Question**             | Answer on the card: one chip or short field per question | Owner                  |

- Embeds carry state (`pending`, then `approved`/`rejected` for a verdict, `answered` for a question, `reported` for a deliverable, `dismissed` or `expired` when nobody did), show **money in tabular numerics**, and enforce `required_role` server-side (not just in UI).
- A **Question** is never answered in the composer. A chat message is always a goal; each answer is its own embed action, saved as it lands, and the card closes itself when what it needs is there or when the owner says to plan with what they have said.
- A node **cannot** see or act on owner-only embeds; RLS + the embed's `required_role` both enforce this.

## Threads & topics

- **Threads** per subtask; **Zulip-style named topics** for resumable, separable work ("Lease — 12 Rustaveli Ave", "Health permit — inspection prep").
- A human-node engagement lives in its **own thread**; the node's membership is **scoped to that thread and time-boxed** (`room_members.scope`, `expires_at`).

## Mentions, reactions, pins

- `@user` / `@agent` / `@role` / `#channel` mentions with autocomplete.
- Reactions, pins, saved messages.
- Mentions and unread/pending-action counts drive [notifications](../30-modules/notifications.md).

## Presence

- Supabase Realtime **Presence**: online / idle / dnd, typing indicators, and **activity states** ("Agent is retrieving sources…", "Node is on-site").
- Member panel shows who's here and their live state.
- **The agent group is separate and derived, not subscribed.** The four voices sit under their own "Octopus" label below the people, always answering rather than online or offline, each with one line saying what it is doing. A working voice takes the **breathing teal dot**, which is the same reserved glow as the message pulse and means the same thing. The line beside it says so in words, so the state never rests on colour or motion alone.

## System messages (audit trail)

Rendered distinctly (muted, iconographic): "Agent created the plan", "Node **@…** joined #licensing", "Escrow of **$X** held", "Company registered — confirmation #…", "Payout of **$Y** released". These are the human-readable projection of the event-sourced log.

## Write path (server-authoritative)

1. Composer `POST`s to the Next BFF → Fastify `POST /rooms/:id/messages` (JWT).
2. Fastify verifies membership (RLS), inserts the row with `idempotency_key` + `seq`.
3. A Postgres trigger broadcasts to `chat:room:{id}`; all members receive it live.
4. Optimistic send in the UI, reconciled on broadcast; reconnects/late-joiners catch up via a **since-cursor** REST fetch.

See [ADR-0003](../40-adr/0003-realtime-broadcast-not-postgres-changes.md) for the Broadcast-vs-Changes decision and the WS-gateway migration path.

## Density & theming

- **Warm Chat** skin by default here; **compact** density available for power users.
- Per-business accent tints the guild entry and subtle chrome — never the message text.

## Accessibility

- Full keyboard nav + ⌘K; roles via badge+icon; WCAG contrast in both skins; `prefers-reduced-motion` disables the working pulse's animation (keeps a static indicator).
