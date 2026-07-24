# Module: Human Nodes Marketplace

> Owns the human workforce: node onboarding + KYC, the skill/trust graph, skill-based ranked matching, offers with expiry/cascade, the full engagement lifecycle (accept → escrow → chat → proof → approval → payout → rating), and anti-fraud. It **completes the agent's waitpoint** on verified task completion.
>
> **Owner paths:** `apps/matcher/**` · **Depends on:** auth-identity (node role, RLS), payments-billing (escrow, payouts), chat-discord (per-task thread membership), notifications (offer fan-out, expiry cascade), ai-orchestrator (`request_human_node`, waitpoint completion), integrations (KYC/IDV).
>
> Update on any change to onboarding/KYC, matching, the offer flow, the engagement state model, or anti-fraud.

## Node onboarding & KYC

- Identity verification via **Persona** (or Stripe Identity to stay in-stack): document + **passive liveness** + **Face Match 1:1** + **Face Search 1:N** across enrolled nodes to kill account-renting / duplicate-identity fraud (the defining gig-fraud vector).
- Collect jurisdiction, languages, and professional licenses (lawyer/accountant/notary — **verified, not self-attested**).
- Set up the **Stripe Connect Express** connected account (payout rails + tax onboarding handled by the provider).

## Skill & trust graph

- Structured skill taxonomy (`legal-filing:US-TX`, `notary:US-TX`, `real-estate:Austin`, `food-safety-consulting`, `procurement`, `on-site-inspection`), service geo (PostGIS), availability, rate, languages, rating.
- Trust score seeds from KYC + verified credentials and grows with completed jobs/ratings.
- License claims are **hard filters** for regulated tasks, not ranking weights.

## Matching algorithm

**Skill-based ranked matching, not a blind broadcast.** Eligible pool = verified skills cover `required_skills` **AND** service geo/jurisdiction includes the task location **AND** any required license is verified **AND** rate ≤ escrowed task budget **AND** currently available. Rank by weighted score: skill/credential fit, jurisdiction exactness (Austin-local > Texas-state), rating + completion-rate, price, responsiveness, current workload (load-balancing). Offer strategy is task-dependent: **first-accept-wins + cascade** for time-sensitive/commodity tasks; a **short sealed-bid window** for higher-value/negotiable-scope tasks.

## Offer flow

Top-ranked nodes get a push/email/in-app **offer** (scope, `acceptance_criteria`, escrowed price, deadline, expiry) via [notifications](notifications.md). Expired/declined offers **auto-cascade** to the next candidate. No task stalls on a silent node.

## Engagement lifecycle & state

`CLAIMED → ESCROW_FUNDED → IN_PROGRESS → PROOF_SUBMITTED → IN_REVIEW → APPROVED → PAID` (with `REJECTED → IN_PROGRESS` bounded re-do, and `DISPUTED` → ops).

1. **Accept + escrow fund** — escrow confirmed funded (charge already captured from the user's authorized budget; transfer deferred). Node e-signs a per-task engagement + NDA. A signal moves the task to `IN_PROGRESS`.
2. **Join group chat** — node added to the project's channel/thread with a distinct **Human Node** role/badge, **scoped to this task's thread** and **time-boxed** (`room_members.scope`, `expires_at`).
3. **Do the work** — the AI co-pilots in-thread (prepared docs, RAG-grounded checklists, forms, addresses, talking points); the user answers questions; presence/typing show live activity. All coordination stays in-thread for auditability.
4. **Submit proof** — deliverables to Supabase Storage (signed docs, stamped permits, geotagged/timestamped site photos, receipts, filing confirmation numbers), attached as artifacts.
5. **Approval (maker-checker + human)** — AI critic validates proof against `acceptance_criteria` (authenticity, tampering/liveness, correct reference numbers) → the user (and/or AI for low-risk) gives final approval. Rejections return to `IN_PROGRESS` with structured feedback + a re-do window.
6. **Payout** — on approval, escrow releases: Stripe Connect transfer to the node's connected account, platform fee retained (see [payments-billing.md](payments-billing.md)). Instant payout to debit card optional for eligible nodes.
7. **Rating + dispute** — two-sided rating updates the trust graph; disputes freeze the transfer and route to ops with the full audit trail (release / partial / refund / reassign). Repeat low ratings / fraud flags suspend the node.
8. **Offboard from chat** — on task close, the node's thread access is revoked/archived; deliverables + transcript remain on the project record.

## Waitpoint completion

On approval, the marketplace/Fastify **completes the agent's Trigger.dev waitpoint token**, and the durable run **resumes deterministically** at the suspended step ([ai-orchestrator.md](ai-orchestrator.md)).

## Anti-fraud

Account-renting / synthetic identity (Face Search 1:N dedup) · geo/IP consistency (impossible-location flags) · collusion / fake proof (proof authenticity + EXIF/geo/timestamp checks) · cold-start (provisional trust score → lower-risk tasks with heavier proof review until a track record accrues).

## Two-sided liquidity

Cold-start supply: KYC + verified credential grants provisional eligibility. Thin skill markets fall back to vetted local professional partners. Certification tiers and node acquisition tracked in [roadmap.md](../10-architecture/roadmap.md) (Phase 4).

## Key entities

`node_profiles` (kyc_status, trust_score, service_geo, rate, availability) · `node_skills` / `credentials` (verified) · `offers` (status, expiry) · `engagements` · `proof_artifacts` · `ratings` · `disputes`.
