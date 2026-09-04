# Vision & Product Thesis

> Why Octopus exists, what it is, what it is deliberately **not**, and how it makes money — plus the **wedge-first go-to-market** that gets us there. Update this doc when the product thesis, the beachhead, the flywheel, or the non-goals change.

## The problem

Running the growth side of a business is a maze of parallel, fast-moving, mostly-tedious work: strategy, content, ads, SEO, email, social, analytics, iteration. Most solo founders and creators can't afford an agency, don't have time to become marketers, and get generic advice that ignores what _actually works for people like them_. The person with the idea ends up doing the marketing badly, or not at all.

## The thesis (north star)

**An AI can run the business; humans plug in only where judgment, relationships, or the physical/legal world require it.** The user states a goal in plain language; Octopus researches, plans, executes autonomously, and pulls in accountable human experts ("nodes") for the parts an AI shouldn't or can't do. The user is engaged **far less** than a typical operator.

This is the long-term vision — Octopus eventually runs _entire_ businesses (formation, operations, compliance, growth). But we don't build the everything-product first.

## The wedge: start with one subject, learn from reality, then expand

A product that runs _every_ business on day one isn't buildable — it needs real-world experience to get good. So we take a **beachhead**:

1. **Pick one vertical, ship it, get real users.**
2. **Learn from real usage** — real work, real outcomes, real expert corrections build a proprietary dataset (the [learning flywheel](../10-architecture/learning-flywheel.md)).
3. **Expand** to adjacent verticals once the flywheel is spinning, on the way to the north star.

### First vertical: full-funnel digital marketing

Octopus's first job is to be a **full-funnel digital-marketing operator** — strategy, content, paid ads, SEO, email, social, and analytics — coordinated end-to-end, not a single channel.

**Why marketing is the right wedge:**

- **Measurable** — clicks, conversions, ROAS give a clean signal to learn from (the flywheel needs outcomes).
- **Mostly digital** — the AI can execute a large share autonomously.
- **Recurring** — ongoing growth work = a natural subscription.
- **Human nodes fit perfectly** — expert marketers, creative directors, and strategists plug in for judgment, taste, and relationships.
- **Tooling exists today** — ad-platform APIs, creative generation (image/video/audio), and web analytics are already available in our environment.

### First customer: solo founders & creators

The ICP we optimize for: **solo founders, indie makers, and creators** (personal brands, apps, newsletters, small products). They feel the pain most, sign fast, are budget-conscious, and carry viral upside. Everything — pricing, UX, the first playbook — is tuned to them before we widen to SMBs/e-commerce/B2B.

### Expansion path (later verticals)

Adjacent digital services → SMB local marketing → e-commerce growth → and eventually the original **business-formation / "run any business"** vertical (the cafe story) as a documented future pack. See [roadmap.md](../10-architecture/roadmap.md).

## The moat: the data flywheel

The real defensibility is **the harness and the dataset**, not the generator. The harness is the part nobody gets for free by buying an API key: the plan card as the authorisation boundary, the spend cap composed across every campaign and every held escrow, the router that parks a step for a human, escrow and the marketplace behind it, the groundedness gate, and the audit trail under all of it. The dataset is built from running real marketing for real customers. Which model does the reasoning is now a workspace's own choice ([ADR-0032](../40-adr/0032-reasoning-providers-are-workspace-connectors.md)), which is the honest position: a frontier model is a commodity input and the guardrails around it are not. Four compounding mechanisms (full architecture in [learning-flywheel.md](../10-architecture/learning-flywheel.md)):

1. **Ingest campaigns + outcomes** — the RAG retrieves _what actually worked for real customers like you_, not generic best-practices.
2. **Human-node feedback as labeled data** — every expert correction/approval is a training example.
3. **Auto-optimize on live metrics** — campaigns self-improve from real performance (CTR, ROAS, conversions).
4. **Fine-tune later on our own data** — once enough outcome and correction data accrues, inside a provider's own fine-tuning product. Still Phase 4, and now explicitly **never on another model's output**: no training, no distillation, house provider or connector, on the terms all three vendors set and for the stronger reason that ingesting model prose would turn an unverified claim into a citation.

More customers → more outcomes + corrections → smarter Octopus → better results → more customers. That loop is the business.

## What Octopus is NOT

- **Not a "generate a post" toy.** It runs the _whole funnel_ and executes durable, multi-step work with real outcomes.
- **Not generic marketing advice.** Recommendations are grounded in real, comparable outcomes — with citations to what worked.
- **Not a place where the AI acts as the user without permission.** It never posts, spends ad budget, or accesses accounts without explicit authorization; risky/irreversible actions require approval.
- **Not (yet) the everything-product.** Business formation and operations are the north star, not the first ship.

## Monetization (marketing wedge → platform)

| Stream                             | What                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Execution subscription             | Monthly plan unlocks autonomous full-funnel execution, monitoring, and node coordination.  |
| Managed-ad-spend / performance fee | A % of managed ad spend, or a performance fee tied to real results (leads, sales, growth). |
| Marketplace take-rate              | ~15–25% on payouts to human marketing nodes (creative, strategy, editing, outreach).       |
| Creative credits                   | Generation of image/video/copy assets beyond the plan allowance.                           |
| Ongoing-ops SaaS                   | Always-on growth monitoring + reporting after the initial ramp.                            |
| Data/benchmarks (later)            | Anonymized, aggregated performance benchmarks as a product.                                |
| Expansion verticals                | New subjects (SMB, e-commerce, formation) monetized on the same rails.                     |

## North-star & guardrail metrics

- **North star (wedge):** real customer growth outcomes delivered (e.g., verified new customers/leads/revenue attributable to Octopus), and users who stay because it _works_.
- **Flywheel health:** volume of outcome-labeled data, human-correction rate trending **down** over time (the AI is learning), retrieval-of-real-outcomes coverage.
- **Guardrails:** brand-safety / ad-policy compliance, spend-cap adherence, escalation precision, user-touch-count per result (lower is better).

See [personas.md](personas.md) for who this serves, [core-loop.md](core-loop.md) for the mechanic, and [learning-flywheel.md](../10-architecture/learning-flywheel.md) for how it compounds.
