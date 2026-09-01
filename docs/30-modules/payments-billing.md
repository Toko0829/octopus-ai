# Module: Payments, Escrow & Billing

> Owns all money movement: user subscription/budget pre-authorization, escrow-equivalent holds via **separate charges & transfers**, verified-completion payouts to nodes' connected accounts, an immutable **double-entry ledger**, platform fees, and dispute-driven fund handling. **Strict idempotency and event-sourcing throughout.**
>
> **Owner paths:** `packages/payments/**` (the chart of accounts, the balanced pairs, the idempotency keys, the provider seam and its registry) · payments code in `apps/api/**`, Stripe webhooks in `apps/api/**` · **Depends on:** human-nodes-marketplace (task/engagement pricing, approval trigger), auth-identity (role-gated approvals), integrations (Stripe Connect), admin-ops (dispute console), business-projects-workflow (project budget ceiling).
>
> **This line used to say `packages/core/**` (ledger), and the correction is
> mechanical rather than aesthetic.** `.docmeta.yml` maps `packages/core/**` to
> [business-projects-workflow.md](business-projects-workflow.md), so a ledger
> there would be **doc-mapped to the wrong module by construction**: every change
> to the chart of accounts would be obliged to edit the workflow doc and free to
> leave this one untouched. Reconciled in place rather than worked around, which
> is the `credentials → node_credentials` precedent (rule 1: when the
> specification and the schema disagree, reconcile).
>
> Update on any change to the money flow, ledger, escrow model, or the regulatory posture. Money-related schema also updates [data-model.md](../10-architecture/data-model.md); posture changes update [security-compliance.md](../10-architecture/security-compliance.md).

## Escrow-equivalent model

Stripe is **not** a licensed escrow provider. The sanctioned pattern is **separate charges & transfers**: capture the customer charge on the **platform** account, **hold** the funds, then **transfer** to the node's connected account only after approval — using delayed payouts for escrow-style timing.

> **What is live is the model of that hold, and none of the money.** Since
> `20260904121000` a node accepting an offer writes an `escrow_holds` row against
> the already-authorised `projects.budget_ceiling`, and a balanced
> `ledger_entries` pair beside it. The only registered provider is a
> deterministic in-repo fake that makes no network call, holds no key and settles
> nothing, and its `charge_id` is visibly `ch_fake_…` in every row this build
> writes. The counsel gate below is unmoved: modelling an obligation is not money
> movement. See "Regulatory posture" for what changes that.

## Money flow

1. **Budget pre-auth** — user authorizes a project budget ceiling up front (a guardrail; escrow can never exceed it).
2. **Hold on accept** — when a node accepts an offer, the platform captures/holds the task price (charge on platform account). Funds are in escrow; **no transfer yet**.
3. **Approve** — node completes → proof approved by AI critic + user.
4. **Transfer** — approval triggers a **Transfer** to the node's Stripe Connect **Express** connected account, **minus the platform fee** (application fee).
5. **Payout** — to the node's bank/debit; **Instant Payout** to debit card optional for eligible nodes.
6. **Dispute** — freezes the transfer; ops can release, partially release, or refund-to-user from the held balance.

## Node payout onboarding

Connect **Express** so Stripe handles the node's KYC/tax (1099-K / DAC7 / local equivalents) and payout compliance. Instant-payout eligibility per Stripe rules.

## The escrow lifecycle

`held | released | refunded`, as checked text rather than an enum, because
`alter type ... add value` cannot be rolled back and this vocabulary is young.
**One arc is mapped:**

| From   | To         | Made by                                                                                                                        |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `held` | `refunded` | `apps/api/src/lib/escrow-reconcile.ts` (a cancelled step) **and** `public.reassign_engagement` (a no-show), both on the ticker |
| `held` | `released` | `public.settle_payout` (slice 7), called by the payout sweep once a transfer has answered                                      |

**`released` was in the check constraint and out of the map for two slices**, and
the wording that pinned the refusal was **descriptive** ("no producer exists")
rather than promissory — precisely so that the day it stopped being true would be
a change of fact rather than a promise coming due. `20260907120000` permits the
arc and lands **in the same push** as `settle_payout`, which walks it.

