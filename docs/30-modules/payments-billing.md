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
