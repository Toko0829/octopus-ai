# Roadmap

> The phased build plan from MVP to production, sequenced around the **marketing wedge** (full-funnel digital marketing for solo founders/creators) and the **data flywheel**, on the way to the north-star "run any business" platform. Update when phase scope or exit gates change.

## Guiding principles

- **Wedge first, then expand.** Nail full-funnel marketing for creators before adding verticals. Depth over breadth.
- **The flywheel is the product.** Every phase must increase outcome-labeled data and reduce the human-correction rate. See [learning-flywheel.md](learning-flywheel.md).
- **Start managed, self-host deliberately.** Managed Supabase first. Durable orchestration went the other way and stayed on our own Postgres ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)), because the managed option was blocked on credentials for the length of the project while two unrelated decisions removed the problem it solved.
- **Compliance is first-class** — ad-policy/brand-safety and spend guardrails exist from the first launch; money-services licensing clears before payouts.
- **Docs land with the code** in every phase (this doc set is Phase 0's deliverable).

## Phase 0 — Foundations

**Goal:** a production-grade skeleton everything builds on.

- Turborepo monorepo (`apps/web|api|matcher|agent`, `packages/db|contracts|core|rag|agent-tools|realtime|ui|observability|config`).
- Provision Supabase (Postgres 17, RLS, GoTrue JWKS, Storage, Realtime); Supavisor pooling.
- `auth-identity`: sessions, JWKS verification, role model, baseline RLS + pgTAP.
- CI/CD (GitHub Actions + Turborepo cache), migrations, secrets, Zod env validation.
- Observability skeleton (OTel, Sentry, LLM-trace sink) + `.docmeta.yml` doc-drift check.
- **Author the full documentation set (this deliverable).**

**Exit gate:** auth end-to-end, RLS tests pass, CI enforces doc-drift, traces flow.

## Phase 1 — Full-funnel Planner MVP (marketing, read-only)

**Goal:** a creator gets a real, grounded, full-funnel growth plan in chat — no execution yet.

- ✅ Discord-style chat shell (5 regions, roles/badges, presence, inline messages) on Supabase Realtime.
- 🟡 `rag-knowledge` for **marketing**: pgvector schema, hybrid retrieval + RRF + rerank **done**, with embedding and rerank both running **in-process** so retrieval depends on no paid provider ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md), [ADR-0009](../40-adr/0009-local-reranker.md)); thirteen-document corpus genuinely covering all six funnel stages, measurement included; **retrieval eval gate live** (golden set, positives + negatives, wired into CI, running the production reranker). Ingestion is a hand-authored corpus **plus four crawled sources**, and the **generation** eval (Ragas/DeepEval faithfulness) is deliberately absent.
- ✅ Orchestrator **planning pass**: a creator goal returns a **structured full-funnel plan** on a plan card, cited per step, and refuses when nothing clears the relevance threshold **or when what did clear it does not answer the goal** (the groundedness gate, rule 10).
- ✅ AI participates **inline**; **no side effects** (no publishing, no spend).
- ✅ `design-system-frontend` tokens + core components (editorial house style, no slop).
- ✅ **Flywheel v0:** approve / request-changes on a plan is captured in `feedback_events` as the first labelled data.

**Exit gate:** a creator gets a correct, tailored full-funnel plan; eval gates pass; design review passes the anti-slop checklist.

