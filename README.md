# Octopus — the AI that runs your business

> **Single source of truth.** Anyone — human or AI build-agent — starts here. This file states the vision, the canonical core loop, the pinned stack, and links to every supporting and module doc. It is an **index + summary**, not a dumping ground: depth lives in the linked docs. **Update this file on any change to scope, stack, the core loop, or the module map.** See [AGENTS.md](AGENTS.md) for the binding documentation-maintenance rule.

- **Status:** Phase 1 complete; **Phase 2 in progress**. Phase 0 is complete (source-of-truth documentation set + Turborepo monorepo scaffold).

  **Live end to end.** The Discord-style chat shell in `apps/web` runs entirely on real data (Supabase sign-in, rooms/channels/members, message history, Realtime delivery and presence) over the server-authoritative write path in `apps/api`. The AI is a real member of the chat: a goal starts an agent run (`202 + runId`), the Python `services/ai` core returns **proposals**, and Node executes them.

  **A goal now produces a structured full-funnel plan**, rendered as a card: six fixed stages, per-step owners (AI / HUMAN / YOU), per-step citations, and stages left **visibly empty** where the corpus does not cover them. The owner can approve or send it back with a note, and that verdict is captured in `feedback_events` as the flywheel's first labelled data.

  **Approving that plan now creates the work.** A project and one task per step, in one transaction, with the per-step owner becoming the row that the router will read. The task DAG, its state machine and its acyclicity are enforced in Postgres by trigger rather than in the runner, because the runner is the part [ADR-0001](docs/40-adr/0001-durable-orchestration-trigger-vs-temporal.md) already plans to replace.

  **And the DAG is a graph rather than a list.** `task_deps` existed, was guarded against cycles, and held no rows for two weeks, because the planner emitted stages and steps and the only edges available would have been inferred from stage order, which states a constraint nobody made. The planner now says which steps consume which other steps' output, so the scheduler holds a step back until what it needs is approved instead of dispatching a whole plan at once. **Stage order is still presentation and nothing infers an edge from it.** The two layers disagree on purpose: the reasoning core drops a reference it cannot resolve and flattens the graph on a cycle, because a plan is worth far more than its edges and flat is what every plan used to be, while Postgres raises on the same input, because a card can also arrive from an older service or a hand edit and guessing on its behalf is how an invented edge gets in.

  **Retrieval is measured, not asserted.** Hybrid search (dense + sparse fused by RRF in SQL) then an in-process cross-encoder, with a threshold that drops weak chunks; **query decomposition** splits a broad goal into per-stage sub-queries, sized to how broad the goal actually is. A golden-set **eval gate runs in CI** (positive recall 1.00, coverage 1.00, zero negative leaks). When nothing clears the threshold the agent **refuses and says why** rather than inventing a plan, and decomposition is additive to grounding rather than a source of it.

  **A threshold ranks; it does not decide scope, so a second gate does.** A rerank score answers "which chunk fits best", which always has an answer when the query is marketing and the corpus is marketing, so an in-vocabulary but uncovered question ("how do I set up conversion tracking in GA4") cleared the threshold by 12x over a legitimate broad goal. That is measured, not suspected, and no threshold separates the two bands. A **groundedness gate** now sits between retrieval and generation and asks whether the sources actually answer the goal. It fails closed, judges the same sources the planner will see, and distinguishes "your question is outside my sources" from "I could not check", because telling someone the first when the second happened is a false statement on a trust surface. It has its own set of in-vocabulary negatives, scored in a credentialed pass that also measures the **false-refusal** rate, since a gate judged only on what it refuses scores perfectly by refusing everything. That was not hypothetical: the first measured run refused every uncovered question **and** three goals the corpus plainly covers, so the two-sided measurement is what stopped a confident-looking 1.00 from shipping. Now 1.00 on both halves. Embeddings can run locally on **BAAI/bge-m3** ([ADR-0008](docs/40-adr/0008-local-bge-m3-embeddings.md)) or on OpenAI. RLS is covered by a **pgTAP suite** (22 assertions), including that an expired node sees nothing at all.

  **Not built, and not claimed:** the **generation** eval (Ragas/DeepEval faithfulness needs an LLM judge, so retrieval is gated and generation is not), durable runs (Trigger.dev, blocked on credentials), OpenAPI generation, a Node-side test harness, and a formal anti-slop design review. **The corpus is externally cited now.** A checked-in source registry, a guarded fetcher, page-hash change detection and a cadence re-crawl sweep on the existing ticker put four real documents beside the ten we wrote, each carrying its publisher, its address and the date we read it, so a citation on the plan card is a link a reader can open. The measuring is the interesting half, and it removed more entries than it kept. Nine pages were registered and seven answered, but three of the seven were site navigation rather than a document, one of them localised to the crawler's own IP and stored as a Facebook menu in Georgian: **a status code is not evidence a page is a document**, so every entry is verified by reading what it stored. A fourth was removed by the eval rather than the fetcher. Meta's advertising standards fetched perfectly, and a 25-chunk policy hub written in general marketing vocabulary turned out to act as a magnet: it caused the retrieval gate's only leak, and on an unrelated legitimate question it took five of the top eight results while the document that actually answers that question took none. **Fetchability and usefulness are separate questions**, which is not obvious until they disagree. Two families stay uncovered and are named rather than implied: the FTC blocks our declared crawler, which we are not going to disguise, and no EU-official page was found that this fetcher can read. **Retrieval no longer depends on a paid provider at all.** Reranking moved in-process onto `bge-reranker-v2-m3` ([ADR-0009](docs/40-adr/0009-local-reranker.md)), matching the hosted reranker on the golden set (recall 1.00, coverage 1.00, zero leaks). That only became possible after fixing four defects in our own pipeline, which had made two standard models look unusable: decomposition emitted the maximum sub-queries on every goal, those sub-queries ran 20-30 words at a cross-encoder trained on six, one was generated every time for a funnel stage the corpus has no document for, and 40 candidates were reranked against a 43-chunk corpus where RRF already ranked the answer 1st to 3rd. Rerank calls per eval run fell 87 to 49 with identical results, and a goal went from 265s to 71s. The remaining cost is CPU: plan latency now scales with the cores the AI service is given, and runs are asynchronous so that is a wait rather than a failure.

  See [CHANGELOG.md](CHANGELOG.md) for what exists and [roadmap.md](docs/10-architecture/roadmap.md) for what is next.

