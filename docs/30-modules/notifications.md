# Module: Notifications

> Owns multi-channel, **idempotent** notification fan-out: node offer alerts with expiry/cascade, human-action requests, and deliberately low-frequency **batched** user digests. Keeps tasks from stalling on unresponsive nodes and keeps user involvement minimal.
>
> **Owner paths:** notifications code in `apps/api/**` + a provider adapter in `packages/core`/`integrations` · **Depends on:** chat-discord (mention/unread events), human-nodes-marketplace (offer lifecycle), integrations (push/email/SMS providers), ai-orchestrator (escalation/approval triggers).
>
> Update on any change to channels, the offer/cascade logic, digest strategy, or preferences.

## Responsibilities

- Reliably notify **nodes** of offers (with expiry + cascade) so tasks never stall.
- Notify the **user** sparingly — real-time only for approvals; everything else batched.
- Guarantee **idempotent** delivery so durable-workflow retries never double-notify.

## Channels (fan-out)

- **In-app / Realtime** (default) — inbox + unread counts in chat.
- **Web push** — approvals and mentions.
- **Email** — digests, receipts, offer summaries.
- **SMS / WhatsApp** — urgent, time-sensitive node offers only.
- **Mobile push** — the node "Warm Concierge" surface (Phase 4).

## Node offer notifications

Carry scope, escrowed price, deadline, deep link, and expiry. On decline/expiry, **auto-cascade** to the next ranked node (logic owned by [human-nodes-marketplace.md](human-nodes-marketplace.md); this module handles delivery + timers).

## User-facing strategy

- **Batched progress digests** in-chat (the agent reports as a digest, not chatter).
- **Real-time pings only** for approvals, money authorizations, and blocking questions.
- Goal: minimize user touches (a north-star guardrail — see [vision.md](../00-overview/vision.md)).

## Preferences

Per-channel mute/all/mentions, quiet hours, per-business overrides. Stored in `notification_preferences`.

## Idempotency

Keyed sends (`notification key`) so a retried workflow step never double-notifies. Every delivery is logged to `delivery_log` (part of the audit trail).

## Consolidated inbox

A cross-business inbox of mentions + pending actions so a user running several ventures has one place to act.

## Provider abstraction

One orchestration layer over push/email/SMS providers (e.g. Novu/Knock, Expo push, Resend/Postmark, Twilio) behind a typed adapter in [integrations.md](integrations.md), so providers can be swapped without touching callers.

## Key entities

`notifications` · `notification_preferences` · `delivery_log` · `inbox_items` · `offer_alerts`.
