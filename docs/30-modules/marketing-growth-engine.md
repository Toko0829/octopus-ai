# Module: Marketing Growth Engine (first vertical)

> The domain module for Octopus's **first vertical**: full-funnel digital marketing for solo founders/creators. Owns the marketing channel integrations, creative generation, campaign execution, and the auto-optimize loop — all behind approval + spend guardrails. This is the vertical the [learning flywheel](../10-architecture/learning-flywheel.md) is trained on first.
>
> **Owner paths:** `packages/marketing/**` (campaign domain: spend math, the adapter seam, the provider registry) + `apps/api` (marketing tool IO) · **Depends on:** ai-orchestrator (drives it via tools), rag-knowledge (grounding + outcome retrieval), integrations (channel/creative/analytics providers), business-projects-workflow (the funnel DAG), human-nodes-marketplace (expert marketers), payments-billing (ad-spend + escrow), analytics (metrics + optimization).
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
- See [business-projects-workflow.md](business-projects-workflow.md) for the DAG/state machine and [data-model.md](../10-architecture/data-model.md) for tables. That pointer is now true: the marketing domain has a schema section there rather than a forward reference.

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

Nine were specified from Phase 0 and this table says which of them exist, because a list that mixes live tables with intentions reads as though all nine are there. Column shapes live in [data-model.md](../10-architecture/data-model.md).

| Entity                 | Status                   | Notes                                                                                                              |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `campaigns`            | ✅ live `20260829120000` | One channel, one authorised cap, one lifecycle. `budget_cap` NULL means nothing authorised, never unlimited        |
| `channel_connections`  | ✅ live `20260829121000` | OAuth tokens, **room-scoped**. No client policy and no client grant: RLS filters rows, not columns                 |
| `ad_entities`          | ✅ live `20260829122000` | The campaign → ad_set → ad tree. `rejected` is entity-level; `spec` is the approved brief the publisher reads      |
| `campaign_outcomes`    | ✅ live `20260829123000` | Measured performance. Append-only including for `service_role`; a correction is a new row with `source = 'manual'` |
| `content_items`        | ⏳ deferred (slice 6+)   | Needs a producer first. A schema with no writer is this repository's most-documented defect class                  |
| `creative_assets`      | ⏳ deferred (slice 6+)   | Lands with the creative-provider ADR and the first byte-producer; until then creative arrives as a file artifact   |
| `email_sequences`      | ⏳ deferred (slice 6+)   | —                                                                                                                  |
| `landing_pages`        | ⏳ deferred (slice 6+)   | —                                                                                                                  |
| `creative_performance` | ⏳ deferred (slice 6+)   | Depends on `creative_assets` existing to attach to                                                                 |

**No writer exists for the four live tables yet, and that is deliberate rather than an oversight.** The campaign card, `materialise_campaign`, the OAuth callback and the publish executor are the next slices. Guards land with their tables here because the recorded failure in this repository is the other order: `tasks.risk_tier` was unreachable for its entire life, and `task_deps` held no row for two weeks while enforcing an empty set.

## Campaign lifecycle

`draft → ready → publishing → live → paused → completed`, plus `cancelled` and `failed`. Enforced by trigger in Postgres (`private.guard_campaign_transition`), which also writes the `campaign.transitioned` audit event, so a transition cannot be recorded without having happened and cannot happen without being recorded.

Two arcs are worth reading rather than skimming:

- **`publishing` is not `live`.** Claiming a campaign is live before the platform confirmed it would put an untrue sentence in the audit trail. Between the request and the confirmation the honest answer is "we asked", and that is a state.
- **`live → cancelled` does not exist.** A spending campaign is paused first. Stopping the money and closing the record stay two acts with two events, so nobody can close a campaign and discover afterwards that it was still spending.

`pause_reason` (`kill_switch` | `cpa_breach` | `user` | `optimizer`) carries **why** spend stopped. The reason is data; the state is the same one however it was reached.

## Relationship to the north star

This module is the **first capability layer**. Later verticals (SMB local, e-commerce growth, then business-formation) are added as sibling capability modules reusing the same orchestrator, workflow engine, marketplace, chat, payments, and flywheel — see [roadmap.md](../10-architecture/roadmap.md).