- **Owner persona for AI build-agents:** senior software developer **and** business analyst. See [AGENTS.md](AGENTS.md).
- **First vertical (what we ship first):** full-funnel **digital marketing** for **solo founders / creators**. The everything-product is the north star, not the first ship — see the wedge strategy in [vision.md](docs/00-overview/vision.md).
- **First markets:** United States + EU (ad-policy / FTC / GDPR compliance). Business-formation packs (the cafe story, incl. Georgia / Tbilisi) are a later expansion vertical.
- **Design direction:** _Editorial / calm minimal_ (Stripe · Vercel · Framer energy), expressed through the "Ink & Bioluminescence" house style. See [docs/20-design/design-system.md](docs/20-design/design-system.md).

---

## 1. Vision & Product Thesis

Octopus is an AI agent that **runs entire businesses end-to-end** for a user, keeping the user's personal involvement minimal, backed by a **marketplace of human "nodes"** who execute the steps an AI shouldn't or can't do alone.

> **Go-to-market: wedge first.** The everything-product isn't buildable on day one — it needs real-world experience to get good. So Octopus ships **one vertical first — full-funnel digital marketing for solo founders/creators** — learns from real usage via a **[data flywheel](docs/10-architecture/learning-flywheel.md)** (the moat), then expands toward the north star. Full rationale in [vision.md](docs/00-overview/vision.md).

- **One line in → real growth out.** A creator types _"launch and grow my app — get me to my first 1,000 customers"_ and gets a researched, cited, full-funnel plan, then **autonomous execution** (content, creative, ads, SEO, email, measurement) with expert humans dropped in only at genuine escalation points. (North-star example: _"open a cafe in Austin"_ — a later business-formation vertical.)
- **The name.** An octopus has eight arms working in parallel (parallel workstreams), changes color to fit its environment (adaptive theming), and is famously intelligent. It is a deliberate, ownable identity — the opposite of generic "purple-gradient AI slop."
- **Human nodes = tentacles.** When a step is legally reserved or physical (signing a lease, notarization, a health inspection, an in-person bank visit), a vetted local worker is matched, paid via escrow, and dropped into a **Discord-style group chat** with the user and the AI to get it done.
- **Non-goals.** Not a chatbot wrapper. Not legal/financial/tax **advice** (informational only; regulated advice routes to licensed humans). Not a DIY checklist tool. The product is **autonomous execution + accountable human hand-off.**

