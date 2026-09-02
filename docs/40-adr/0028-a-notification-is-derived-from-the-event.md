# ADR-0028 — A notification is derived from the event, not written beside it

**Status:** Accepted · **Date:** 2026-09-09 · **Slice:** notifications 1 (in-app)

## Context

Every marketplace slice from 4 to 8 shipped with the same sentence in its own doc, and slice 8's is the plainest:

> **Nobody is notified of anything, still.** Notifications remain specified and unbuilt, so an owner learns their step was taken from a system message in their room, and a node learns nothing until they open `/node`. — [human-nodes-marketplace.md:710](../30-modules/human-nodes-marketplace.md)

That is not a missing convenience. It is load-bearing on two constants: `OFFER_TTL_MS` is 48 hours and `WORK_TTL_HOURS` is 168, and `packages/marketplace/src/matching.ts:36` gives the reason in as many words, that "anything shorter would expire against people who had not looked yet". The marketplace's deadlines are set by the absence of a doorbell.

[notifications.md](../30-modules/notifications.md) has specified five channels and five tables since Phase 0 and had zero code. Four of the five channels need a paid provider, which the dev budget rule excludes. In-app over the Realtime path the chat already uses needs nothing new, so that is what this slice builds and the seam for the others is deliberately not declared.

## Decision 1: the rows are derived from `public.events` by a trigger

`private.notify_from_event()` is an `AFTER INSERT` trigger on `public.events`. It is the only writer of `public.notifications`, and nothing calls it.

**The obvious alternative was a `notify(...)` helper called next to `postSystemMessage` in the routes, and it was rejected on a count.** Six of the eleven moments in the map are written by SQL, not by application code:

| moment                                  | written by                      |
| --------------------------------------- | ------------------------------- |
| `engagement.created` / `offer.accepted` | `public.accept_offer`           |
| `engagement.reassigned`                 | `public.reassign_engagement`    |
| `payout.settled`                        | `public.settle_payout`          |
| `dispute.raised`                        | `public.raise_dispute`          |
| `dispute.resolved`                      | `private.guard_dispute_resolve` |
| `node.kyc_status_changed`               | `private.guard_node_kyc_audit`  |

A Node-side helper reaches none of them without re-implementing their transactions in TypeScript, which is the two-writers-over-one-truth shape this repository keeps paying for. `public.events` is the one ledger all of them already write, in the same transaction as the fact. Deriving from it gives the property the slice exists for and that nothing else can give: **a moment cannot be recorded without the person it concerns being told, including by a writer that does not exist yet.**

### The accepted cost, stated rather than discovered

This trigger runs inside `settle_payout`. **A defect in it aborts a payout.** That is real and it is accepted, bounded by three things:

- Every enrichment is a `left join`, so a missing step title or a deleted room can never be the defect.
- The verb list is a closed `case`, so an unknown verb returns before touching anything and no future event can reach the code by accident.
- `supabase/tests/notifications.sql` derives at least one row for every verb in the map, so a payload rename fails a suite rather than a transfer.

The alternative was catching everything and continuing. Refused under rule 16: a notification silently not written is indistinguishable from the state this slice was built to end, and nobody would ever find it. The one thing that raises is an **unresolvable recipient**, which means the payload it was reading changed shape.

### Dedup lives on the notification, because `events` has none

`public.events` has no unique key, and `apps/api/src/lib/match.ts:478-481` says why that matters: it writes `offer.created` only after the task has moved, because a replay would otherwise put two offers in the trail where one was made. So `notifications.key` is `<verb>:<subject_id>:<user_id>`, unique, and the trigger inserts `on conflict do nothing`. A collision is the mechanism working: this person has already been told this thing.

## Decision 2: the row stores facts, the client composes the sentence

`payload` carries the step title, the money, the deadline, the resolution. It never carries the sentence. `apps/web/lib/notification-copy.ts` turns a row into a title, a body and a link.

Three reasons, in the order they weigh:

1. **Text in a row needs a migration to fix a typo**, and product copy is the thing in this system most likely to be rewritten.
2. **AGENTS.md rule 22 bans em dashes in notification copy by name.** A template in TypeScript is walked by a unit test over every kind and every dispute resolution; a string built in plpgsql is checked by whoever happens to read the migration.
3. Composing it in SQL would put product voice in the one place nobody reviews for voice.

