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

| Tool                                              | Risk       | Notes                                                                               |
| ------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `research_audience` / `research_keywords`         | read-only  | grounding + planning                                                                |
| `generate_creative` (image/video/audio)           | reversible | creative-gen providers; stored as artifacts                                         |
| `draft_copy` / `draft_email_sequence`             | reversible | copy assets                                                                         |
| `build_landing`                                   | reversible | conversion pages/drafts                                                             |
| `connect_channel`                                 | high-risk  | OAuth to the user's ad/social/email accounts — **explicit user authorization only** |
| `create_campaign` / `create_ad_set` / `create_ad` | high-risk  | ad-platform APIs; gated by approval + spend cap                                     |
| `publish_content`                                 | high-risk  | posts as/for the user — approval required                                           |
| `set_budget` / `adjust_budget`                    | high-risk  | never exceeds pre-authorized budget                                                 |
| `pull_metrics`                                    | read-only  | analytics/attribution                                                               |
| `optimize_campaign`                               | `external` | pause/scale/reallocate within already-authorised caps + brand-safety                |

**`optimize_campaign` maps to `external`, and the tier it used to carry was not a tier at all.** This table said "reversible-within-guardrails", which is not a member of `public.task_risk_tier` and never was: the canonical enum is `read_only | reversible | external | high_risk` (`packages/contracts/src/index.ts`). It sat here unchallenged because a value in a markdown table is checked by nothing.

`external` is the right one and the reason is what it would cost to be wrong in either direction. The tool touches an external system, so `reversible` understates it. It touches that system **within caps a person already authorised**, so `high_risk` overstates it, and `high_risk` is not a label: `routeTask`'s first rule sends every `high_risk` task to `needs_user` whatever the planner said, so tiering the optimizer that way would put every optimisation pass behind a confirmation click and switch off the autonomy this module exists to provide. A budget change **beyond** an authorised cap is a different tool, `set_budget`, and that one stays `high_risk`.

> **Environment note:** ad-platform (Meta Ads), creative generation (image/video/audio), and web analytics (Clarity) capabilities are already available in this workspace and map onto these tools — useful for prototyping. Provider auth/setup still required.

## Campaign / funnel domain model

- A **project** = a growth goal; its **task DAG** is the funnel (strategy → content → creative → channels → conversion → measurement).
- **Campaigns** belong to a project and map to channel entities (ad campaigns/ad sets/ads, content calendars, email sequences).
- **Assets** (creative/copy/landing) are artifacts with performance attached. Copy is an inline artifact; a generated image or video will be a **file artifact** in the private `artifacts` bucket (`20260829124000`), written by `writeFileArtifact` and read through a signed URL. **No creative provider is wired yet and `generate_creative` still produces a structured brief as ordinary text**: choosing an image or video provider is an irreversible decision that needs its own ADR, and until a byte-producer exists a file-producing proposal kind would be a wire shape designed before anything can fill it. Slice 6.
- See [business-projects-workflow.md](business-projects-workflow.md) for the DAG/state machine and [data-model.md](../10-architecture/data-model.md) for tables. That pointer is now true: the marketing domain has a schema section there rather than a forward reference.

## `packages/marketing` (the domain, without the IO)

The `@octopus/core` split applied here: reasoning a reader can check without running anything goes in a package, and everything that talks to Postgres or to a platform stays in `apps/api`. **There is no Supabase client, no `fetch`, no filesystem access and no clock anywhere in `packages/marketing`.** That is a property to keep, not a coincidence of the package being new.

| File                  | What it decides                                                                  |
| --------------------- | -------------------------------------------------------------------------------- |
| `spend.ts`            | `checkSpendCap`: may this campaign be authorised for this amount                 |
| `adapter.ts`          | `AdChannelAdapter`, the seam every platform sits behind, and its Zod I/O shapes  |
| `fake-adapter.ts`     | A complete deterministic implementation of that seam, with no platform behind it |
| `adapter-registry.ts` | Which providers exist, checked in rather than stored                             |