**Monetization (summary):** execution subscription · milestone success fee · ~15–25% marketplace take-rate on human-node payouts · disclosed referral fees · ongoing-ops SaaS. Sequencing in [roadmap.md](docs/10-architecture/roadmap.md).

## 2. The Core Loop (canonical)

1. User posts a business goal in the Discord-style chat → Fastify persists the message (under RLS) → a Postgres trigger broadcasts it live.
2. A **durable agent run** starts; the orchestrator decomposes the goal into a **RAG-grounded task DAG** — for the first vertical, a full-funnel marketing plan (positioning, content, creative, channels/ads, conversion, measurement), grounded in _what actually worked for comparable customers_.
3. The AI executes AI-capable tasks (research, copy, creative generation, ad-set drafting, landing pages), **streaming its work inline into the shared channel as a first-class member.**
4. On a step needing human judgment/taste/relationships/authorization (or a legally/physically restricted step in later verticals) the agent calls `request_human_node`; **escrow is held**, the marketplace matches a KYC'd expert node, and the durable run **suspends on a waitpoint** (days can pass at zero compute cost).
5. The matched node **joins the task thread**, does the real-world work, submits proof; an AI critic + the user approve; escrow releases; the run **resumes deterministically** at the suspended step.
6. Every decision, citation, approval, and payout is **event-sourced** for audit.

Full 10-step trace: [docs/00-overview/core-loop.md](docs/00-overview/core-loop.md).

## 3. Hard Stack (pinned)

| Layer                            | Choice                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend + thin BFF              | **Next.js 15** (App Router, `@supabase/ssr`) on Vercel — never runs agent loops or long jobs                                                                                                                                                                                                                                               |
| Backend services                 | **Node.js 22 + Fastify 5** (`apps/api` authoritative REST, `apps/matcher` marketplace) on Fly.io                                                                                                                                                                                                                                           |
| Data · auth · realtime · storage | **Supabase** — Postgres 16 (RLS), GoTrue asymmetric JWT/JWKS, Storage, Realtime (Broadcast + Presence)                                                                                                                                                                                                                                     |
| Durable agent orchestration      | **Trigger.dev v3** (baseline) with human-in-the-loop waitpoints; **Temporal** as the documented escape hatch; **pg-boss** for utility jobs                                                                                                                                                                                                 |
| RAG                              | **pgvector** (`halfvec`/HNSW) hybrid search in the same Postgres · **BAAI `bge-m3`** embeddings (1024 dims) · **BAAI `bge-reranker-v2-m3`** rerank, both in-process                                                                                                                                                                        |
| AI providers                     | **OpenAI** for generation. Embedding and rerank run **locally**, so no corpus text leaves the process and there is no retrieval quota. [ADR-0007](docs/40-adr/0007-openai-generation-embeddings-cohere-rerank.md) as amended by [ADR-0008](docs/40-adr/0008-local-bge-m3-embeddings.md) and [ADR-0009](docs/40-adr/0009-local-reranker.md) |
| Contract boundary                | OpenAPI + **ts-rest**, Zod schemas shared in `packages/contracts`                                                                                                                                                                                                                                                                          |

> The AI/RAG layer runs as a **separate Python service** (FastAPI); Node/Fastify owns everything else. _Python proposes, Node executes._ See [ADR-0006](docs/40-adr/0006-python-ai-service-node-backend.md).

Pinned versions, rejected alternatives, and upgrade policy: [tech-stack.md](docs/10-architecture/tech-stack.md).

## 4. RAG Summary

- **Stay in Postgres** — `pgvector` `halfvec(1024)`, HNSW cosine, iterative scans. Relational, permissioned (RLS multi-tenant isolation), transactionally consistent. ([ADR-0002](docs/40-adr/0002-stay-in-postgres-pgvector.md))
- **Hybrid retrieval:** dense (`bge-m3` @ 1024 dims, on _contextualized_ chunks) + sparse (`tsvector`/BM25) fused via **RRF (k=60)**, then a **`bge-reranker-v2-m3` cross-encoder** over top-25 → top 6–8, then the **groundedness gate**. Candidate depth is a **measured** setting tied to corpus size, not a constant. ([ADR-0008](docs/40-adr/0008-local-bge-m3-embeddings.md), [ADR-0009](docs/40-adr/0009-local-reranker.md))
- **Multilingual by construction** (EU languages + Georgian/Russian for the future pack); **one** embedding model across the whole corpus so a single HNSW index is shared.
- **Contextual retrieval** (Anthropic-style) + layout-aware parsing; structured sources (suppliers, cost benchmarks) stored as **typed rows**, not prose chunks.
- **Freshness is a first-order feature:** effective-dating, content-hash change detection, cadence re-crawls on the `apps/api` ticker (not `pg_cron`, which runs SQL and so cannot fetch a URL), "last verified" dates, human re-verification on high-stakes stale data.
- **Guarded generation:** mandatory citations, a **groundedness gate that is a separate check rather than a threshold** (a score ranks within the corpus and cannot say the corpus does not cover the question), refuse-and-escalate on low confidence. RAG provides the _checklist_; **humans execute the judgment-, taste-, or regulated acts.**
- **Learning flywheel:** real campaigns + outcomes and human-node corrections are ingested back, so retrieval increasingly reflects _what actually worked for real customers_ — the moat. See [learning-flywheel.md](docs/10-architecture/learning-flywheel.md).

