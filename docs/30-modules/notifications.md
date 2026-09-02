# Module: Notifications

> Owns multi-channel, **idempotent** notification fan-out: node offer alerts with expiry/cascade, human-action requests, and deliberately low-frequency **batched** user digests. Keeps tasks from stalling on unresponsive nodes and keeps user involvement minimal.
>
> **Owner paths:** `supabase/migrations/20260909*`, `apps/api/src/routes/notifications.ts`, `apps/web/components/inbox/**`, `apps/web/lib/notification-copy.ts`, `apps/web/app/inbox.css` · **Depends on:** chat-discord (the Realtime transport), human-nodes-marketplace (the moments), auth-identity (whose inbox it is).
>
> Update on any change to channels, the recipient map, digest strategy, or preferences.

## Implementation status (slice 1, 2026-09-09)

**In-app is built. Nothing else is.** One channel, eleven moments, two surfaces.

Before this slice, every marketplace slice from 4 to 8 closed with the same line: nobody is notified of anything. An offer, an acceptance, a handover, a rejection, a payout and a dispute were all discovered by opening `/node` or the room and looking, which is what set the 48-hour offer window and the seven-day work deadline ([matching.ts](../../packages/marketplace/src/matching.ts): "anything shorter would expire against people who had not looked yet").

### Built

- **`public.notifications`** (`20260909120000`), one row per person per moment. No status column: `read_at is null` is the only distinction anybody makes. `DELETE` and `TRUNCATE` revoked including for `service_role`, because the row is the record **that somebody was told** and the first place that matters is a dispute where one party says they never heard.
- **Derived by trigger from `public.events`**, never written by callers ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)). Six of the eleven moments are written by SQL functions that no Node-side helper could reach, so the deriving trigger is the only place that guarantees a moment cannot be recorded without the person being told. Deduplicated on `key` = `<verb>:<subject_id>:<user_id>`, because `events` has no unique key of its own.
- **A per-user Realtime topic** `notify:user:<uid>` with its own SELECT policy on `realtime.messages`, so the count moves without a reload and across every business a person is in. The chat topics are scoped to one room and could not do this.
- **The inbox**: a bell in the room's top bar and on `/node`, its panel, and three routes (`GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`), all read as the caller so RLS is the authorisation.

### The recipient map

| kind (the event verb)             | who is told                                                            |
| --------------------------------- | ---------------------------------------------------------------------- |
| `offer.created`                   | the node it was offered to                                             |
| `offer.accepted`                  | the owner                                                              |
| `proof.submitted`                 | the owner                                                              |
| `proof.bounced`                   | the node (the criteria check refused it, so nothing reached the owner) |
| `work.approved` / `work.rejected` | the node, through the engagement still live on the step                |
| `engagement.reassigned`           | the node who lost it, **and** the owner                                |
| `payout.settled`                  | the node                                                               |
| `dispute.raised`                  | the **other** party, by `raised_role`                                  |
| `dispute.resolved`                | both parties                                                           |
| `node.kyc_status_changed`         | the node (`project_id` is null on this one)                            |
| `task.transitioned`               | the owner, and **only** on `matching -> escalated`                     |

`task.transitioned` fires on every step of every project several times each, so the narrowing is a `where` clause in the trigger rather than a comment. Exhaustion is the one transition that is news: it is the cascade running out and the step coming back to somebody who has to act ([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)).

### Copy is not in the database

The row stores the facts a sentence is made from; `apps/web/lib/notification-copy.ts` composes the words. Copy then changes without a migration, and **AGENTS.md rule 22, which bans em dashes in notification copy by name, is a unit test** over every kind, every recipient role, every dispute resolution and every KYC outcome rather than something a reviewer has to notice in a migration.

### The badge rule

One rule, both surfaces: **amber `--warn` with the visible word "need you" when something is waiting on the reader; a neutral count saying "new" otherwise; hidden at zero.**

The predicate is "nothing moves until they do", not "this is important". Five slots qualify: an offer, a bounced handover and a rejection to a node, and a handover and an exhausted cascade to an owner. A dispute raised against somebody matters enormously and is deliberately not amber, because an operator decides it and the reader has no button.

The alternative was one amber count for everything unread. Refused on design-system.md's own rule that a hue carries a word: an owner whose badge is permanently amber because an expert was paid last week stops reading the one that says work is waiting. **No glow** (rule 14, reserved for live agent presence) and **not in a corner** (the chatbot bubble on the never-ship list); the panel hangs off the bell that opened it.

### Not built, and not claimed