The cost is that a reader of the table alone sees `work.rejected` and a jsonb blob rather than a sentence. `events` already has that property and is already the trail a dispute reads.

### The payload is an allow-list, and that is not tidiness

Each branch of the trigger names the keys it forwards. Carrying `new.payload` wholesale would have been shorter and would have disclosed **`resolved_by`**, the operator who decided a dispute, to both parties, silently, as a side effect of a convenience. `20260907123000` made the counterparty-disclosure decision explicitly and `20260908126000` widened it explicitly. What a recipient can read is a decision somebody makes, never something they inherit.

`platform_fee` and `transfer_id` are dropped from `payout.settled` on the same principle plus one of its own: the take rate is not deducted from an agreed price ([ADR-0024](0024-the-take-rate-is-not-deducted-from-an-agreed-price.md)), so showing a fee beside the amount would invite exactly the reading that ADR refuses.

## Decision 3: `notify:user:<uid>` is a third `realtime.messages` policy, not a third disjunct

This adds a topic namespace beside `chat:room:<id>` and `chat:thread:<id>`, delivered by a trigger on `notifications` that calls `realtime.broadcast_changes`, and read through a new SELECT policy:

```sql
create policy "realtime_own_inbox_can_receive" on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'notify:user:' || auth.uid()::text);
```

`20260906120000:47-56` refused a third policy in terms that sound absolute:

> A separate additive policy would union to the same rows and leave **two copies of the `expires_at` time-box** to keep in step ... an expired node would keep a live socket while correctly losing the rows.

Every word of that stands and none of it reaches this topic. **What the rule protects is the time-box, and the time-box lives on `room_members.expires_at`.** The chat topics address a _place_ and are joined by membership in it; this one addresses a _person_ and is joined by being them. Its predicate is `auth.uid()`: no membership row, nothing that can go stale, no second copy to keep in step. Folding it in as a third `OR` would bolt a predicate about a person onto two predicates about rooms, and the next person to alter those policies would have to reason about all three to change either.

**There is no send policy.** `20260728200000` added the INSERT half because `channel.track()` makes the client write to `realtime.messages`, and without it every member silently showed offline. Nobody is _present_ in their notifications: the client subscribes and never tracks. The pgTAP suite pins the absence by asserting a node cannot push to their own inbox topic.

### The assertion this changes, changed in the same push

`supabase/tests/thread_scope.sql` asserted that `realtime.messages` carries **exactly two** policies. That assertion is amended rather than deleted: the two-policy claim is now scoped to the two chat policies it was always about, and a second assertion pins the total at three. `notifications.sql` asserts the total as well. Changing that count still costs somebody an argument in a suite, which is the point of having asserted it.

`security-compliance.md` carries the same dated amendment.

## Consequences

- `public.notifications` is written by one trigger and by nothing else. `authenticated` has no INSERT, and `DELETE` and `TRUNCATE` are revoked from `service_role` too: the row is the record **that somebody was told**, and the first place that matters is a dispute where one party says they never heard.
- `read_at` is the only column a client may write, enforced twice: a column grant, and a guard trigger that also stamps the clock so a browser cannot backdate the one fact the row is asked to prove.
- **Existing events produce nothing.** The trigger is `AFTER INSERT`, there is no backfill, and 757 events predate it. Every inbox starts empty, which is correct: telling somebody now about an offer that expired last week is worse than not telling them.
- `OFFER_TTL_MS` and `WORK_TTL_HOURS` are **unblocked, not changed.** Shortening them is a separate decision with its own reasoning about time zones and about what a person who is asleep is entitled to, and it should be made when somebody actually wants the market to move faster.
- The other four channels, preferences, digests and `delivery_log` stay unbuilt and stay specified. When the first one lands it is a provider seam in the shape of `packages/payments`, reading the same rows.

## Links

- [notifications.md](../30-modules/notifications.md) · [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) · [chat-discord.md](../30-modules/chat-discord.md) · [data-model.md](../10-architecture/data-model.md)
- [ADR-0003](0003-realtime-broadcast-not-postgres-changes.md) — the broadcast transport this reuses
- [ADR-0016](0016-an-engagement-has-no-state-of-its-own.md) — why `notifications` has no status column either
- [ADR-0024](0024-the-take-rate-is-not-deducted-from-an-agreed-price.md) — why the fee is not in the payout notification
- `20260909120000_notifications.sql`, `20260909121000_notify_from_event.sql`, `20260909122000_notification_realtime_topic.sql`