> **Gate status: substantially met, with two named remainders.** A creator goal now produces a structured six-stage plan with per-step citations and owners, rendered as a card the owner can approve or send back; the retrieval eval gate runs in CI at recall 1.00 with zero negative leaks; the flywheel records its first labels.
>
> Outstanding, and deliberately not claimed as done:
>
> - **The generation eval** (faithfulness, answer relevancy) needs an LLM judge, which bills per run and is non-deterministic, so it belongs in a credentialed pass rather than a deterministic gate. Retrieval is gated; generation is not.
> - ~~A formal anti-slop design review~~ — **run.** Two anti-pattern violations found and fixed (a `✦` sparkle glyph decorating the landing eyebrow, and `--role-pro`, the only violet in the repository, declared three times and used nowhere), plus four accessibility failures the checklist implies but nobody had measured: three text tokens under AA, two of them on the light skin, and `--on-accent` white failing on every primary button at 2.07 in dark. Contrast now verified for every rendered text node on `/` and `/sign-in` in both skins, zero failures. **Scope limit stated rather than glossed:** `/app` needs an authenticated session and was not covered, so the chat shell, plan card and ⌘K palette are unreviewed at element level. See [design-system-frontend.md](../30-modules/design-system-frontend.md).
>
> Also worth carrying into Phase 2 rather than pretending it is finished:
>
> - ~~The corpus is internally authored, so nothing is externally cited yet.~~ **Closed.** A source registry, a guarded fetcher, page-hash change detection and a cadence re-crawl sweep put four externally-sourced documents beside the ten internal ones, each with a publisher, a URL and the date it was read. Recorded rather than glossed: three of the nine pages first registered answered `200` and stored site navigation rather than guidance, so the registry is hand-verified by reading what each entry stored, and two source families (US disclosure guidance, the EU) remain uncovered for reasons named in [rag-knowledge.md](../30-modules/rag-knowledge.md).
> - The golden set is **15 cases**, which is small enough that its derived metrics (coverage, MRR) are indicative rather than precise, and whose four negatives are all business-formation topics far from the corpus in vocabulary. The retrieval threshold's safety margin is defended by those negatives, so growing them is a security task rather than a coverage one ([rag-knowledge.md](../30-modules/rag-knowledge.md), [ADR-0009](../40-adr/0009-local-reranker.md)).
> - Plan latency now scales with the cores the AI service is given, since reranking runs in-process. Sizing that instance is a Phase 2 deployment decision, not an open question about whether it works.
>
> **Closed since this was written:** pgTAP RLS coverage now exists (`supabase/tests/rls_membership.sql`, 22 assertions, including that an expired node sees nothing at all), so rule 18's zero-coverage debt is paid for room-scoped membership. Thread-scoped membership is covered now (`thread_scope.sql`, 46 assertions) and so are the marketplace's first writers (`node_onboarding.sql`, 36). Ops/admin paths remain uncovered, and have no code to cover.
>
> **Also closed, and it was the one item blocking Phase 2:** the **groundedness gate**. `rag-knowledge.md` recorded, as measured rather than suspected, that the rerank threshold ranks chunks within the corpus and cannot decide whether the corpus covers a question, so an in-vocabulary but uncovered goal cleared it on both providers by up to 12x. While Phase 1 is read-only that produces a bad answer; the moment a plan can spend money or publish, it produces a bad action. A cheap-tier check now sits between retrieval and generation, fails closed, and refuses with a reason distinct from "nothing retrieved". Its own set (`scope_negatives`) is scored by `--gate`, which is a credentialed pass rather than a CI gate, and which scores the false-refusal rate alongside the block rate so a gate cannot pass by refusing everything. **Measured 1.00 / 1.00** after a first run that scored 1.00 / 0.64 and refused the north-star goal, which is exactly what the two-sided measurement exists to catch.

## Phase 2 — Execution + Channels + Creative + Marketplace + Escrow

**Goal:** Octopus actually _does_ the marketing, humans plug in, and it goes live.

