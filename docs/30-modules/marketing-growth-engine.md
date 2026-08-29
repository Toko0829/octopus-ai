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

`@octopus/contracts` became a dependency with the campaign card, and exactly one type moved: **`MarketingChannel`**, which the card payload carries, the action route reads back and the project panel renders, so it finally has a boundary to share. `adapter.ts` re-exports it rather than declaring a second copy, because two enums that must agree are two enums that can disagree, and this one is checked against a Postgres enum on one side and a card payload on the other. `CreateCampaignSpec` and the rest of the seam still face an adapter rather than a wire and stay here; moving them now would be the unused edge rule 20 asks us not to add.

| File                    | What it decides                                                                  |
| ----------------------- | -------------------------------------------------------------------------------- |
| `spend.ts`              | `checkSpendCap`: may this campaign be authorised for this amount                 |
| `publish.ts`            | The publish key, which account publishes, and what to do about the answer        |
| `adapter.ts`            | `AdChannelAdapter`, the seam every platform sits behind, and its Zod I/O shapes  |
| `fake-adapter.ts`       | A complete deterministic implementation of that seam, with no platform behind it |
| `adapter-registry.ts`   | Which providers exist, checked in rather than stored                             |
| `auth.ts`               | `ChannelAuthProvider`, the seam an account connection sits behind                |
| `fake-auth-provider.ts` | A deterministic implementation of it, whose consent screen is our own page       |
| `fake-consent-code.ts`  | The code format, dependency-free because the consent screen runs in a browser    |
| `auth-registry.ts`      | Which providers may be connected, plus `carriesRealCredentials`                  |
| `scopes.ts`             | `checkScopes`: may this connection do the thing about to be attempted            |

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

| Entity                 | Status                                                                                                 | Notes                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `campaigns`            | ✅ live `20260829120000`, **written by `materialise_campaign` `20260829140000`**                       | One channel, one authorised cap, one lifecycle. `budget_cap` NULL means nothing authorised, never unlimited        |
| `channel_connections`  | ✅ live `20260829121000`, **written by the connect flow**                                              | OAuth tokens, **room-scoped**. No client policy and no client grant: RLS filters rows, not columns                 |
| `ad_entities`          | ✅ live `20260829122000`, **written by the publish sweep** (`20260829150000` adds its lifecycle guard) | The campaign → ad_set → ad tree. `rejected` is entity-level; `spec` is the approved brief the publisher reads      |
| `campaign_outcomes`    | ✅ live `20260829123000`                                                                               | Measured performance. Append-only including for `service_role`; a correction is a new row with `source = 'manual'` |
| `content_items`        | ⏳ deferred (slice 6+)                                                                                 | Needs a producer first. A schema with no writer is this repository's most-documented defect class                  |
| `creative_assets`      | ⏳ deferred (slice 6+)                                                                                 | Lands with the creative-provider ADR and the first byte-producer; until then creative arrives as a file artifact   |
| `email_sequences`      | ⏳ deferred (slice 6+)                                                                                 | —                                                                                                                  |
| `landing_pages`        | ⏳ deferred (slice 6+)                                                                                 | —                                                                                                                  |
| `creative_performance` | ⏳ deferred (slice 6+)                                                                                 | Depends on `creative_assets` existing to attach to                                                                 |

**Three of the four have writers now. `campaign_outcomes` still does not, and that remains deliberate**: the metrics puller is the next slice, and it is the writer that closes the auto-optimize loop. Guards land with their tables here because the recorded failure in this repository is the other order: `tasks.risk_tier` was unreachable for its entire life, and `task_deps` held no row for two weeks while enforcing an empty set.

`ad_entities` is the case where that ordering paid out and then asked for something back. Its hierarchy guard needed no adjustment when the writer arrived, which is the outcome guards-before-writers exists to produce. Its **lifecycle** guard did not exist at all, because in `20260829122000` there was no writer whose transitions could be wrong, so `20260829150000` lands it in the same change as the first writer rather than after it. The same migration makes `external_id` write-once, which had been a column comment since the day the table was created.

## Connecting a channel account

The second dead end of the same shape the campaign card closed, one tool over.
`risk.py` clamps on `connect`, `authorise` and `credentials`, so a step reading
"connect your Meta ad account" becomes `high_risk` and `routeTask` parks it at
`needs_user`. `produceCampaignCards` then asks the reasoning core, which
correctly declines because an account connection is not a campaign, and logs
that the step "stays with the owner". The owner was told a step needed them and
given nowhere to go. There is somewhere now.