- **Web push, email, SMS and mobile push.** All four need a paid provider, which the dev budget rule excludes. When the first lands it is a provider seam in the shape of `packages/payments`, reading the same rows, with `delivery_log` beside it.
- **`notification_preferences`, `inbox_items`, `offer_alerts`, `delivery_log`.** Named below and still without tables. Preferences in particular are meaningless with one channel that cannot be muted without becoming the state this slice ended.
- **Digests.** `apps/api/src/lib/waiting.ts` still posts the per-tick `needs_user` / `escalated` digest into the room and is unchanged. It is the owner's waitpoint channel and was deliberately left alone: duplicating it into the inbox would tell the same person the same thing twice.
- **Backfill.** The trigger is `AFTER INSERT` and 757 events predate it, so every inbox starts empty. Telling somebody now about an offer that expired last week is worse than not telling them.
- **Shortening `OFFER_TTL_MS` and `WORK_TTL_HOURS`.** Now **unblocked, not changed.** The reason they are 48 hours and 7 days no longer holds, but shortening them is its own decision with its own reasoning about time zones and about what somebody who is asleep is entitled to.
- **An inbox on `/ops`.** Operators work a queue, and a queue is not an inbox.

### A repeat of the same moment tells you once, and that is the key's cost

The dedup key is `<verb>:<subject_id>:<user_id>`, with no occurrence counter in
it. So a step that is sent to the market, exhausts, is sent again and exhausts
again produces **one** notification, not two. Measured on the live database
rather than reasoned about: three `matching -> escalated` events exist for one
step there, and the owner has one row.

This is the direct cost of the property the key buys. `public.events` has no
unique key and a retried sweep can write the same moment twice, so something has
to collapse repeats, and anything that distinguishes a genuine second occurrence
from a replay has to count prior events per notification.

`match.ts` solved the same problem for the room's system message by putting a
`returnEpoch` in its key, which is a `count(*)` over `events` per message. That
is affordable in a sweep and less so in a trigger that runs inside
`settle_payout`. The honest summary is that **the inbox is a "what is waiting"
surface rather than a log**: the step is still escalated and still on the owner's
panel, so the state is not lost, only the second nudge. If somebody hits this in
practice the fix is an epoch in the key for the repeatable kinds only
(`task.transitioned` is the only one where a genuine repeat is likely), not a
change to the whole scheme.

## Responsibilities

- Reliably notify **nodes** of offers (with expiry + cascade) so tasks never stall.
- Notify the **user** sparingly — real-time only for approvals; everything else batched.
- Guarantee **idempotent** delivery so durable-workflow retries never double-notify.

## Channels (fan-out)

- **In-app / Realtime** (default) — ✅ inbox + unread counts, in the room and on `/node`.
- **Web push** — ⏳ approvals and mentions.
- **Email** — ⏳ digests, receipts, offer summaries.
- **SMS / WhatsApp** — ⏳ urgent, time-sensitive node offers only.
- **Mobile push** — ⏳ the node "Warm Concierge" surface (Phase 4).

## Node offer notifications

Carry scope, escrowed price, deadline, deep link, and expiry. On decline/expiry, **auto-cascade** to the next ranked node (logic owned by [human-nodes-marketplace.md](human-nodes-marketplace.md); this module handles delivery + timers).

**As built:** the in-app row carries the step title, the offer rate and `expires_at`, and the copy says how long is left. The cascade itself is unchanged and still lives in the matcher sweep; nothing here drives a timer yet.

## User-facing strategy

- **Batched progress digests** in-chat (the agent reports as a digest, not chatter). Unchanged: `waiting.ts` still owns this.
- **Real-time pings only** for approvals, money authorizations, and blocking questions.
- Goal: minimize user touches (a north-star guardrail — see [vision.md](../00-overview/vision.md)).

## Preferences

Per-channel mute/all/mentions, quiet hours, per-business overrides. Stored in `notification_preferences`. ⏳ Unbuilt: with one channel there is nothing to route and muting it would restore the condition slice 1 removed.

## Idempotency

Keyed sends (`notification key`) so a retried workflow step never double-notifies. **Built, and it is the `key` column**: `events` carries no unique key of its own, so this is the only thing standing between a retried sweep and a doubled inbox. Every delivery is logged to `delivery_log` (⏳ unbuilt, arrives with the first real channel).

## Consolidated inbox

A cross-business inbox of mentions + pending actions so a user running several ventures has one place to act. **Built for notifications**: the topic is per person rather than per room, so an owner running two businesses gets one count covering both. Mentions are not in it yet.

## Provider abstraction

One orchestration layer over push/email/SMS providers (e.g. Novu/Knock, Expo push, Resend/Postmark, Twilio) behind a typed adapter in [integrations.md](integrations.md), so providers can be swapped without touching callers. ⏳ Deliberately not declared in slice 1: a seam with one implementation that delivers nowhere is a shape guessed ahead of its first real caller.

## Key entities

`notifications` ✅ · `notification_preferences` ⏳ · `delivery_log` ⏳ · `inbox_items` ⏳ · `offer_alerts` ⏳

`inbox_items` and `offer_alerts` may never exist. `notifications` already carries what both were sketched for, and a second table would be a second answer to "what is waiting for this person".