- Durable orchestration with human-in-the-loop waitpoints; idempotent/replay-safe steps; pg-boss utility jobs.
- 🟡 `business-projects-workflow`: task state machine, scheduler, router (AI/HUMAN/USER), replan-by-diff, maker-checker. **Schema and guards are live** (`20260813120000`): `projects` / `tasks` / `task_deps` / `task_runs` / `events`, with the state machine and the DAG's acyclicity enforced by trigger rather than by the runner. Sequenced first on purpose, because both candidate durable runners drive this structure and neither defines it. **The scheduler, the router, the executor, the ticker and the plan-card materialiser are all live too**, and this sentence used to say they were still to build, which had been false since `20260813150000` and `20260828120000`. **The DAG is now visible to the person it belongs to** (`blockedBy` on `Task`): a step waiting on another said "Not started" until this slice, indistinguishable from a step merely next in the queue, and twelve of fifteen steps on a live project read that way. **And every arm of the state machine now ends somewhere terminal** — `executeTask` and the owner-answer paths walk `approved → done`, which the payout slice had named as this module's to produce, since an `approved` step is non-terminal and a replan could cancel work that had already passed its check. Neither needed a migration; both arcs were declared and unwalked. Still to build: `playbook_versions`, `escalations`, and a ticker sweep to heal a step stranded at `approved` by a crash between the two writes.
- `marketing-growth-engine`: **channel integrations** (paid ads incl. Meta/Google, social publishing, email, analytics) + **creative generation** (image/video/copy) as typed tools, all behind approval + spend guardrails.
- 🟡 `human-nodes-marketplace`: expert-marketer onboarding + KYC, skill/trust graph (creative, ads, SEO, video, outreach), ranked matching, offers with expiry/cascade. **The domain, threads, onboarding and the matcher are live** (`20260831120000`…`123000`, `20260901120000`…`123000`, `20260902120000`…`122000`, `20260903120000`…`121000`): a node exists, has a profile, claims skills and licences, passes an identity check through an in-repo fake verifier, **and can now be offered work**. An owner sends an escalated step to the marketplace from the project panel, the ticker offers it to one ranked node at a time, and a decline or a 48-hour expiry cascades to the next. **Ops-invited rather than self-service**, structurally — `invite_node` is granted to `service_role` alone and its only caller is `scripts/invite-node.mjs` — and that stays true after slice 4: the cold-start dead end was a verified node with nothing to do, which the matcher fixes directly, while open registration would put strangers in a KYC funnel with no ops console to vet them until Phase 3. **A node can now accept, do the work, hand it over and have it approved** (`20260904120000`…`127000`, `20260906120000`…`124000`): acceptance and escrow are one transaction, the node starts the step and submits proof with files, and the owner approves it or sends it back from the project panel. A step somebody took and abandoned goes back to the market on a deadline, with the escrow refunded ([ADR-0023](../40-adr/0023-a-breached-deadline-reassigns.md)). **A payout is slice 7** (`20260907120000`…`123000`): approving the work is the authorisation, the ticker's payout sweep transfers through the in-repo fake, and `public.settle_payout` releases the escrow, ends the deal as `completed` and walks the step to `done` — which nothing in this schema had ever produced. **Disputes, ratings and the first ops console are slice 8** (`20260908120000`…`128000`), and with them the domain has no dead ends left: all four `→ disputed` arcs are restored together, `disputed → matching` is added, and `/ops` is the surface that can move a task out of `disputed` ([ADR-0026](../40-adr/0026-the-dispute-exit-map.md)). Both parties can raise — the node's arc from `rejected` is the only act in this system a node performs against the owner. A partial settlement is a full refund plus a new hold released in the same transaction ([ADR-0025](../40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md)), because both escrow settlements are terminal and neither reaches the other. `trust_score` has its first writer and is `avg(score)/5` over ratings received, deliberately nothing else. **Node suspension is not built**, and the reason is this slice's own argument one table over: it would be a terminal state with no exit until a moderation console exists. **The take rate is not deducted** ([ADR-0024](../40-adr/0024-the-take-rate-is-not-deducted-from-an-agreed-price.md)): escrow holds the price the offer showed the node, so a fee has to be named on the offer before it can come out of a payout. Five arc bookings across slices 4 to 6 were deliberately not restored, each with an ADR ([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md), [ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md), [ADR-0022](../40-adr/0022-proof-is-an-artifact.md)).
- 🟡 `payments-billing`: escrow-equivalent holds, Connect Express payouts, double-entry ledger, spend caps in tool code; managed-ad-spend accounting. **Holds, the ledger and payouts are live** (`20260904121000`, `20260904122000`, `20260907121000`) and **no money moves**: the only registered payment provider is a deterministic in-repo fake, `carriesRealMoney` refuses a real one at both writers, and the counsel gate below is unmoved. Connect Express onboarding, subscriptions and invoices are unbuilt.
- ✅ Node join-per-task threads (RLS least-privilege), proof/approval, payout → resume → **campaigns launch** within spend caps. The chain runs end to end against the fake provider: an escalated step reaches a ranked node, they accept into escrow, do the work in a thread, hand it over, the owner approves, and the next ticker pass pays them and finishes the step.
- 🟡 `notifications`: **in-app is live** (`20260909120000`…`122000`). Eleven marketplace moments derive an inbox row for the person they concern, from a trigger on `public.events` rather than from calls beside each act, because six of them are written by SQL functions no Node-side helper reaches ([ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md)). A per-user Realtime topic moves the count without a reload, in the room and on `/node`. That closes the line every marketplace slice from 4 to 8 ended on. **Web push, email and SMS are unbuilt**, each needing a paid provider, and so are preferences, digests and `delivery_log`. The 48-hour offer window and seven-day work deadline are **unblocked but unchanged**: shortening them is its own decision.
- 🟡 **Auto-optimize loop v1:** pull live metrics, pause/scale within guardrails; write outcomes to the flywheel. **The pause half is live** ([ADR-0014](../40-adr/0014-cpa-ceiling-authorises-auto-pause.md)): metrics are pulled, a CPA ceiling breach pauses the campaign, the decision is logged with its arithmetic, and the owner can resume from the panel. Scale/reallocate are not built.

**Exit gate:** the full 10-step core loop runs end-to-end — plan → approve → (human node) → launch → measure → optimize — for a real creator with a real (test-mode) budget and a paid node.

## Phase 3 — Production Hardening + Flywheel v1

**Goal:** safe, observable, and measurably self-improving.

