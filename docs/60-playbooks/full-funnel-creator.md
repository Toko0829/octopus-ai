# Playbook — Full-funnel digital marketing · Solo founder / creator (FIRST vertical)

> The **flagship playbook** and Octopus's first shipped subject. Full-funnel digital-marketing management for a solo founder / creator. Compiled by [rag-knowledge](../30-modules/rag-knowledge.md) into a task DAG and executed by the [marketing-growth-engine](../30-modules/marketing-growth-engine.md). Recommendations are grounded in real, comparable outcomes via the [learning flywheel](../10-architecture/learning-flywheel.md) — cited, not generic. First market: **US/EU** (ad-policy + FTC/GDPR compliance).

## Scope

- **Archetype:** `digital-marketing > full-funnel`.
- **Customer (ICP):** solo founder / creator — personal brand, app, newsletter, or small product; budget-conscious; time-poor.
- **Goal shape:** "launch and grow my [thing] — get me to [audience/customers/revenue target]."
- **Assumptions:** modest, user-authorized ad budget; user connects their own channels; content/brand voice provided or co-created.

## Ordered steps

Legend: **AI** = agent can do · **H** = needs a human node · role in parentheses.

| #   | Step                         | AI  |  H  | Node role                    | Notes                                                                                                                                                                                             |
| --- | ---------------------------- | :-: | :-: | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Intake & goal framing        | ✅  |  —  | —                            | **Built** (`POST /intake`). Turns the one-liner into ICP, offer, target metric, budget band, timeline. Asks nothing when the goal is already specific; at most two batched rounds when it is not. |
| 2   | Market & competitor research | ✅  |  —  | —                            | Audience, competitors, positioning gaps; grounded in real comparable outcomes.                                                                                                                    |
| 3   | Positioning & messaging      | ✅  | ⚠️  | brand strategist (optional)  | AI drafts positioning/offer/message; a human node reviews taste/brand for higher tiers.                                                                                                           |
| 4   | Full-funnel plan (the DAG)   | ✅  |  —  | —                            | Channels, content cadence, creative brief, conversion path, measurement plan — as a plan card with citations + budget. **User approves.**                                                         |
| 5   | Channel connection           | ✅  | ✅  | user (auth) / access node    | OAuth to the user's ad/social/email accounts — **explicit user authorization**; some platforms need verification (a node may assist). AI never connects without consent.                          |
| 6   | Content production           | ✅  | ⚠️  | copywriter (optional)        | Posts, articles, scripts, captions; human node for premium/voice-critical work.                                                                                                                   |
| 7   | Creative generation          | ✅  | ⚠️  | creative director / editor   | Images/video/audio via generation tools; human node for high-end direction/edit or when the AI's creative underperforms.                                                                          |
| 8   | Landing / conversion setup   | ✅  | ⚠️  | dev/designer node (optional) | Landing pages, funnels, CTAs, tracking; human node for custom builds.                                                                                                                             |
| 9   | Ad campaign build            | ✅  |  —  | —                            | Draft campaigns/ad sets/ads (Meta/Google) targeting + creative + copy. **Not live yet.**                                                                                                          |
| 10  | Pre-launch compliance check  | ✅  | ⚠️  | reviewer (high-risk)         | Brand-safety, ad-policy, FTC disclosure, prohibited claims. Fails → revise.                                                                                                                       |
| 11  | Approval + go live           | ✅  | ✅  | user (approval)              | User approves budget + creative; campaigns publish **within spend caps**. AI can't spend/publish alone.                                                                                           |
| 12  | Email / social scheduling    | ✅  |  —  | —                            | Sequences + calendar scheduled on connected channels (post-approval).                                                                                                                             |
| 13  | Measure & attribute          | ✅  |  —  | —                            | Pull impressions/clicks/conversions/ROAS; attribute to campaign/asset; report digest to chat.                                                                                                     |
| 14  | Auto-optimize                | ✅  | ⚠️  | growth node (rescue)         | Pause losers, scale winners, reallocate budget, iterate creative — within guardrails. Human node on sustained underperformance.                                                                   |
| 15  | Influencer / PR / community  | ⚠️  | ✅  | outreach node                | Relationship-driven work; AI drafts + shortlists, a human node executes outreach and closes deals.                                                                                                |
| 16  | Ongoing growth + reporting   | ✅  | ⚠️  | —                            | Always-on monitoring, monthly reporting, next-iteration planning; recurring subscription.                                                                                                         |

`⚠️` = human optional/tiered (taste/quality/relationship dependent); the router decides per task and user preference.

## Escalation map

- **Authorization / access** (5, 11) → the **user**.
- **Judgment / taste / relationships** (3, 6, 7, 8, 14, 15) → **expert marketer nodes**, tiered by plan and AI confidence.
- **Compliance/brand-safety** (10) → reviewer node if flagged.
- Everything else runs autonomously.

## Flywheel hooks (what this playbook feeds)

- Every campaign + **outcome** (step 13) → ingested for "what worked for creators like this" (mechanism 1).
- Every **human-node correction** (steps 3, 6, 7, 14) → labeled data (mechanism 2).
- Every **optimization decision + result** (step 14) → outcome data (mechanism 3).
- Feeds [learning-flywheel.md](../10-architecture/learning-flywheel.md); over time steps 3/6/7/14 need fewer human corrections.

## Guardrails

Spend caps per campaign/project (tool code) · auto-pause on CPA/ROAS breach · ad-policy + FTC + GDPR pre-checks before publish/spend · explicit authorization for connect/publish/spend · kill switch pauses live spend. See [marketing-growth-engine.md](../30-modules/marketing-growth-engine.md) and [security-compliance.md](../10-architecture/security-compliance.md).

## Cost/time

Ad budget is the user's (managed within caps); Octopus pricing = subscription + managed-spend/performance fee + marketplace take-rate on nodes ([vision.md](../00-overview/vision.md)). Creative/asset volume per plan tier.

## Freshness

Ad-platform policies, format specs, and channel best-practices change often — tracked as dated, cited sources in `knowledge_sources` with re-crawl cadence ([rag.md](../10-architecture/rag.md)). Never quote platform rules/specs from memory.
