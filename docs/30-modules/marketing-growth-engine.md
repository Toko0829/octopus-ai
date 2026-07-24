# Module: Marketing Growth Engine (first vertical)

> The domain module for Octopus's **first vertical**: full-funnel digital marketing for solo founders/creators. Owns the marketing channel integrations, creative generation, campaign execution, and the auto-optimize loop — all behind approval + spend guardrails. This is the vertical the [learning flywheel](../10-architecture/learning-flywheel.md) is trained on first.
>
> **Owner paths:** `packages/agent-tools/**` (marketing tools) + `packages/core` (campaign domain) + channel adapters in `packages/*`/`supabase/functions` · **Depends on:** ai-orchestrator (drives it via tools), rag-knowledge (grounding + outcome retrieval), integrations (channel/creative/analytics providers), business-projects-workflow (the funnel DAG), human-nodes-marketplace (expert marketers), payments-billing (ad-spend + escrow), analytics (metrics + optimization).
>
> Update on any change to channels, creative tools, the campaign model, or the optimization loop.

## Responsibilities

- Turn a creator's growth goal into a **coordinated full-funnel plan** and execute it.
- Integrate the marketing **channels** and **creative** generation as typed, guardrailed tools.
- Run the **auto-optimize** loop on live metrics and write outcomes to the flywheel.
- Escalate judgment/taste/relationship/access tasks to expert human nodes.

## Full-funnel scope

The engine coordinates the whole funnel, not one channel:

1. **Strategy** — positioning, ICP, offer, messaging.
2. **Content** — copy, posts, articles, scripts.
3. **Creative** — image/video/audio asset generation.
4. **Channels** — paid ads (Meta/Google), organic social, SEO, email, (later) more.
5. **Conversion** — landing pages, funnels, CTAs.
6. **Measurement & optimization** — analytics, attribution, iteration.

## Channel integrations (typed tools, guardrailed)

All channel actions are typed tools with **risk tiers**; anything that publishes or spends is `high-risk` → requires authorization + spend caps enforced in tool code (never prompts). Providers sit behind adapters in [integrations.md](integrations.md).

| Tool                                              | Risk                         | Notes                                                                               |
| ------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `research_audience` / `research_keywords`         | read-only                    | grounding + planning                                                                |
| `generate_creative` (image/video/audio)           | reversible                   | creative-gen providers; stored as artifacts                                         |
| `draft_copy` / `draft_email_sequence`             | reversible                   | copy assets                                                                         |
| `build_landing`                                   | reversible                   | conversion pages/drafts                                                             |
| `connect_channel`                                 | high-risk                    | OAuth to the user's ad/social/email accounts — **explicit user authorization only** |
| `create_campaign` / `create_ad_set` / `create_ad` | high-risk                    | ad-platform APIs; gated by approval + spend cap                                     |
| `publish_content`                                 | high-risk                    | posts as/for the user — approval required                                           |
| `set_budget` / `adjust_budget`                    | high-risk                    | never exceeds pre-authorized budget                                                 |
| `pull_metrics`                                    | read-only                    | analytics/attribution                                                               |
| `optimize_campaign`                               | reversible-within-guardrails | pause/scale/reallocate within caps + brand-safety                                   |

> **Environment note:** ad-platform (Meta Ads), creative generation (image/video/audio), and web analytics (Clarity) capabilities are already available in this workspace and map onto these tools — useful for prototyping. Provider auth/setup still required.

## Campaign / funnel domain model

- A **project** = a growth goal; its **task DAG** is the funnel (strategy → content → creative → channels → conversion → measurement).
- **Campaigns** belong to a project and map to channel entities (ad campaigns/ad sets/ads, content calendars, email sequences).
- **Assets** (creative/copy/landing) are artifacts with performance attached.
- See [business-projects-workflow.md](business-projects-workflow.md) for the DAG/state machine and [data-model.md](../10-architecture/data-model.md) for tables.

## Guardrails (marketing-specific)

- **Spend caps** per campaign/project in tool code; auto-pause on CPA/ROAS ceiling breach.
- **Brand-safety + ad-policy** pre-checks before publish/spend (platform policies, FTC disclosure, prohibited claims); ad-policy rejection → revise, never silently keep spending.
- **Authorization** for connecting accounts, publishing, and spending — explicit and per-scope.
- **Kill switch** pauses live spend + publishing at the next safe checkpoint.
- General guardrails (injection quarantine, idempotency = no double-publish/double-spend) per [security-compliance.md](../10-architecture/security-compliance.md).

## Auto-optimize loop (flywheel mechanism 3)

`pull_metrics → evaluate vs targets → optimize_campaign (pause losers / scale winners / reallocate / iterate creative) → log outcome`. Bounded by spend caps and brand-safety; framed as measurable experiments (A/B, budget bandits). Every decision + result is written to the flywheel ([learning-flywheel.md](../10-architecture/learning-flywheel.md)).

## Human nodes in marketing

Expert marketers plug in for: **creative direction & taste**, **high-end video/edit**, **brand/positioning strategy review**, **influencer/PR outreach & relationships**, **account setup/verification**, and **rescue** when the AI underperforms. Their corrections are captured as labeled data (flywheel mechanism 2). Skill tags: `creative-direction`, `paid-ads`, `seo`, `video-edit`, `copywriting`, `influencer-outreach`, `brand-strategy`. See [human-nodes-marketplace.md](human-nodes-marketplace.md).

## Key entities

`campaigns` · `ad_entities` (campaign/ad_set/ad refs) · `content_items` · `creative_assets` · `email_sequences` · `landing_pages` · `channel_connections` (OAuth, scoped) · `campaign_outcomes` · `creative_performance`.

## Relationship to the north star

This module is the **first capability layer**. Later verticals (SMB local, e-commerce growth, then business-formation) are added as sibling capability modules reusing the same orchestrator, workflow engine, marketplace, chat, payments, and flywheel — see [roadmap.md](../10-architecture/roadmap.md).
