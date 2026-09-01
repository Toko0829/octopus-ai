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

| From   | To         | Made by                                                             |
| ------ | ---------- | ------------------------------------------------------------------- |
| `held` | `refunded` | `apps/api/src/lib/escrow-reconcile.ts`, on the ticker               |
| `held` | `released` | **nobody yet.** The payout slice, and the map refuses it until then |

**`released` is in the check constraint and out of the map**, and the pairing is
deliberate rather than an oversight to tidy: the constraint is the column's
vocabulary and the map is the set of moves something can make today. Permitting an
arc with no producer is the `task_deps` defect this repository has recorded five
times. `marketplace_engagements.sql` pins the refusal **descriptively**, as what
it is rather than as a promise about a later slice.

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
a migration per account is a migration per bookkeeping decision. Two accounts
exist, `owner_funds` and `escrow`.

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

**The gate is unmoved by slice 5, and it now has an enforcer rather than only a
paragraph.** `carriesRealMoney` on `packages/payments/src/provider-registry.ts` is
the third flag of its kind, beside `carriesRealCredentials` for channel tokens and
`carriesRealPii` for identity documents. `apps/api/src/lib/engagements.ts` refuses
on it **before any rpc**, so the first person to register Stripe hits a failing
write rather than a paragraph they did not read, and clearing this gate is what
makes flipping the flag a reviewed act. Like its two siblings it **raises on an
unregistered provider rather than answering `false`**: "a provider we have never
heard of certainly moves no money" is the exact inversion that would let an
unreviewed integration through.

## Key entities

| Entity                       | Status                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `escrow_holds`               | ✅ live `20260904121000`, written by `accept_offer` and the reconcile sweep |
| `ledger_entries`             | ✅ live `20260904122000`, written by the same two                           |
| `payouts` / `transfers`      | ⏳ slice 7 of the marketplace sequence, with `held → released`              |
| `disputes`                   | ⏳ slice 8, with the ops path                                               |
| `subscriptions` / `invoices` | ⏳ no slice. Nothing bills anybody yet                                      |
| `platform_fees`              | ⏳ with the first transfer, since a fee is deducted from one                |

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