**Both settlements are terminal and neither reaches the other**, which is the
property that now needs guarding rather than the absence that used to. A released
hold that could be refunded would take back money somebody earned; a refunded one
that could be released would pay for work that was cancelled. Reversing either is
a **new** hold with its own key, which is what a dispute is (slice 8).

**`held → refunded` has a producer in the same slice that created the arc**, and
it exists because the alternative is a real defect. A step cancelled after its
escrow was funded leaves the hold at `held`; a held hold commits the ceiling
([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)); so part of
the owner's authorised budget would be pinned forever against work that will never
happen, with no visible cause. The reconcile sweep unwinds four things together:
the hold moves conditionally, the reversing ledger pair is written against the
same `ref_id`, the engagement ends as `cancelled`, and the node's thread
membership is revoked by stamping `expires_at`.

**A step that reached `done` is never refunded**, and that exclusion is the most
consequential line in the sweep: `done` means approved, and refunding it would
take back money somebody earned. That hold is the payout's to release.

**That exclusion stopped being free in slice 6.** `escrow-reconcile.ts` recorded
it as "free today and load-bearing the moment `escrow_funded → in_progress` has a
producer", because nothing could reach `done` while holding escrow. It has a
producer now.

**And in slice 7 it became unreachable rather than merely load-bearing**, which is
the better outcome: `settle_payout` walks the step to `done` in the same
transaction that releases its hold, so a `done` step never has a `held` hold for
the sweep to find. The exclusion stays in the sweep anyway, because a rule that is
correct and currently unexercised is cheaper than a rule somebody has to re-derive
the day a second path reaches `done`.

### `held → refunded` gained a second producer (slice 6)

`public.reassign_engagement` refunds a hold for a different reason: the expert who
took the step missed the agreed date, so the work goes back to the market and the
money goes back to the owner. Three things separate it from the reconcile sweep
and all three are stated in [ADR-0023](../40-adr/0023-a-breached-deadline-reassigns.md):

- **It is one transaction rather than four condition-idempotent steps**, because
  one of the actors in the window is a live human doing work, and every partial
  state is unsafe. A moved task with a stale hold makes `accept_offer` refuse the
  replacement for money already spoken for; a moved task with a live engagement
  makes the replacement collide on `engagements_one_live_idx` and unwind
  permanently on every retry.
- **The engagement ends as `'reassigned'`, not `'cancelled'`**, which gives that
  value its first producer and finally justifies the partial
  `engagements_one_live_idx`: a second engagement on the same task is exactly what
  the next acceptance creates.
- **It never touches a step that was handed over.** `proof_submitted`,
  `in_review` and everything after are refused by the transition map and excluded
  by the sweep's selection. A deadline that passes after delivery is the owner's
  failure to review, and reassigning there would take a finished person's fee and
  give it to a stranger.

**Nothing is refunded at a provider, because nothing was ever charged.** The
argument is `escrow-reconcile.ts`' and it transfers unchanged: routing an internal
correction through a `provider.refund()` that the only registered implementation
would answer trivially would dress it up as money movement, in the one domain
where that distinction is the whole regulatory posture. The counsel gate below is
unmoved.

## The payout lifecycle

`pending | paid | failed`, as checked text for the reason `escrow_holds` chose it:
`alter type … add value` cannot be rolled back and this vocabulary is one slice
old. **One arc is mapped:**

| From      | To       | Made by                                                                 |
| --------- | -------- | ----------------------------------------------------------------------- |
| `pending` | `paid`   | `public.settle_payout`, once the provider has answered with a reference |
| `pending` | `failed` | `public.resolve_dispute`, and **only** it. See below                    |

**`failed` was in the check constraint and out of the map for the length of slice
7**, which is exactly the shape `released` had one table over until that slice
closed it, and the absence was argued rather than pending: nothing in this
codebase decides that a payout for work an owner has already approved will never
happen, every failure retries at tick cadence and is logged loudly, and a
terminal row against work somebody did, in a build with no ops console that could
un-terminal it, is the worse outcome. That paragraph named its own producer: the
console, with a person behind it.

