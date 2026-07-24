# ADR-0003 — Chat transport: Realtime Broadcast-from-Postgres, not Postgres Changes

- **Status:** Accepted
- **Date:** Phase 0
- **Context doc:** [architecture.md](../10-architecture/architecture.md), [chat-discord.md](../30-modules/chat-discord.md)

## Context

The chat is the product surface: Discord-shaped, multiplayer, with presence and interactive embeds, and the AI as a member. We need a realtime transport that is server-authoritative and scales.

## Decision

Use **Supabase Realtime with Broadcast-from-Postgres** (not Postgres Changes): messages are `POST`ed to Fastify, inserted (moderation/ordering/AI fan-out hook), then a Postgres trigger calls `realtime.broadcast_changes()` to topic `chat:room:{id}`. Presence powers online/typing/activity. Wrap it in a `packages/realtime` abstraction (write-via-Fastify, subscribe-to-topic).

## Rationale

- **Server-authoritative persistence** — Postgres stays the source of truth; the AI participates by `INSERT`ing rows, no special path.
- **Broadcast scales better than Postgres Changes**, which is WAL-per-subscriber (poor fan-out) and can leak column-level data.
- RLS-authorizable channels → security for free.

## Consequences

- Late joiners/reconnects catch up via a **since-cursor** REST call (live subscription is not durable catch-up).
- **Migration path:** past Supabase's ~500-concurrent soft ceiling (or when we need server-authoritative sequencing, slash-command/rate-limit logic, or higher AI-stream throughput), swap the transport for a **Fastify uWebSockets gateway + Redis/Upstash pub-sub**. The abstraction keeps the client contract identical, so the swap is non-breaking. Trigger recorded in [infra-devops.md](../30-modules/infra-devops.md).