**The surface is the project panel, not a card, and that is a decision.**
Connections are **room-scoped on purpose**: one ad account serves every project
in a workspace, so a per-task card would mean re-authorising the same account for
every goal somebody posts. It is the wrong shape a second time as well. Every
card in this product is approve-or-reject where approving commits through one
function, and approving a connection cannot commit anything, because the
credential does not exist until after a redirect round trip. A card whose state
advanced from somewhere other than the action route would give `action_embeds` a
second set of semantics for one component. So `ConnectedAccounts` sits in the
panel, above the project list, and the action route needs no change: its
allow-list already refuses any component it does not know.

**The callback lands on the web origin** ([ADR-0012](../40-adr/0012-oauth-callback-on-the-web-origin.md)).
A platform redirects a browser, and that browser carries the person's session, so
the party finishing the flow is provably the signed-in user and the signed
`state` can be bound to them. Terminating at Fastify would have created the only
unauthenticated mutating route in the system, holding one HMAC and writing to the
one table with no RLS behind it.

**The state is signed, not stored.** `lib/oauth-state.ts` HMACs the room, the
user, the provider, the channel, an expiry and a nonce. No `oauth_states` table:
a row written by one request, read by one other and dead ten minutes later is a
schema whose only reader is itself, which is the defect class this repository has
paid for twice. What that costs is replay inside the TTL, which is bounded by the
authorisation code being single-use at the provider and by
`unique (room_id, provider, external_account_id)` turning a second successful
exchange into an update rather than a rival row. That trade is written into the
file rather than assumed.

**The projection is the entire control.** `channel_connections` has no grant to
`authenticated`, so unlike every other read in this codebase this one cannot run
as the caller and cannot rely on RLS. Membership is established first by reading
the room as the caller, and only then does a service-role client touch the table
through `lib/connections.ts`, whose column list omits both token columns. That
list is asserted directly in the tests, because a `select *` written while
debugging would be a silent, total credential leak to every member of the room.

**Disconnecting is a revocation, not a delete.** `status = 'revoked'` with both
token columns nulled: "this account was connected on this date, by this person"
is audit trail worth keeping and the credential is not.

### `packages/marketing` grew a second seam

`ChannelAuthProvider` (`auth.ts`) is separate from `AdChannelAdapter` because the
two change for different reasons: a platform can rewrite its campaign API without
touching its OAuth endpoints, and can move to a new consent flow without changing
one ad call. It is written before any real provider for the same reason the ad
seam was, and `AuthError` extends `AdapterError`'s kinds with `access_denied`,
which is modelled as a value rather than a throw because somebody declining on a
consent screen is an ordinary outcome of asking.

`checkScopes` (`scopes.ts`) is rule 7 applied to permission rather than to money,
and it makes real the promise `granted_scopes` was created with: tool code checks
a needed scope before the call rather than learning it from a 403. Status
outranks scopes, so a revoked connection does not send somebody to grant a
permission they already granted.

**`auth-registry.ts` carries one field its sibling does not.**
`carriesRealCredentials` is the enforced half of the plaintext-token accepted
risk, and `writeConnection` refuses on it. What was a sentence in
[security-compliance.md](../10-architecture/security-compliance.md) is now a
failing write, so the first person to add Meta hits it before their token reaches
a plain column rather than after.

**The fake's consent screen is a page in our own web app.** That colocation is
honest rather than a shortcut: this provider is not pretending to be a platform,
it is how the whole three-legged round trip, including a person clicking Cancel,
is exercisable without an account anywhere. Its scopes are tickable, because a
platform grants what it chooses rather than what was asked, and a fake that
always granted everything would leave `checkScopes` exercised only by unit tests.

## The campaign card

The first surface in this product whose approval commits money, and the reason it
exists at all is a dead end. `create_campaign` is `high_risk`, so `routeTask`'s
first rule parks the step at `needs_user` whatever the planner proposed. Before
this, that was where it stopped: `notifyWaiting` told the owner a step needed
them, and there was **no surface on which they could say yes to a campaign**. The
plan card is the authorisation boundary this system already uses, and this is the
same boundary applied to spend.

**Which steps get a card is decided by the router's own verdict.** `campaignCandidates`
takes the tick's results where the outcome is `needs_user` **and** the rule that
fired is `high_risk_needs_authorisation`. Every `TickResult` already carries the
rule, so Node needs no vocabulary list of its own and cannot drift from the one in
`risk.py` that raised the tier. Whether the step is actually a campaign, rather
than an account connection or a publish, is the reasoning core's call: `/campaign`
is expected to decline and does so for most steps it is asked about. A decline
costs nothing, since the step is already announced as needing the owner; a wrong
card asks somebody to authorise spend on a channel nobody chose.