**`20260908121000` is that producer arriving, and it is narrower than the name
suggests.** `failed` does not mean a transfer failed. It means a payout was
**overtaken by a dispute** — the row was `pending`, an operator resolved the
dispute some way other than paying, and the money went elsewhere in the same
transaction. A transfer that errors still retries forever, exactly as before, so
the retry argument above is untouched. The only writer is `resolve_dispute`, and
there is still no route, no sweep and no operator button that can fail a payout
on its own.

That is the one place this domain's failure map **differs from publishing**.
[ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md) closes a campaign
on a policy rejection because an ad platform genuinely decides whether to accept a
creative, and retrying it unchanged asks the same reviewer the same question. A
transfer for approved work is not a question anybody gets to answer no to on the
node's behalf, so `PaymentProvider.transfer` has no refusal kind and no
`AdapterResult`-style union: every failure is transient as far as this code is
concerned.

**`transfer_id` is null until the transfer returns and write-once forever after**,
enforced by a trigger rather than by a comment, on `ad_entities.external_id`'s
precedent. A writer that could clear it could make a paid payout look unpaid,
which is precisely the row the sweep reads to decide whether to transfer again.

### The ordering, and why it inverts the pause

A transfer **creates** something at a provider under an id the provider mints, so
the payout takes ADR-0013's ordering — record the intent, then call — rather than
[ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)'s inversion, where
the platform is called first because a pause creates nothing and re-derives from
durable rows. Four crash points, each resuming: the task moves to
`payout_pending`; the `payouts` row is inserted under `payoutKey(engagementId)`
and a collision reads it back; the transfer is skipped when `transfer_id` is
already recorded; and `settle_payout` returns early when the payout is already
`paid`.

**`settle_payout` is one transaction** because every partial state here is a money
defect somebody would reconcile by hand: a released hold under a live engagement,
a released hold with no ledger pair, a `done` step whose hold still pins the
ceiling, or a paid payout whose engagement never reached `'completed'` and whose
node's `completed_engagements` is therefore short of what slice 8 ranks on.

### Approving the work is the payout authorisation

There is no second button. The money flow above already specifies it ("approval
triggers a Transfer"), and ADR-0013's argument transfers unchanged: the owner
authorised this exact figure when the escrow was funded against their ceiling at
acceptance, has seen it on the step, and has read the proof and clicked approve. A
confirmation carrying no new information is one people learn to click through,
which weakens every other confirmation in the product.

## Double-entry ledger

Every movement writes balanced `ledger_entries` (debit/credit) — **append-only, immutable**. The ledger is the source of truth for reconciliation, not Stripe alone.

Live since `20260904122000`, with the strictest grants in the schema: `update`,
`delete` and `truncate` are revoked **including from `service_role`**, because
append-only that binds only clients is not append-only, and a ledger is the one
table where "the server could fix it up" is exactly the property that must not
exist. It has **RLS enabled and no policy at all**, the `events` posture: the
reader of raw entries is the Phase-3 ops console, and a member's view of money is
the projection the project GET builds. The advisor lints that as
`rls_enabled_no_policy`, which is the correct reading of an intentionally
unreadable table rather than a finding to clear.

**Balance is a property of two rows, so it is enforced where pairs are built.**
`packages/payments/src/ledger.ts` has no exported way to construct a single entry:
`escrowHoldPair` and `escrowRefundPair` each return both sides from one amount, and
`entriesBalance` is NaN-guarded the way `checkSpendCap` guards its amounts. The
hold pair is written a second time in SQL, inside `accept_offer`, because
acceptance has to be one transaction and a pair written from Node afterwards could
fail to write. Both halves are pinned by suites asserting the same property, on
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md)'s terms.

The chart of accounts is a reviewed file rather than an enum, on
`channel_connections.provider`'s precedent: it grows with every money feature, and
a migration per account is a migration per bookkeeping decision. Three accounts
exist: `owner_funds`, `escrow` and — since slice 7 — `node_payable`.

`node_payable` was **declined once by name** in `ledger.ts`, on the grounds that
adding it before anything paid out would be "an account with no entry, which is
the same shape as a state with no writer". `escrowReleasePair` is that entry.
**Nothing debits it in this build**, and that too is a decision: a
`node_payable → node_paid` pair would record money leaving the platform, and while
the only registered provider settles synchronously and takes nothing it would say
nothing `payouts.state` and `payouts.transfer_id` do not already say. It arrives
with the first provider whose settlement can be pending.