- Compliance: KYC/AML + sanctions/PEP; ToS + disclaimers + node engagement/NDA; **clear money-transmission / escrow-licensing with counsel**; ad-policy + FTC-disclosure + GDPR/privacy guardrails hardened.
- Full guardrail stack (layered defense, injection quarantine, brand-safety, spend caps, kill switch); exhaustive RLS/pgTAP on dynamic group chats.
- `admin-ops` consoles (moderation, node/payment ops, audit-trail explorer) + the remaining dispute workflows. **The dispute console itself was pulled forward into Phase 2** by marketplace slice 8, and the reason is specific rather than a change of plan: `20260908120000` made `disputed` reachable from four states and nothing else can move a task out of it, so the console is what stops a restored arc being a new dead end. The other six consoles stay here, because building them now would mean six surfaces with no reachable state behind them. See [admin-ops.md](../30-modules/admin-ops.md).
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

### The digital-office feature map (owner-endorsed 2026-09-01)

The north star restated as **departments**: a business is run by an office, the
chat room is that office, and each department below is a feature family that
lands on primitives the wedge already built. None is scheduled — the wedge and
its exit gates come first, because a department built before department one has
a real customer is the dead-end shape this repository keeps recording. Each row
names its existing hooks, because the test of the office thesis is that a new
department is mostly reuse: if one of these needs new core tables and a new
state machine, the thesis is weaker than it looks and that finding goes in an
ADR.

| Department            | What it adds                                                                                                                                                   | Already-built hooks it lands on                                                                                                                                                   | Trigger to build                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Sales / CRM**       | Somewhere for the customers marketing produces to live: leads inbox, follow-up, pipeline. Today the funnel ends at a measured number                           | Projects/tasks DAG (a lead is task-shaped work), chat threads, campaign outcomes as the lead source, flywheel (revenue per customer is the outcome that matters most)             | first real campaign producing real conversions with nowhere to put them               |
| **Finance**           | Invoicing, expense tracking, per-project budgets rather than one ceiling, a tax calendar                                                                       | Double-entry `ledger_entries`, `escrow_holds`, `projects.budget_ceiling` and its two committer classes ([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md))      | first paying customer, or first jurisdictional filing deadline the office must track  |
| **Legal / paperwork** | E-sign, a document vault, engagement letters; later the formation-pack paperwork (entity, permits)                                                             | `engagements.nda_signed_at` and `terms_hash` — columns already waiting for a writer — plus the private artifacts bucket and signed-URL path                                       | onboarding real nodes (ToS/NDA milestone above), which needs the e-sign writer anyway |
| **Operations mode**   | Recurring work: weekly content, monthly bookkeeping, quarterly filings. Everything today is project-shaped with a finish line                                  | The ticker (already runs publish/metrics/optimize/match/crawl sweeps), the task DAG, `pg_boss` for utility jobs                                                                   | first retained customer whose engagement outlives their first campaign                |
| **Company memory**    | RAG that knows _this_ business — brand voice, past decisions, what was tried and rejected — not just marketing in general                                      | The whole RAG pipeline and flywheel; this is a corpus-per-tenant question, not a new architecture                                                                                 | first customer whose corrections repeat because the system forgot the last one        |
| **People**            | Relationships, not transactions: retainers with experts who know the business, teams on bigger jobs, the skill-assessment hiring filter (deferred table above) | The marketplace domain, `engagements`, ratings/trust (slice 8), the assessment idea and its constraints in [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) | first owner who re-requests a specific node by name                                   |

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

| Deferral                                                                                                                                          | Trigger to build                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fine-tuned proprietary model                                                                                                                      | enough Phase-3 outcome/correction data                                                                                                                                                                                                                                                   |
| Fastify WS gateway + Redis                                                                                                                        | past ~500 concurrent / server-authoritative ordering                                                                                                                                                                                                                                     |
| Trigger.dev / Temporal orchestration                                                                                                              | a single locked ticker outgrown ([ADR-0010](../40-adr/0010-postgres-durable-runner.md))                                                                                                                                                                                                  |
| Dedicated vector DB / pgvectorscale                                                                                                               | tens of millions of chunks or high QPS                                                                                                                                                                                                                                                   |
| Business-formation verticals                                                                                                                      | marketing wedge is working + flywheel spinning                                                                                                                                                                                                                                           |
| AI-administered skill assessments (recorded knowledge check, AI-scored; owner reviews each candidate's recording, score and answers, and chooses) | self-service node registration, or the first skill market where claims + ratings are not enough. Owner-proposed 2026-09-01; shape and compliance constraints in [human-nodes-marketplace.md](../30-modules/human-nodes-marketplace.md) § "Future idea: AI-administered skill assessment" |

## Definition of "production-ready" (exit gate, every phase)

Durable under crashes/deploys · idempotent side effects (incl. no double-publish/double-spend) · RLS-tested isolation · typed end-to-end · observable (traces + LLM cost/eval + spend) · guardrailed (injection + overspend + brand-safety) · accessible · **documented in lockstep** · **contributing to the flywheel.**