**The model never proposes a budget.** `ProposeCampaignProposal` has no budget
field on either side of the wire, `draft_campaign` strips budget-shaped keys
before validation, and `campaignEmbedPayload` sets `budgetCap: null`
unconditionally with no parameter for it. The owner types the cap on the card, and
the action route writes their number into the payload in the same statement that
records the verdict, so the card the flywheel stores and the payload the writer
reads both carry the figure a person actually entered. Argued in
[ADR-0011](../40-adr/0011-spend-cap-checked-twice.md); the short version is that
once both are `budget_cap` on a row, a number a model invented and a number a
person authorised are indistinguishable, and this is the surface where that
difference is the entire point.

**The spend cap is enforced at two points**, and neither is redundant. The
approval route refuses readably with the verdict's own sentence and leaves the
card `pending`, so a smaller figure can be entered against the same card;
`materialise_campaign` re-checks under a row lock, because two cards approved in
the same instant both pass a check made in the API. The IO stays in `apps/api`
(`readSpendInputs`) and the arithmetic stays in `packages/marketing`
(`checkSpendCap`), which is the split this doc already required.

**Approving closes the step.** The campaign is what the step was for, so the
writer moves the task `needs_user -> approved` and the scheduler ticks
immediately, which is what lets anything depending on it become ready. The
transition is conditional and never raises: a step that moved while the card sat
there still yields a campaign, and the skip is recorded in the event rather than
being silent.

**Approving publishes it** ([ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)).
The campaign lands at `ready`, and the next ticker pass sends it. There is no
second button, because the card already named the channel, stated the objective
and made the owner type a cap: a second control would ask a question that was
answered, and a confirmation carrying no new information is one people learn to
click through, which weakens every other confirmation in the product.

That changed four sentences that used to promise the opposite, and they were
changed in the same commit rather than left to drift: the card's own pending and
approved copy, the approval reply in the room, and the connect callback's "Octopus
will ask you before anything uses this connection", which stopped being true the
moment connecting an account could unblock a campaign already approved and
waiting. A promise on a trust surface is altered where it was made.

## Publishing a campaign

The first code in this product that acts outside it. `publishSweep`
(`apps/api/src/lib/publish.ts`) runs on the ticker pass, after the DAG walk and
**before** the crawl, because a person is waiting on a publish and nobody is
waiting on a regulator's page being re-read.

**It publishes one entity, and the limit is named rather than implied.**
`createCampaign` only: one `ad_entities` row of `kind = 'campaign'`, the root of
the tree. No ad sets and no ads, because `CreateAdSpec` requires creative and
nothing produces creative until slice 6, and an ad set with no ad under it spends
nothing and shows nothing. `setBudget` is not called either, since
`CreateCampaignSpec.budgetCap` already carries the authorised cap into the create.

**The ordering is the crash-safety story, and it exists because Postgres has no
transaction across a call to somebody else's API.** The intent row is written
first, at `publishing`, under a key derived from the campaign id alone
(`publish:<campaignId>:campaign`). Call the platform first and a crash before the
write leaves an object nothing points at: no id, no way to pause it, and a second
one created on the next pass. A record of an uncertain request is recoverable; an
unrecorded certain one is not.

Every gap between two writes resumes, and each has a test that starts from the
state that gap leaves behind:

| Crash point                   | What the next pass does                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| after the intent row          | the key collides, the row is read back, resume                                                      |
| after `ready -> publishing`   | the campaign is selected again, at `publishing`                                                     |
| after the platform answered   | the same key is asked again; the provider returns the same id and reports `alreadyExisted`          |
| after the entity was finished | `external_id` is present, so the adapter is **not called at all** and only the campaign is finished |

**Which account publishes is a decision, not a lookup.** Connections are
room-scoped and a room may hold several for one channel, so `chooseConnection`
takes the newest active one whose provider the registry knows. It deliberately
returns a **non-active** connection when that is all there is, because refusing
with "no account connected" when one exists and expired sends somebody to do a
thing they already did. `checkScopes` then produces the sentence that actually
unblocks them, and this is that function's first caller: rule 7 says the
permission is checked in tool code before the call rather than learned from a 403.

**The failure map is chosen by what the owner should do**, and it matters because
`campaigns.failed` is terminal with no retry arc:

| The platform said                 | Campaign           | Entity                  | The owner is told                                                |
| --------------------------------- | ------------------ | ----------------------- | ---------------------------------------------------------------- |
| it worked                         | `live`             | `live`, id written once | it is live, and the cap it will not exceed                       |
| `policy_rejected`                 | `failed`           | `rejected`              | the platform's own words, and that trying again means a new card |
| `invalid_spec` / `not_found`      | `failed`           | `failed`                | that this is a fault on our side                                 |
| `auth_expired`                    | stays `publishing` | stays `publishing`      | to reconnect; the connection is marked `expired`                 |
| `rate_limited` / `provider_error` | stays `publishing` | stays `publishing`      | nothing                                                          |
| a transport throw                 | stays `publishing` | stays `publishing`      | nothing                                                          |

A policy rejection is terminal because retrying it unchanged asks the same
reviewer the same question, which is the silently-keep-spending path this module
forbids. A provider error is **not**, and the retry is deliberately unbounded at
tick cadence: a bound tripping on a transient outage would close a campaign
somebody authorised, and recovering costs them a new card and a re-typed budget.
Bounded backoff lands with the first real provider, where a failure distribution
exists to size it. `retryAfterMs` is logged and otherwise ignored for the same
reason: honouring it needs a persisted not-before column with no realistic writer
today.

Rate limits and provider errors say nothing in the room on purpose. Neither is
owner-actionable, and a message every thirty seconds about a condition that fixes
itself is noise on the surface where the important messages live. They are logged
and counted in the sweep summary instead.

**Nothing else is dropped in silence.** Every campaign the sweep declines to
publish leaves a message in the room or a log line, and which one is asserted in
the tests. The blocked message keys on the campaign **and the rule**, so a
campaign blocked first on a missing account and later on a missing scope says both
things once, rather than the first thing forever.

**No token column is read.** The only registered provider takes no credential and
the seam has no credential-passing convention yet, so reading a secret to hand to
something that does not accept one would be handling it for no reason.
`readPublishableConnections` has its own column list, separate from the panel's
and asserted separately, because each list is independently the entire control.
Credential plumbing lands with the first real provider, in the same change as the
envelope encryption its accepted risk already names as the trigger.

**What is deliberately not built:** OpenTelemetry spans (none exist anywhere in
`apps/api`; rule 16 is met the way `crawlSweep` meets it, with one summary log per
sweep and a line per failure), a retry counter, an outbox table, and any rendering
of the ad tree in the project panel, which stays off `CampaignSummary` until there
is something under the root worth showing.

## Setting the budget ceiling

`projects.budget_ceiling` had existed since `20260813120000` with **no reader and
no writer anywhere in TypeScript**, so `checkSpendCap` composed a number nothing
could set and would have refused every campaign forever with
`no_ceiling_authorised`. That is the defect class this repository has now paid for
twice, and it is closed by `PATCH /api/projects/:projectId`: owner-only through
`resolveProjectOwner`, written with the service client because clients hold no
UPDATE grant on `projects`, and audited as `project.budget_set` with an explicit
`actor_id` (the `auth.uid()` idiom the SQL writers use reads null under the
service key, which would record a person's decision as the system's).

Clearing it is legal and deliberately narrow: `null` blocks every future campaign
approval and touches no campaign already authorised, because withdrawing
permission to commit more is not the same act as stopping spend already
committed. The project panel shows authorised, committed and available, computed
with the same two filters the approval uses.

The `budget_band` intake slot is **not** parsed into this number. It is free text
describing a range, not an authorisation of an amount.

## Campaign lifecycle

`draft → ready → publishing → live → paused → completed`, plus `cancelled` and `failed`. Enforced by trigger in Postgres (`private.guard_campaign_transition`), which also writes the `campaign.transitioned` audit event, so a transition cannot be recorded without having happened and cannot happen without being recorded.

Two arcs are worth reading rather than skimming:

- **`publishing` is not `live`.** Claiming a campaign is live before the platform confirmed it would put an untrue sentence in the audit trail. Between the request and the confirmation the honest answer is "we asked", and that is a state.
- **`live → cancelled` does not exist.** A spending campaign is paused first. Stopping the money and closing the record stay two acts with two events, so nobody can close a campaign and discover afterwards that it was still spending.

`pause_reason` (`kill_switch` | `cpa_breach` | `user` | `optimizer`) carries **why** spend stopped. The reason is data; the state is the same one however it was reached.

## Relationship to the north star

This module is the **first capability layer**. Later verticals (SMB local, e-commerce growth, then business-formation) are added as sibling capability modules reusing the same orchestrator, workflow engine, marketplace, chat, payments, and flywheel — see [roadmap.md](../10-architecture/roadmap.md).