**The release pair carries the hold's `ref_id`, not the payout's**, mirroring
`escrowRefundPair`. That is what keeps every entry about a hold summing to zero on
every account once it settles, whichever way it settled, so "this hold is
finished" stays a fact a reader derives rather than a column they trust.

## Subscriptions & fees

Execution subscription tiers · milestone success fees · marketplace take-rate (~15–25%) · disclosed referral fees. See [vision.md](../00-overview/vision.md) for the full model.

## Spend governance

Per-task and per-project **ceilings enforced in tool code** (not prompts). Any tool call or offer that would breach the cap is blocked and escalated. A jailbroken prompt cannot overspend.

**`projects.budget_ceiling` has had two classes of committer since slice 5**:
non-terminal campaign `budget_cap`s and `escrow_holds` at `state = 'held'`.
[ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md) records the
contract that follows, in ADR-0011's discipline: **four places compute that sum
and must move in step**, each pinned by a suite so drift fails a test rather than
passing quietly. `accept_offer` and `materialise_campaign` take the row lock on
the **same** `projects` row, so an acceptance and a campaign approval serialise
rather than both reading a total the other is about to change.

## Dispute handling

Freeze transfer → ops review with full audit trail → outcome: release / partial release / refund-to-user / reassignment. Driven from [admin-ops.md](admin-ops.md).

**Live as of marketplace slice 8** (`20260908120000`…`128000`), with five outcomes rather than four: the fourth in that list splits into `reassigned` and `rejection_upheld`, the second of which answers a dispute only a node can raise and did not exist when this line was written.

**The freeze is a task state, not a flag.** `PAYABLE_TASK_STATES` in the payout sweep is `('approved', 'payout_pending')`, so moving the step to `disputed` is what stops the transfer: the selection stops matching it. Nothing else was added, because a flag beside the state is a second thing the sweep has to remember to read.

**A partial settlement is a refund plus a new hold** ([ADR-0025](../40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md)), which is this doc's own "reversing either is a new hold with its own key" sentence being cashed. Eight ledger entries across two `ref_id`s, four per hold, each summing to zero; `packages/payments/src/ledger.ts` is untouched because the three pairs it exports are exactly the three the SQL composes.

**`release` moves no money in the resolution itself.** It returns the step to `approved` and the existing payout sweep finishes it, reusing the recovery path built for a crash. A second money path there would be a second way to pay somebody.

**`payouts pending → failed` gets its producer**, and only this one: a payout overtaken by a dispute that refunded the hold underneath it, moved in the same transaction as the refund so the two records cannot disagree. A failed _provider call_ is still not this — it retries at tick cadence, because nothing here decides that approved work will never be paid. There is no `failed → pending`, because the money went back.

**Nothing is transferred, and the counsel gate is unmoved.** `carriesRealMoney` is now checked at three writers rather than two: before the accept rpc, before the payout transfer, and in the ops route before any resolution that settles escrow.

## Idempotency & event-sourcing

Every money movement carries an `idempotency_key` (unique DB constraint + durable activity) so retries after a crash never double-charge or double-pay. Every movement emits an immutable event.

**The keys are derived, never generated** (`packages/payments/src/keys.ts`). A
generated key satisfies rule 9's letter and none of its purpose: a retry mints a
second random string and the constraint never fires. `escrowKey(offerId)` is
derived from the **offer** rather than the task, which makes it naturally
epoch-ed: a step that came back to the market and was accepted on a later cascade
round derives a different key rather than colliding with the first attempt's hold.
`publishIdempotencyKey` in `packages/marketing` needed an explicit epoch counter
for exactly the case this shape avoids.

`accept_offer` builds the same string in SQL, because the insert has to be inside
the accept's transaction. Both derivations are pinned, in `keys.test.ts` and in
`marketplace_engagements.sql`.

## Multi-node task splits

One charge can fund **multiple transfers** (a task completed by several nodes) — each transfer idempotent and ledgered.

## Regulatory posture (counsel gate)

