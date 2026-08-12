# Roadmap

> The phased build plan from MVP to production, sequenced around the **marketing wedge** (full-funnel digital marketing for solo founders/creators) and the **data flywheel**, on the way to the north-star "run any business" platform. Update when phase scope or exit gates change.

## Guiding principles

- **Wedge first, then expand.** Nail full-funnel marketing for creators before adding verticals. Depth over breadth.
- **The flywheel is the product.** Every phase must increase outcome-labeled data and reduce the human-correction rate. See [learning-flywheel.md](learning-flywheel.md).
- **Start managed, self-host deliberately.** Managed Supabase + Trigger.dev first.
- **Compliance is first-class** — ad-policy/brand-safety and spend guardrails exist from the first launch; money-services licensing clears before payouts.
- **Docs land with the code** in every phase (this doc set is Phase 0's deliverable).

## Phase 0 — Foundations

**Goal:** a production-grade skeleton everything builds on.

- Turborepo monorepo (`apps/web|api|matcher|agent`, `packages/db|contracts|core|rag|agent-tools|realtime|ui|observability|config`).
- Provision Supabase (Postgres 16, RLS, GoTrue JWKS, Storage, Realtime); Supavisor pooling.
- `auth-identity`: sessions, JWKS verification, role model, baseline RLS + pgTAP.
- CI/CD (GitHub Actions + Turborepo cache), migrations, secrets, Zod env validation.
- Observability skeleton (OTel, Sentry, LLM-trace sink) + `.docmeta.yml` doc-drift check.
- **Author the full documentation set (this deliverable).**

**Exit gate:** auth end-to-end, RLS tests pass, CI enforces doc-drift, traces flow.

## Phase 1 — Full-funnel Planner MVP (marketing, read-only)

**Goal:** a creator gets a real, grounded, full-funnel growth plan in chat — no execution yet.

- ✅ Discord-style chat shell (5 regions, roles/badges, presence, inline messages) on Supabase Realtime.
- 🟡 `rag-knowledge` for **marketing**: pgvector schema, hybrid retrieval + RRF + rerank **done**; ten-document corpus covering all six funnel stages; **retrieval eval gate live** (golden set, positives + negatives, wired into CI). Ingestion is still from a hand-authored corpus rather than crawled sources, and the **generation** eval (Ragas/DeepEval faithfulness) is deliberately absent.
- ✅ Orchestrator **planning pass**: a creator goal returns a **structured full-funnel plan** on a plan card, cited per step, and refuses when nothing clears the relevance threshold.
- ✅ AI participates **inline**; **no side effects** (no publishing, no spend).
- ✅ `design-system-frontend` tokens + core components (editorial house style, no slop).
- ✅ **Flywheel v0:** approve / request-changes on a plan is captured in `feedback_events` as the first labelled data.

**Exit gate:** a creator gets a correct, tailored full-funnel plan; eval gates pass; design review passes the anti-slop checklist.

> **Gate status: substantially met, with two named remainders.** A creator goal now produces a structured six-stage plan with per-step citations and owners, rendered as a card the owner can approve or send back; the retrieval eval gate runs in CI at recall 1.00 with zero negative leaks; the flywheel records its first labels.
>
> Outstanding, and deliberately not claimed as done:
>
> - **The generation eval** (faithfulness, answer relevancy) needs an LLM judge, which bills per run and is non-deterministic, so it belongs in a credentialed pass rather than a deterministic gate. Retrieval is gated; generation is not.
> - **A formal anti-slop design review** has not been run against the checklist in [design-system.md](../20-design/design-system.md).
>
> Also worth carrying into Phase 2 rather than pretending it is finished: the corpus is internally authored, so nothing is externally cited yet, and **no pgTAP RLS tests exist** despite rule 18 naming dynamic group-chat membership the hardest security surface. That debt gets sharply more expensive the moment human nodes join rooms.

## Phase 2 — Execution + Channels + Creative + Marketplace + Escrow

**Goal:** Octopus actually _does_ the marketing, humans plug in, and it goes live.

- Durable orchestration with human-in-the-loop waitpoints; idempotent/replay-safe steps; pg-boss utility jobs.
- `business-projects-workflow`: task state machine, scheduler, router (AI/HUMAN/USER), replan-by-diff, maker-checker.
- `marketing-growth-engine`: **channel integrations** (paid ads incl. Meta/Google, social publishing, email, analytics) + **creative generation** (image/video/copy) as typed tools, all behind approval + spend guardrails.
- `human-nodes-marketplace`: expert-marketer onboarding + KYC, skill/trust graph (creative, ads, SEO, video, outreach), ranked matching, offers with expiry/cascade.
- `payments-billing`: escrow-equivalent holds, Connect Express payouts, double-entry ledger, spend caps in tool code; managed-ad-spend accounting.
- Node join-per-task threads (RLS least-privilege), proof/approval, payout → resume → **campaigns launch** within spend caps.
- **Auto-optimize loop v1:** pull live metrics, pause/scale within guardrails; write outcomes to the flywheel.

**Exit gate:** the full 10-step core loop runs end-to-end — plan → approve → (human node) → launch → measure → optimize — for a real creator with a real (test-mode) budget and a paid node.

## Phase 3 — Production Hardening + Flywheel v1

**Goal:** safe, observable, and measurably self-improving.

- Compliance: KYC/AML + sanctions/PEP; ToS + disclaimers + node engagement/NDA; **clear money-transmission / escrow-licensing with counsel**; ad-policy + FTC-disclosure + GDPR/privacy guardrails hardened.
- Full guardrail stack (layered defense, injection quarantine, brand-safety, spend caps, kill switch); exhaustive RLS/pgTAP on dynamic group chats.
- `admin-ops` consoles (disputes, moderation, node/payment ops, audit-trail explorer) + dispute workflows.
- **Learning flywheel v1:** outcome ingestion pipeline, human-correction capture as labeled data, correction-rate + retrieval-of-real-outcomes dashboards ([analytics.md](../30-modules/analytics.md), [learning-flywheel.md](learning-flywheel.md)).
- Production observability & SLOs; alerting on stale sources / eval regressions / cost & spend runaway.
- Reliability: node no-show / waitpoint-expiry / reassignment; ad-policy-rejection handling; message ordering/dedupe/catch-up; load testing toward the Realtime ceiling.
- **Monetization v1:** execution subscription + managed-spend/performance fee + marketplace take-rate.

**Exit gate:** real creators paying, real paid nodes, measurable growth outcomes delivered, correction-rate trending **down**, green SLOs.

## Phase 4 — Fine-tune + Expand Verticals

**Goal:** compound the moat and widen the beachhead.

- **Fine-tune a proprietary model** on the accumulated outcome + correction dataset once volume justifies it (deferred until Phase 3 data exists).
- Widen ICP: creators → SMB local marketing → e-commerce/DTC growth (new capability modules + market packs, mostly RAG + connectors).
- Expansion monetization (benchmarks-as-a-product, premium/expedited matching, enterprise/white-label).
- Scaling escape hatches **as triggered**: Fastify uWebSockets WS gateway + Redis past ~500 concurrent; self-host durable orchestration; Temporal / dedicated vector DB only if forced.
- Mobile "Warm Concierge" surface for on-the-go nodes.

## Phase 5 — Toward the north star ("run any business")

**Goal:** graduate from growth-operator to full business-operator.

- Add the **business-formation / operations** verticals (the original cafe playbook: entity, permits, banking, hiring) as new archetypes + jurisdiction packs — reusing the same orchestrator, marketplace, chat, payments, and flywheel.
- Ongoing-ops SaaS (compliance monitoring, bookkeeping) layered on top of marketing.

## Cross-phase compliance milestones

| Milestone                                              | Must clear before                         |
| ------------------------------------------------------ | ----------------------------------------- |
| Ad-policy / brand-safety / FTC-disclosure guardrails   | first campaign goes live (Phase 2)        |
| Spend caps enforced in tool code                       | any real ad spend (Phase 2)               |
| KYC/AML + sanctions screening                          | any node payout (Phase 2 → 3)             |
| Money-transmission / escrow-licensing counsel sign-off | real (non-test) money movement            |
| GDPR/privacy + data-use consent (for flywheel)         | using customer data to improve the system |
| ToS + NDA/engagement templates                         | onboarding real nodes                     |

## Deferred-by-design (with triggers)

| Deferral                             | Trigger to build                                     |
| ------------------------------------ | ---------------------------------------------------- |
| Fine-tuned proprietary model         | enough Phase-3 outcome/correction data               |
| Fastify WS gateway + Redis           | past ~500 concurrent / server-authoritative ordering |
| Self-hosted / Temporal orchestration | Trigger.dev cost/limits outgrown                     |
| Dedicated vector DB / pgvectorscale  | tens of millions of chunks or high QPS               |
| Business-formation verticals         | marketing wedge is working + flywheel spinning       |

## Definition of "production-ready" (exit gate, every phase)

Durable under crashes/deploys · idempotent side effects (incl. no double-publish/double-spend) · RLS-tested isolation · typed end-to-end · observable (traces + LLM cost/eval + spend) · guardrailed (injection + overspend + brand-safety) · accessible · **documented in lockstep** · **contributing to the flywheel.**
