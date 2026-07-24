# Module: Admin & Ops

> Owns the internal operations surfaces: dispute resolution, content/proof moderation, node/payment/task-queue consoles, and the audit-trail explorer. **Dense, data-first tools built with real craft above the utilitarian baseline.**
>
> **Owner paths:** admin UI in `apps/web/**` (ops routes) + ops actions in `apps/api/**` · **Depends on:** all domain modules (read/act across projects, tasks, nodes, payments, chat), auth-identity (admin/ops RBAC), analytics (metrics), payments-billing (dispute actions).
>
> Update on any change to ops workflows, RBAC, or the consoles.

## Responsibilities

Keep the marketplace and platform healthy and disputable: resolve disputes, moderate proof, review node verification, reconcile payments, unstick stalled runs, triage stale RAG sources — all **audited, least-privilege**.

## Consoles

- **Dispute resolution** — freeze / release / partial / refund / reassign, with the full event-sourced audit trail. Drives [payments-billing.md](payments-billing.md) fund actions.
- **Moderation** — review node-submitted proof and flagged content (authenticity, tampering, policy).
- **Node ops** — verification review, suspension, trust-score overrides.
- **Payments / ledger ops** — reconciliation (ledger vs Stripe), payout inspection.
- **Task-queue / stuck-run ops** — waitpoint expiry, node no-show, SLA breach; re-dispatch or reassign.
- **RAG source ops** — stale-source review, parse-failure triage, re-verification routing (to a human node).
- **Audit-trail explorer** — event-sourced timeline per project/run (the human-facing view of `events`).

## RBAC & least privilege

`admin` and `ops` roles with scoped permissions; every ops action is written to `ops_actions` (audited). No destructive action without a trail. Ops access to a project chat is audited and scoped.

## Design guidance

Dense, keyboard-first tools — **Retool as the density reference, but higher craft** (the Dark Command Deck skin, hairline borders, tabular numerics, conditional status color paired with text). See [design-system.md](../20-design/design-system.md).

## Key entities

`disputes` · `moderation_flags` · `ops_actions` (audited) · `reconciliation_runs` · `admin_roles`.