Full spec: [rag.md](docs/10-architecture/rag.md) · Flywheel: [learning-flywheel.md](docs/10-architecture/learning-flywheel.md).

## 5. Architecture Summary

- **Two-layer brain:** a **durable execution backbone** (survives crashes/deploys, sleeps for days on waitpoints) + a **supervisor/orchestrator reasoning core** (single writer to the task DAG; ephemeral read-only sub-agents used as tools).
- **Postgres is the single source of truth** for chat, projects, tasks, ledger, and embeddings. The **AI participates by `INSERT`ing message rows** exactly like a human node — no special path.
- **Chat transport:** Supabase Realtime **Broadcast-from-Postgres** + Presence behind an abstraction, with a documented migration to a Fastify uWebSockets gateway past the ~500-concurrent ceiling. ([ADR-0003](docs/40-adr/0003-realtime-broadcast-not-postgres-changes.md))
- **Authorization is defense-in-depth:** Fastify JWKS verification **plus** Postgres RLS membership as the real backstop; `service_role` never reaches the client.
- **Every side effect is idempotent and event-sourced;** money/irreversible tools enforce spend caps and RBAC **in tool code, not prompts.**

- **Language split ([ADR-0006](docs/40-adr/0006-python-ai-service-node-backend.md)):** a **Python AI service** (FastAPI) owns RAG + agent reasoning + eval + models; **Node/Fastify** owns chat, auth, marketplace, payments, and the durable backbone + all side-effecting tools. Python decides _what_; Node does the side effects with guardrails.

Full topology + 10-step data flow: [architecture.md](docs/10-architecture/architecture.md).

## 6. Design Summary

- **House style — "Ink & Bioluminescence".** Primary aesthetic is **editorial / calm minimal**: an editorial **light** shell (marketing, onboarding, trust surfaces), with a **dark "Command Deck"** for dense work surfaces and a **warm, presence-rich chat**. Unified by an octopus-ink neutral ramp + one bioluminescent teal signal accent + coral for human/CTA. Glow is **reserved** for live agent/presence — used sparingly.
- **Avoid the AI-slop tells:** no violet primary, no 2-stop purple gradient hero, no sparkle/"magic" badges, no default un-customized shadcn + Inter + zinc, no glassmorphism-everywhere, no pure-`#000` dark, no corner chatbot bubble.
- **Real references drive it:** Stripe/Vercel/Framer (editorial trust + motion), Linear/Superhuman/Raycast (command-deck density + ⌘K), Family/Arc (tactile delight + per-business theming), Discord/Slack/Zulip (chat model + interactive embeds).
- **Chat is the differentiator:** Discord's 5-region layout with the AI **inline in the stream** (not a corner bubble) and **interactive action embeds** (Approve / Pay / Sign / Assign) permission-gated by role.

Tokens + full spec: [design-system.md](docs/20-design/design-system.md) · Chat spec: [discord-chat-spec.md](docs/20-design/discord-chat-spec.md).

## 7. Module Index

Each module has its own doc in [`docs/30-modules/`](docs/30-modules/) and must be updated whenever its code changes.