### The spend cap

`checkSpendCap` is pure and one screen, in the `routeTask` shape: the verdict carries **which rule fired** and one sentence of why, because "why was this refused" is the first question anyone asks and re-deriving it later means guessing at the numbers the caller had.

It composes two authorisations. `projects.budget_ceiling` is what the owner authorised for the whole venture; `campaigns.budget_cap` is what is already committed to the project's non-terminal campaigns. **The check is against the sum**, not against the proposal alone, because a per-campaign limit is not a limit: three campaigns of 400 each pass individually against a ceiling of 1000 and commit 1200 between them.

**`null` means nothing authorised, never unlimited.** That is the column's own documented stance and this function is where it becomes real rather than written down. Reading `null` as "no limit set" would turn every unbudgeted planning project into an open account, silently.

The two reads that feed it (the project's ceiling, the siblings' caps) are IO and live in `apps/api`. Rule 7 is why the arithmetic is here at all: a spend limit nobody can read is not a control.

One addition beyond the two rules the design called for: an `invalid_amount` verdict for a non-finite or negative amount. `NaN` is the case worth naming. Every comparison against it is false, so a version without the guard falls through to `allowed: true` from a silent arithmetic failure, which is the worst available outcome for a spend check and is exactly the failure shape this repository keeps finding.

### The adapter seam

Written **before** any executor calls it. If the seam had arrived with the first real provider, that provider's shape would have become the interface and the second provider would be the one that had to bend. It also means slices 2 through 5 are testable without an ad account.

Two properties are load-bearing:

- **Every mutating method takes the idempotency key in its signature.** Not an options bag, not a field on the spec. Rules 9 and 12 require a key on every external side effect, and the way to make that unforgettable is a type that will not compile without one. The durable half is `ad_entities.idempotency_key`, unique in Postgres, so a retried publish collides there rather than creating a second ad.
- **`policy_rejected` is an error kind, not a throw.** A rejection that arrives as an exception is caught by whatever catches transport failures and retried, which is precisely the silently-keep-spending path the guardrail above forbids. As a value, the caller has to decide.

`AdapterError` is discriminated by `kind`, and the kinds are chosen by **what the caller should do**: retry the same call (`rate_limited`), reconnect (`auth_expired`), revise and re-approve (`policy_rejected`), or stop (`invalid_spec`, `not_found`). Transport failures still throw, because flattening them in would make "the network is down" and "your ad was rejected" the same shape.

### The provider registry

A checked-in `Record<string, () => AdChannelAdapter>`, in the words `crawl-registry.ts` already uses for the same decision: every entry is a claim that somebody reviewed what this adapter does with a person's ad account and their money, and **a file gets reviewed in a diff by a person; a row does not.** `channel_connections.provider` is plain `text` validated against this map, which is why the column carries no enum: the authority is the file, and a second copy in the database would be a second thing to keep in step.

**An unknown provider raises.** It never falls back to the fake and never returns undefined for a caller to ignore. Falling back would be the worst available failure on this path: the executor reports success, the row carries a `fake:` external id, the audit trail says the campaign went live, and nothing reached any platform.

Only `fake` is registered today. It is a **provider**, not a channel, which is why `marketing_channel` has no `fake` value. It derives external ids from the idempotency key (`fake:` plus twelve hex characters of its sha256), reports a repeated key as `alreadyExisted`, uses no clock and no randomness, and returns `policy_rejected` for any spec containing the string `POLICY_VIOLATION`. That last one is a deliberate lever: slice 3 has to prove an ad-policy rejection routes to revise-and-re-approve rather than into the retry loop, and proving it means being able to cause one on demand.

## Guardrails (marketing-specific)

- **Spend caps** per campaign/project in tool code (`checkSpendCap` in `packages/marketing`, composing `projects.budget_ceiling` with the caps already committed to sibling campaigns); auto-pause on CPA/ROAS ceiling breach.
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