Holding escrow + routing payouts is likely **money-services activity**. **Before real (non-test) money moves**, clear with counsel: money-transmission / escrow-licensing per jurisdiction (US state MTL regime; EU e-money/payment-institution rules; GEL/FX for the future Georgia pack); platform-of-record determination; tax reporting. Do **not** hand-wave — see [security-compliance.md](../10-architecture/security-compliance.md).

**The gate is unmoved by slice 7, which is the slice that pays somebody.** A
payout is the first act in this domain that would be money movement if the
provider were real, and it is the reason `carriesRealMoney` is now checked in two
places rather than one: `apps/api/src/lib/engagements.ts` before the accept rpc,
and `apps/api/src/lib/payout.ts` before the transfer, **once per pass and before a
single row is read**, so a refused pass is inert rather than half-done. It throws
rather than returning a count, because a refusal counter would be a number with no
reachable producer while the fake is the only registered provider.

**The gate has had an enforcer rather than only a paragraph since slice 5.** `carriesRealMoney` on `packages/payments/src/provider-registry.ts` is
the third flag of its kind, beside `carriesRealCredentials` for channel tokens and
`carriesRealPii` for identity documents. `apps/api/src/lib/engagements.ts` refuses
on it **before any rpc**, so the first person to register Stripe hits a failing
write rather than a paragraph they did not read, and clearing this gate is what
makes flipping the flag a reviewed act. Like its two siblings it **raises on an
unregistered provider rather than answering `false`**: "a provider we have never
heard of certainly moves no money" is the exact inversion that would let an
unreviewed integration through.

## Key entities

| Entity                       | Status                                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow_holds`               | ✅ live `20260904121000`, written by `accept_offer` and the reconcile sweep                                                                                    |
| `ledger_entries`             | ✅ live `20260904122000`, written by the same two                                                                                                              |
| `payouts`                    | ✅ live `20260907121000`, written by the payout sweep and `settle_payout`                                                                                      |
| `disputes`                   | ✅ live `20260908122000`. No state column (ADR-0016); open is derived as `resolved_at is null`                                                                 |
| `ops_actions`                | ✅ live `20260908123000`. Every resolution writes one in the same transaction as the money, with a required actor and a required reason                        |
| `subscriptions` / `invoices` | ⏳ no slice. Nothing bills anybody yet                                                                                                                         |
| `platform_fees`              | ⏳ no slice. `payouts.platform_fee` is a column written from a constant `0` ([ADR-0024](../40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md)) |

`escrow_holds` and double-entry `ledger_entries` landed in **slice 5 of the
marketplace sequence** ([human-nodes-marketplace.md](human-nodes-marketplace.md)),
because that is the first slice that can reach `CLAIMED` — and `claimed →
escrow_funded` is the state machine's only exit from `claimed`, so shipping
acceptance without funding would reproduce the seventeen-permanently-stuck-steps
defect (`20260827120000`) deliberately. Accept and fund are inseparable because
the machine says so, and they happen in one transaction for that reason.

**They landed modelling the hold and moving no money.** The hold is recorded
against the already-authorised `projects.budget_ceiling` — the same number
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md) already guards with a
readable check in the route and a second one in SQL under a row lock — and the
only registered payment provider is a deterministic in-repo fake, following
`packages/marketing`'s adapter registry. **Nothing is charged and nothing is
transferred.** The counsel gate above is unmoved by any of it, and
`20260904121000`'s header says so at length rather than leaving a reader to infer
it.

**Multi-node splits are deferred with a trigger, and the index that forbids them
now exists.** This doc says one charge can fund several transfers. Under
[ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md) that needs
several live engagements on one task, which `engagements_one_live_idx` (a partial
unique on `where ended_at is null`) forbids. **Trigger:** the first plan step
whose acceptance criteria name more than one node. At that point the index is what
changes, and nothing else needs to.

**One more limit sits beside it and is not the same one.** `room_members` is keyed
on `(room_id, user_id)`
([ADR-0017](../40-adr/0017-thread-admission-is-a-property-of-the-membership.md)),
so one person holds one thread per room and therefore works one step of a project
at a time. That is a chat-admission ceiling rather than a money one, and lifting
it is a change to that ADR rather than to this index.