| Module                                                                      | Responsibility                                                                           | Depends on                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [auth-identity](docs/30-modules/auth-identity.md)                           | Sessions, JWT/JWKS, RLS, roles (user/node/admin)                                         | infra-devops                                                                     |
| [ai-orchestrator](docs/30-modules/ai-orchestrator.md)                       | Durable agent runtime, planner/executor DAG, tools, guardrails                           | rag-knowledge, business-projects-workflow, chat-discord, human-nodes-marketplace |
| [marketing-growth-engine](docs/30-modules/marketing-growth-engine.md)       | **First vertical:** full-funnel marketing — channels, creative, campaigns, auto-optimize | ai-orchestrator, integrations, business-projects-workflow, analytics             |
| [rag-knowledge](docs/30-modules/rag-knowledge.md)                           | Ingestion, hybrid retrieval, eval, jurisdiction packs                                    | infra-devops, integrations                                                       |
| [business-projects-workflow](docs/30-modules/business-projects-workflow.md) | Projects, task DAG, state machine, scheduler                                             | ai-orchestrator, human-nodes-marketplace                                         |
| [human-nodes-marketplace](docs/30-modules/human-nodes-marketplace.md)       | Node onboarding/KYC, matching, offers, lifecycle                                         | payments-billing, chat-discord, notifications, auth-identity                     |
| [chat-discord](docs/30-modules/chat-discord.md)                             | Channels/threads/messages/presence/embeds                                                | auth-identity, notifications, design-system-frontend                             |
| [payments-billing](docs/30-modules/payments-billing.md)                     | Escrow, Stripe Connect payouts, double-entry ledger, subscriptions                       | human-nodes-marketplace, auth-identity                                           |
| [notifications](docs/30-modules/notifications.md)                           | Multi-channel fan-out, offer expiry/cascade, digests                                     | chat-discord, integrations                                                       |
| [integrations](docs/30-modules/integrations.md)                             | External providers (Stripe, Persona, OpenAI/Cohere, crawlers, maps)                      | infra-devops                                                                     |
| [admin-ops](docs/30-modules/admin-ops.md)                                   | Dispute resolution, moderation, node/payment ops consoles                                | all domain modules                                                               |
| [analytics](docs/30-modules/analytics.md)                                   | Product analytics, LLM cost/eval traces, funnels                                         | observability, ai-orchestrator                                                   |
| [infra-devops](docs/30-modules/infra-devops.md)                             | Monorepo, CI/CD, deployment, secrets, observability wiring                               | foundation for all                                                               |
| [design-system-frontend](docs/30-modules/design-system-frontend.md)         | Token system, component library, chat UI shell                                           | auth-identity, chat-discord                                                      |

## 8. Documentation Map

- **Overview:** [vision](docs/00-overview/vision.md) · [core-loop](docs/00-overview/core-loop.md) · [glossary](docs/00-overview/glossary.md) · [personas](docs/00-overview/personas.md)
- **Architecture:** [architecture](docs/10-architecture/architecture.md) · [tech-stack](docs/10-architecture/tech-stack.md) · [data-model](docs/10-architecture/data-model.md) · [rag](docs/10-architecture/rag.md) · [learning-flywheel](docs/10-architecture/learning-flywheel.md) · [security-compliance](docs/10-architecture/security-compliance.md) · [observability](docs/10-architecture/observability.md) · [roadmap](docs/10-architecture/roadmap.md)
- **Design:** [design-system](docs/20-design/design-system.md) · [discord-chat-spec](docs/20-design/discord-chat-spec.md) · [brand](docs/20-design/brand.md)
- **Modules:** [`docs/30-modules/`](docs/30-modules/) (14 docs, table above)
- **Decisions:** [`docs/40-adr/`](docs/40-adr/) · **Runbooks:** [`docs/50-runbooks/`](docs/50-runbooks/) · **Playbooks:** [`docs/60-playbooks/`](docs/60-playbooks/) · **Diagrams:** [`docs/70-diagrams/`](docs/70-diagrams/) · **Legal:** [`docs/80-legal/`](docs/80-legal/)
- **Engineering:** [DEVELOPMENT.md](DEVELOPMENT.md) (local setup & commands) · **AI rules:** [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) · **Change log:** [CHANGELOG.md](CHANGELOG.md) · **Doc registry:** [.docmeta.yml](.docmeta.yml)

## 9. Documentation Maintenance Rule (binding)

This README is the single source of truth and **must stay consistent with reality — treat doc drift as a bug.**

1. Every code change updates the **relevant module doc** in `docs/30-modules/`.
2. Update **this master README** when scope, stack, the core loop, the module map, or a cross-cutting decision changes.
3. New irreversible decisions require a **new ADR** in `docs/40-adr/` linked from the affected doc.
4. `.docmeta.yml` maps code paths to owning module docs; **CI fails a PR that touches mapped code without touching its owning doc.**
5. Append a one-line entry to [CHANGELOG.md](CHANGELOG.md).

See [AGENTS.md](AGENTS.md) for the full enforced rule and the exact PR checklist.
