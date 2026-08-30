# Module: Payments, Escrow & Billing

> Owns all money movement: user subscription/budget pre-authorization, escrow-equivalent holds via **separate charges & transfers**, verified-completion payouts to nodes' connected accounts, an immutable **double-entry ledger**, platform fees, and dispute-driven fund handling. **Strict idempotency and event-sourcing throughout.**
>
> **Owner paths:** payments code in `apps/api/**` + `packages/core/**` (ledger), Stripe webhooks in `apps/api/**` · **Depends on:** human-nodes-marketplace (task/engagement pricing, approval trigger), auth-identity (role-gated approvals), integrations (Stripe Connect), admin-ops (dispute console), business-projects-workflow (project budget ceiling).
>
> Update on any change to the money flow, ledger, escrow model, or the regulatory posture. Money-related schema also updates [data-model.md](../10-architecture/data-model.md); posture changes update [security-compliance.md](../10-architecture/security-compliance.md).

## Escrow-equivalent model

Stripe is **not** a licensed escrow provider. The sanctioned pattern is **separate charges & transfers**: capture the customer charge on the **platform** account, **hold** the funds, then **transfer** to the node's connected account only after approval — using delayed payouts for escrow-style timing.

## Money flow

1. **Budget pre-auth** — user authorizes a project budget ceiling up front (a guardrail; escrow can never exceed it).
2. **Hold on accept** — when a node accepts an offer, the platform captures/holds the task price (charge on platform account). Funds are in escrow; **no transfer yet**.
3. **Approve** — node completes → proof approved by AI critic + user.
4. **Transfer** — approval triggers a **Transfer** to the node's Stripe Connect **Express** connected account, **minus the platform fee** (application fee).
5. **Payout** — to the node's bank/debit; **Instant Payout** to debit card optional for eligible nodes.
6. **Dispute** — freezes the transfer; ops can release, partially release, or refund-to-user from the held balance.

## Node payout onboarding

Connect **Express** so Stripe handles the node's KYC/tax (1099-K / DAC7 / local equivalents) and payout compliance. Instant-payout eligibility per Stripe rules.

## Double-entry ledger

Every movement writes balanced `ledger_entries` (debit/credit) — **append-only, immutable**. The ledger is the source of truth for reconciliation, not Stripe alone.

## Subscriptions & fees

Execution subscription tiers · milestone success fees · marketplace take-rate (~15–25%) · disclosed referral fees. See [vision.md](../00-overview/vision.md) for the full model.

## Spend governance

Per-task and per-project **ceilings enforced in tool code** (not prompts). Any tool call or offer that would breach the cap is blocked and escalated. A jailbroken prompt cannot overspend.

## Dispute handling

Freeze transfer → ops review with full audit trail → outcome: release / partial release / refund-to-user / reassignment. Driven from [admin-ops.md](admin-ops.md).

## Idempotency & event-sourcing

Every money movement carries an `idempotency_key` (unique DB constraint + durable activity) so retries after a crash never double-charge or double-pay. Every movement emits an immutable event.

## Multi-node task splits

One charge can fund **multiple transfers** (a task completed by several nodes) — each transfer idempotent and ledgered.

## Regulatory posture (counsel gate)

Holding escrow + routing payouts is likely **money-services activity**. **Before real (non-test) money moves**, clear with counsel: money-transmission / escrow-licensing per jurisdiction (US state MTL regime; EU e-money/payment-institution rules; GEL/FX for the future Georgia pack); platform-of-record determination; tax reporting. Do **not** hand-wave — see [security-compliance.md](../10-architecture/security-compliance.md).

## Key entities

`escrow_holds` · `ledger_entries` (double-entry) · `payouts` / `transfers` · `subscriptions` · `invoices` · `platform_fees` · `disputes`.

**None of them exist yet, and the schedule is now fixed rather than open.**
`escrow_holds` and double-entry `ledger_entries` land in **slice 5 of the
marketplace sequence** ([human-nodes-marketplace.md](human-nodes-marketplace.md)),
because that is the first slice that can reach `CLAIMED` — and `claimed →
escrow_funded` is the state machine's only exit from `claimed`, so shipping
acceptance without funding would reproduce the seventeen-permanently-stuck-steps
defect (`20260827120000`) deliberately. Accept and fund are inseparable because
the machine says so.

**They land modelling the hold and moving no money.** The hold is recorded
against the already-authorised `projects.budget_ceiling` — the same number
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md) already guards with a
readable check in the route and a second one in SQL under a row lock — and the
only registered payment provider is a deterministic in-repo fake, following
`packages/marketing`'s adapter registry. **Nothing is charged and nothing is
transferred.** The counsel gate below is unmoved by any of it: modelling an
obligation is not money movement, and the migration will say so in its header
rather than leaving a reader to infer it.

**Multi-node splits are deferred with a trigger.** This doc says one charge can
fund several transfers. Under
[ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md) that needs
several live engagements on one task, which the `engagements` partial unique
index forbids. **Trigger:** the first plan step whose acceptance criteria name
more than one node. At that point the index is what changes.
