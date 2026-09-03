# Module: AI Orchestrator (Agent Runtime)

> The **business-operator brain**: a durable, supervisor-pattern agent that plans a task DAG, executes AI-capable steps via typed tools, grounds every step in RAG, enforces guardrails, and suspends on human waitpoints. The **single writer** to the task graph.
>
> **Owner paths:** `services/ai/**` (Python reasoning core + RAG), `apps/agent/**` (Node durable runner + tool execution), `packages/agent-tools/**` · **Depends on:** rag-knowledge, business-projects-workflow, chat-discord, human-nodes-marketplace, payments-billing, integrations.
>
> Update this doc on any change to the planning loop, tool registry, guardrails, escalation triggers, or state model.

> **Implementation status (Phase 1):** the **seam is live end to end, with a deliberately trivial core.** `services/ai` (FastAPI) exposes `GET /health` and `POST /plan`, returning typed **proposals**; `apps/api` exposes `POST /api/rooms/:roomId/agent-runs` which returns `202 + runId` and executes those proposals, posting to chat as `author_kind='agent'`. The agent is therefore a real chat member: its messages persist under RLS and reach clients over Realtime like anyone else's.
>
> **RAG is live and the core now answers from it.** `/plan` retrieves before it reasons and picks a core from the result:
>
> - **`grounded-plan-v1`** — retrieval found in-scope sources, so the core returns a **structured full-funnel plan**: six fixed stages, up to three steps each, every step carrying an owner (AI / HUMAN / YOU) and the source indices it rests on. Node persists it as an `action_embeds` row and the chat renders it as the plan card.
> - **`grounded-v1`** — the sources were good but the model could not produce a valid plan, so the reply falls back to cited prose. This degrades **sideways, not down**: a cited paragraph is still worth posting. It never falls back to an ungrounded plan, which is why the fallback re-generates from the same sources rather than salvaging malformed JSON. **Two things now stand between a rejected plan and that paragraph, and both were paid for by a measured loss.** Run `b47781ca` ("get signups for bluelly.com, $3000, students") passed intake and retrieval, the model returned a fifteen-step plan, and Pydantic rejected the whole thing over six step ids one to three characters past `STEP_ID_PATTERN`'s 32 (`define-signup-event-and-cpa-ceiling`). The prompt had asked for a "readable" id and never stated a length. Both plans requested on that container went the same way; zero cards. So `parse_plan` now **normalises step ids before validation** (`plan_graph.normalise_step_ids`: lowercase, slug, truncate to 32, suffix a collision that truncation itself created, and rewrite every `depends_on` through the same map), the prompt states the limit, and a shape the normaliser cannot fix earns **exactly one corrective retry** with the validation error appended before prose. A provider error is not retried there, because `providers` already backs off on those. The prose fallback is **marked in code** with a first line saying the card could not be built, since an unmarked paragraph where a card was expected is a fallback the person cannot see. `reasoning_summary` records `(after 1 retry)`. The same normaliser runs on `add_step` ids in `/replan`. Pinned by `test_plan_parsing.py` (rules), `test_plan_retry.py` (control flow) and `test_replan.py`.
> - **`refusing-v0`** — nothing cleared the relevance threshold, so it declines to plan and says why. Retrieval failing or generation failing both degrade to this, never to an ungrounded answer.
> - **`refusing-ungrounded-v1`** — chunks cleared the threshold, and the **groundedness gate** judged that they do not actually answer the goal. This is the case a threshold cannot catch, because a rerank score ranks chunks within the corpus and says nothing about whether the corpus covers the question.
> - **`refusing-unverified-v1`** — the gate could not run. Kept distinct so the copy never tells a person their covered question is out of scope because a provider call failed.
>
> **The plan is validated, not trusted.** `parse_plan` normalises the six stages into fixed order (the model omits and reorders them, and a card silently showing four stages reads as "the plan has four parts" rather than "two stages had no sources"), range-checks every citation index (a step citing `[7]` when six sources were supplied is a hallucinated reference the reader cannot follow), and rejects an all-empty plan outright, since six empty stages is a refusal wearing a card's clothing and the refusal path says it far more clearly. Ten tests cover those failures because each one renders as a plausible-looking card.
>
> **A step also carries a risk tier, and the model does not get the last word on it.** `PlanStep.risk_tier` mirrors `public.task_risk_tier`, and the router refuses to auto-run a `high_risk` task whatever the plan said its owner was. The planner is asked for a tier **per step**, phrased as a question it can answer by looking at the one step in front of it: if this ran right now with nobody watching, what would it change outside this system? Then `risk.clamp_risk_tier` raises it where the step's own words commit to spending, publishing, connecting an account, or committing the person to somebody, and **it has no path that lowers a tier**.
>
> That split is the third time this project has met the same failure, and the first two are why it is drawn here rather than in the prompt. Decomposition was told "most goals need one or two stages" and took the north-star case from coverage 1.00 to 0.33. The groundedness gate was told "when unsure, answer false" and refused 0.36 of legitimate goals. A model answers a per-item question well and agrees-then-ignores a disposition, and rules 7 and 11 put authorisation in code for exactly that reason.
>
> **The clamp errs toward over-restricting, and the cost of that is real rather than free.** A false positive is one user touch, which `vision.md` counts as a guardrail to drive down; a false negative is the AI spending somebody's money unattended. So a match raises the tier. One pattern is narrowed against that grain: `launch` fires only in verb position, because "launch the campaign" is the act while "the launch ads" and "launch week" are ordinary drafting, and matching the bare word clamped every drafting step in the creative stage. A card whose every step demands approval teaches people to approve without reading, which costs more safety than it buys. The determiner-less imperative ("launch ads on Meta") is a known miss, recorded in `risk.py` and pinned by a test rather than papered over; the phrasings that reach the act in practice are caught by `publish` and `go live`.
>
> Steps also carry up to three `acceptance_criteria`: short statements a reader could check against the finished work. Nothing consumes them yet. They exist now because the marketplace's maker-checker validates a node's proof against them, and generating them alongside the step is far cheaper than backfilling criteria for work already done.
>
> **The planner now states dependencies**, which is what turned the task DAG from a flat list into a graph (`20260828120000`). Each step gets an `id` and a `depends_on` naming the steps whose output it consumes, and the prompt is explicit that coming later in the funnel is not a dependency and that an unsure edge should be left out: stage order is presentation, and an invented edge stops work for a reason nobody can trace, where a missing one merely lets two things run at once.
>
> **`plan_graph.sanitise_dependencies` repairs rather than refuses, and the asymmetry with citations is the point.** `parse_plan` raises on an out-of-range citation, because an index the reader cannot follow is a false statement on the surface rule 10 protects. A dependency is the opposite trade, so a reference resolving to nothing is dropped, and a cycle or a duplicate id flattens the graph to the plan that would have shipped before this feature existed. Nothing about dependencies can cost somebody their plan. Every repair is returned as a problem string and logged, following the same rule `/execute` already follows when it drops a citation naming a source the maker was never given: the recurring defect here is never the drop, it is the silence around it. Postgres still raises on everything this repairs, because a card can also arrive from an older service or a hand edit. See [business-projects-workflow.md](business-projects-workflow.md).
>
> **`/replan` is live:** the "replan by diff, not regeneration" line below, finally with something behind it. It is handed the project's goal, the owner's reason for wanting a change, and the current DAG (Node's to own, so it travels in the request rather than being read), and returns `add_step` / `cancel_task` / `modify_task` ops. **Grounded like a plan rather than like a deliverable:** one retrieval for the goal and the reason together, then the groundedness gate, then the model cites per added step out of that pool. That is the planner's shape, not the executor's, and the distinction is what is being produced. A step is a proposal about what to do, which is what the planner makes; a deliverable is the work itself, which is why `/execute` re-retrieves narrowly. `sanitise_ops` then drops what cannot be applied, on `plan_graph`'s rule: a diff is several independent changes on one card, so one unusable op is dropped and the rest still ship. The exception is an op naming work that is already done, which is dropped rather than trimmed, because there is no smaller version of "cancel finished work" that is still the thing asked for. Two cores, `replan-diff-v1` and `refusing-unreplannable-v1`, and the refusal copy says plainly that the project is still running as it was, because "I could not change it" and "your project is stuck" are very different sentences.
>
> Verified end to end: "my cost per acquisition on Meta ads is too high" returns a cited plan drawn from the corpus, while "get a restaurant liquor licence in Tbilisi" is refused rather than invented. And a replan asked to drop paid ads in favour of SEO and email cancelled **both** the ad-copy step and the launch step that depended on it, added three steps citing only the SEO and email sources, depended one on an already-approved task by UUID and another on a sibling by card-local id, and proposed nothing against the finished step.
>
> **`/execute` is live (Phase 2):** one AI-owned task from an approved plan, drafted as a cited artifact or refused. Two cores, `executing-v1` and `refusing-unexecutable-v1`. It **re-retrieves for the step** rather than inheriting the plan's sources, because the sources that justified "you need positioning work" are broader than the ones that help write the positioning, and it runs through the **same groundedness gate**, applied where it matters more: by then a person has approved the plan, so ungrounded output stops looking like a suggestion and starts looking like delivered work. A third proposal kind, `write_artifact`, whose citations are source **labels** rather than indices, because the checker's job includes catching a source the maker was never given and an index is checkable for range but not for provenance. Citations naming a source that was not supplied are **dropped here rather than passed on**, since the checker escalates a fabricated one and turning a model slip into a human's problem is worse than letting the remaining grounding be judged on its merits. See [business-projects-workflow.md](business-projects-workflow.md) for the checker.
>
> **`/campaign` is live (Phase 2):** one step waiting on the owner's authorisation, drafted as a campaign the owner can approve, or declined. Two cores, `campaign-v1` and `declining-campaign-v1`. It takes the same request shape as `/execute` because the input is the same thing, one task retrieved for narrowly, and it exists because a `high_risk` step **never reaches `/execute` at all**: `routeTask` sends it to `needs_user`, and before this there was no surface on which a person could say yes to a campaign. **Declining is the expected answer and is a `post_message` rather than a card.** Node asks about every step the router stopped under `high_risk_needs_authorisation`, and most are not campaigns: connecting an ad account and publishing one post are both high-risk and neither is one. The decline copy says the step still needs the owner and that nothing has been spent, because it is not stuck and must not read as though it were. The groundedness gate applies, and matters more here than when planning: a card citing loosely-related sources is an invitation to authorise spend on a channel nothing recommended.
>
> **A fifth proposal kind, `propose_campaign`, and it has no budget field.** Not in the pydantic model, not in the Zod mirror, and `draft_campaign` strips budget-shaped keys before validation while the prompt forbids emitting one. The owner types the cap on the card. Once written, a number a model produced and a number a person authorised are the same `budget_cap` on the same row with the same audit trail, and this is the one surface where that difference is the entire point. Anyone adding the field later should read [ADR-0011](../40-adr/0011-spend-cap-checked-twice.md) first: it would remove the property silently and every test would still pass. The `budget_band` intake slot is deliberately not parsed into it either, being free text describing a range rather than an authorisation of an amount. Citations are 1-based indices like `PlanStep` rather than labels like `WriteArtifactProposal`, because this card renders its sources beside the claim, and an index pointing past the end is dropped rather than rendered as grounding that does not exist.
>
> **Two ordering rules came out of running it.** `brief` is matched before `copy`, because "Create a brief for 3 distinct paid hooks" hit `hooks?` under `copy` and returned five finished ad variants: the wrong artefact, and the wrong number. A step that says the word "brief" is asking to be briefed, so the explicit word beats the topic word. And **a count named in the step overrides the prompt's default**, because the plan is what the person approved and returning five where they approved three is the executor overruling them on the one detail they were specific about. Only 2 to 9, so a budget or an age range is never read as a count.
>
> **And it now knows who it is writing for.** The executor received the step and the sources and nothing else, so intake's slots reached the planner and died there. Measured on a real run where the person gave their audience: **4 of 15 plan steps mentioned it and 1 of 8 artifacts did**, that one only because the planner had written the word into a step title. The plan knew who it was for and the work did not, so a copy step produced ad copy aimed at a performance marketer rather than at the customer. `ExecuteRequest` now carries `context`, stored on the plan card (`PlanEmbedPayload.context`) so it needs no migration and stays inseparable from the plan it shaped, and rendered by the planner's own `build_context_block` so the two cannot drift on the rule. **That rule is the point: it may make the deliverable concrete, and it may never be cited.** A person's own budget is not a retrieved source, and attributing it to the corpus would be a false citation on the surface rule 10 exists to protect. It is deliberately absent from the retrieval query, pinned by a test, because putting the audience there is the defect this project has now measured twice. Absent context degrades to exactly the output that shipped before it existed.
>
> **The executor now writes the thing rather than an essay about the thing.** One prompt served every step, so "draft ad copy for cold traffic" and "sharpen the positioning" produced the same shape of output: prose describing the work, which a person then still had to do. `deliverable.py` classifies the step into `copy` / `landing` / `sequence` / `brief` / `analysis` and swaps the instruction half of the prompt; the shared half, which carries grounding, citation discipline and brand voice, is stated once and cannot drift per kind.
>
> **Classified from the step's own words, in code.** Not asked of the planner, because that would mean a schema field, a contract field, a migration and a card change to carry a string the step already contains, and the executor re-retrieves per step on exactly this reasoning: the step is the right unit and it is right there. Not asked of a model, following `risk.py`: a pattern table is inspectable, free, and identical between runs. If a kind ever genuinely cannot be read off the step, that is when the planner should state it.
>
> **Each instruction asks for a structure, never a quality.** "Write good copy" is a disposition, and this project has twice measured what a model does with those. "Five variants, each with a named angle, headline under 40 characters" is checkable, and it gives the critic's `too_short` rule something real to measure. `analysis` remains the default and is not a failure case: positioning and measurement steps genuinely are prose, and forcing those into a variant table would be the same defect pointed the other way.
>
> **`brief` says plainly that images are not generated yet**, because the artifact table is inline-text by design and images need Storage, a bucket policy and a provider. A brief a person or a generator can work from is honest; a claim to have made the image would not be. Measured against the live service: a copy step returned five distinct angles with headlines, primary text and CTAs, cited to three sources, naming what the corpus did not cover; a landing step returned hero-through-CTA sections from the same corpus.
>
> **`/intake` is live:** the playbook's step 1, which had been specified since Phase 0 and never built. A one-liner used to go straight to retrieval, so a vague goal was answered by whichever funnel stage ranked best and the person was never asked what would have made it answerable. It returns slots, two scores and the next batch of questions, and it is **stateless**: Node carries the slots between rounds, so multi-turn intake does not give this service the session or table ADR-0006 keeps out of it. See "Intake" below.
>
> **Durable, and on Postgres rather than on a vendor** ([ADR-0010](../40-adr/0010-postgres-durable-runner.md), amending ADR-0001). Trigger.dev was the Phase 0 pin and stayed blocked on credentials for the length of the project, while two later decisions quietly removed the problem it solves: ADR-0006 left **no continuation to preserve**, since the reasoning core is stateless and Node commits each step, and `20260813120000` put the state machine under trigger enforcement in the database. A run's progress is rows, so a crash loses a worker rather than a run. What was actually missing was narrow and is now built: a lease on `task_runs` so a dead worker is distinguishable from a slow one, a reclaim sweep, and a ticker holding a single claim. **A human waitpoint needed nothing at all**: a task in `escalated` or `needs_user` waits in a row at zero compute for as long as it takes, which is the property a durable engine sells and this architecture gets by construction. Verified: 11 API assertions plus a Realtime probe confirming the agent's message is broadcast to a subscribed member.

## Crawled sources (`POST /ingest`)

The shared-corpus counterpart to `/sources`. `apps/api` fetches a registered page
and hands over the text; this service chunks, embeds and supersedes it exactly as
it does anything else. Four external documents are live and the corpus now carries
a real publisher, a real URL and a read date on 42 of its 85 chunks.

**Why the split is a second endpoint rather than a flag.** `/sources` is
room-scoped and fixes its own label, authority and doc type, because everything
arriving there is a person describing their own business. A crawled regulator page
is a different trust claim with different metadata, and a request body whose
meaning depends on which optional fields are set is how two trust models end up
tangled in one handler.

**It trusts the caller for provenance and for nothing else.** `authority`,
`market` and `doc_type` come from a checked-in registry rather than being derived
from the URL, because whether a page is authoritative is an editorial judgement
and inferring it from a hostname is how a vendor blog becomes a regulator. The
text itself is untrusted (rule 8) and travels the same delimited SOURCES block as
the rest of the corpus. Unlike a room source there is no per-room blast radius,
which is exactly why the registry is an allow-list nobody can add to at runtime.

**`upsert_source` keys on url here and on label there**, and that asymmetry is
load-bearing. `knowledge_sources` is unique on url, so a crawled page is one row.
A workspace is one row holding many documents, so if its row were keyed by url,
somebody pasting a regulator's URL into their workspace would attach their
document to the regulator's source and, since identity is `(source_id, title)`,
supersede the regulator's text by reusing the title. `Ingestor.ingest` passes a
url to `upsert_source` only when nothing owns the document. The document keeps
its url in both regimes, so a citation stays openable either way.

**Fetching is not here, and that is the property rather than the arrangement.**
This service holds the secret key and reaches Postgres and model providers and
nothing else. A general-purpose fetcher inside it would widen exactly the
component that must not be reachable from a prompt. The guard, the size cap, the
timeout and the redirect re-vetting all live in `apps/api/src/lib/fetch-url.ts`
alongside the sweep that schedules them.

## Sources a workspace supplies (`POST /sources`)

`services/ai` ingests one document about the user's own business, scoped to their room, and `/plan` and `/execute` now pass that room into retrieval so it is blended with the shared corpus.

**It exists because the deliverables said so.** Every artifact closed by naming what it could not ground, and ad copy came back written about advertising rather than about the product. The pipeline was right and the knowledge was absent.

**Isolation is enforced here, not by RLS.** This service holds the secret key, which bypasses row-level security, so `owner_room_id` on the way in and `p_room_id` on the way out are the only things keeping one customer's product description out of another's ad copy. `supabase/tests/room_sources.sql` asserts it through the function rather than through a policy, for exactly that reason.

**Synchronous, where ADR-0006 says ingestion is job-driven.** One bounded document is seconds on a warm embedder, and Node accepts the request with 202 and calls this from a background continuation, so nobody waits. The ADR's concern is the request path, and the request path is Node's. There is no job runner in this service to hand it to; when one exists this moves.

The text is untrusted (rule 8) and reaches a prompt only inside the same delimited SOURCES block the corpus travels in. Its room scope bounds the blast radius of anything hostile inside it to the workspace that submitted it.

**What retrieval scoping does and does not buy, measured.** The source surfaces when a step's query is about the product and not when it is about method, which is the cross-encoder working rather than a fault. So a source sharpens the steps that ask about the business, while method steps still ground in principles. Making the product known to every step regardless of query belongs with `context`, which already carries the person's own facts into the prompt without pretending they were retrieved.

## Two-layer design

- **Durable execution backbone** (Postgres, [ADR-0010](../40-adr/0010-postgres-durable-runner.md)): state is rows under a trigger-enforced machine, a lease distinguishes a dead worker from a slow one, and a ticker walks the graph. It survives crashes and deploys, retries, and **waits for days at zero compute** on a task sitting in `escalated`, which is a waitpoint by construction rather than a primitive anyone had to buy. ADR-0001 pinned Trigger.dev for this and is amended; Trigger.dev and then Temporal remain the documented escape hatches.
- **Supervisor / orchestrator reasoning core**: the single writer to the task DAG. Spawns **ephemeral, read-only sub-agents as tools** (research, critique); they never write the DAG.

## Language & service boundary ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The **reasoning core runs in the Python AI service** (`services/ai`, FastAPI + LlamaIndex): planning, drafting, RAG retrieval, and **tool selection** (deciding _what_ to do). The **durable backbone stays in Node** (`apps/api`'s ticker today, `apps/agent` when it earns its own deployment): it drives the Python core per step, holds human waitpoints, and executes **all side-effecting tools** (`post_message`, `write_artifact`, escrow, `request_human_node`) in the Postgres/RLS/Stripe world. **Python proposes, Node executes** — so authz + spend caps stay in Node tool code, and a jailbroken prompt in the Python core still cannot move money.

## Planner / executor loop

- **Model tiering:** stronger model for planning + critic, faster model for executor steps, cheap model for classification/routing. Never a single hardcoded model.
- **Plan-then-act:** decompose the goal → RAG-grounded task DAG → dispatch READY tasks → execute → **maker-checker critic** validates against `acceptance_criteria` → reconcile.
- **Replan by diff, not regeneration:** after each task, reconcile the DAG with add/cancel/modify **diffs** — preserving completed work and audit history.

## Typed tool registry

Every tool is a Zod-typed function with a **risk tier**. Tools have **no ambient DB power** — they act through scoped Fastify endpoints.

| Tool                             | Risk tier  | Notes                                                                                                                                                                               |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rag_retrieve`                   | read-only  | hybrid pgvector search; returns cited, dated sources                                                                                                                                |
| `web_research`                   | external   | results are **untrusted data**, injection-quarantined                                                                                                                               |
| `source_suppliers`               | external   | structured supplier lookup                                                                                                                                                          |
| `compute_budget`                 | reversible | CapEx/OpEx model, illustrative projection                                                                                                                                           |
| `draft_branding`                 | reversible | naming/logo/menu/site briefs                                                                                                                                                        |
| `write_artifact`                 | reversible | to Supabase Storage                                                                                                                                                                 |
| `post_message`                   | reversible | writes to chat as the AI member                                                                                                                                                     |
| `fund_escrow` / `release_escrow` | high-risk  | spend caps + RBAC enforced **in tool code**; user approval required                                                                                                                 |
| `request_human_node`             | high-risk  | **not built.** The router parks the step at `escalated` and the owner sends it to the marketplace; the row is the waitpoint ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)) |

> **First-vertical tools:** the marketing growth engine adds typed, guardrailed tools — `generate_creative`, `draft_copy`, `connect_channel`, `create_campaign`/`create_ad_set`/`create_ad`, `publish_content`, `set_budget`, `pull_metrics`, `optimize_campaign` — all `high-risk` where they publish or spend (spend caps enforced in tool code). See [marketing-growth-engine.md](marketing-growth-engine.md).

## Intake, which runs before retrieval and does not use it

`POST /intake` implements step 1 of [full-funnel-creator.md](../60-playbooks/full-funnel-creator.md): turn a one-liner into ICP, offer, target metric, budget band and timeline. The slot names come from that playbook rather than being invented here, so the playbook stays the specification.

**It deliberately does not touch RAG.** What someone sells and who they sell it to is not in the corpus, it is in their head, so retrieving first would shape the questions around what we happen to have written down instead of around what they need. What intake produces is a better query for retrieval to then use.

**Two scores, and neither is the model's opinion of itself.**

| Score          | Question                                      | How it is computed                                           |
| -------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `completeness` | do we know enough to plan?                    | filled required slots / required slots                       |
| `proximity`    | how close is this to something we can ground? | touched stages that are in `COVERED_STAGES` / touched stages |

Both are arithmetic in code. The model is asked only for per-item judgements: what did this person state, which stages does this touch, what would you ask to fill this gap. **That split is the lesson this project has now learned twice.** A prompt asking for a disposition was agreed with and then ignored, in decomposition ("most goals need one or two stages", coverage 1.00 to 0.33) and again in the groundedness gate ("when unsure, answer false", false-refusal 0.36). A model scoring its own certainty is the same shape of question, and it would be unmeasurable in the same way.

`COVERED_STAGES` is imported from `decompose.py` rather than restated, because a second list of which stages have documents would drift the first time one is ingested. That has now happened once, in the useful direction: `measurement` joined the tuple when the corpus grew a measurement document, and a measurement-only request went from proximity 0.0 to 1.00 in both components at once because there is only one list.

**That flip is an intended product change and not a regression to put back.** A measurement-only goal used to be declined here before it cost a retrieval, and the case that justified it was the GA4 leak. What guards that leak now is the division of labour the whole design rests on rather than a coverage gap: `measurement-attribution.md` deliberately names no analytics platform, so "how do I set up conversion tracking in GA4" is a marketing question in the right field that the corpus still cannot answer, which makes it the **groundedness gate's** call. It remains in `scope_negatives` holding exactly that line.

**Requirements scale with breadth, and a narrow request requires nothing.** That is the important half: "my CPA on paid social is too high" is already answerable, and interrogating someone who asked a precise question is how an intake step becomes the reason people stop using the product. The breadth test is the one decomposition already uses and which was measured there. A whole-funnel request requires ICP, offer, target metric and budget band; timeline is collected when offered and never blocks.

**An empty stage list meant two opposite things, and telling a customer the wrong one is a false statement about what this product does.** Found by driving the product: "audit my websites SEO" came back `out_of_domain`, told the person it sat outside what we have sources for, and the corpus holds a document on early-stage SEO. "improve my SEO" scored proximity 0.75 against the same corpus and planned. One diagnostic verb was the whole difference.

`proximity` divides covered stages by touched stages and returns 0.0 when nothing is touched, so `near == 0.0` was true both when the model named stages of which none are covered, which is a finding about the request, and when it named no stage at all, which is the model failing to classify. Only the first says anything about the domain.

**Third occurrence in this module of absent being read as zero**, after "the model returned no questions" being read as "nothing left to ask", and after `is_request` had to be split from scope on exactly this argument. So the split is the same one again: `in_domain` is asked as its own per-item question, and the three answers are distinct. Not a request. A request from another field. A marketing request the stage judgement failed on, which **degrades to the path that existed before intake** rather than declining, because passing through grants nothing and the groundedness gate is the check qualified to answer whether the corpus supports it.

The prompt was the other half. Its `touched` rule ended "do not stretch to find a marketing reading of it", added to stop "help me open a cafe" marking every stage, and all three worked examples were about whether a **venture** eventually needs marketing. None covered diagnosing a channel the person already has, so an audit read as a technical job. It now says plainly that auditing, reviewing, checking or fixing an existing marketing surface is work in that surface's stage.

Measured against the live service, both directions, because a fix that only loosens is not a fix:

| goal                            | before          | after                             |
| ------------------------------- | --------------- | --------------------------------- |
| audit my websites SEO           | `out_of_domain` | `ready`, channels, proximity 1.00 |
| review my landing page          | not measured    | `ready`, conversion               |
| why are my ads not converting   | not measured    | `ready`, 2 stages                 |
| help me open a cafe in Austin   | `out_of_domain` | `out_of_domain`                   |
| fix the bug in my python script | not measured    | `out_of_domain`                   |

**What it does not fix, and this is the honest half.** With intake out of the way, `audit SEO for my website` reaches the groundedness gate and is refused as `refusing-ungrounded-v1`, while `get more organic search traffic` returns a full cited plan. That is the gate working, not a second bug: the corpus teaches how to **do** early-stage SEO and contains nothing about auditing an existing site, and a workspace source describing the business is not the same as having crawled its pages. The refusal is now specific and correct where it used to be a false claim about scope.

**Four outcomes, because two were not enough and the shortfall was visible on the first surface anyone touches.** The first version had a single `out_of_scope`, and "Hello" came back as "what you have described sits outside full-funnel digital marketing". A greeting is not a request that is out of scope. It is not a request.

| Outcome         | What it means                          | What the caller does                                                     |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `ready`         | enough is known                        | plan on `refined_goal`                                                   |
| `needs_detail`  | in scope, too vague                    | ask one batch of slot questions                                          |
| `not_a_request` | a greeting, a fragment, small talk     | open the conversation: what are you trying to grow                       |
| `out_of_domain` | a real request, another field entirely | name what is not on offer, then ask whether a growth goal sits inside it |

The last two both leave the conversation open rather than ending it, and they are separate because **the words differ where the mechanism does not**. A greeting has nothing to decline. A request from another field has something to decline, and the decline has to come **before** the question, or the question is a way of keeping someone talking rather than an honest redirect. Someone opening a cafe cannot be helped to open it, and may well want customers through its door, which is work this system does.

**Neither reply opens a card, and nothing counts stalls any more.** Both used to write a card `awaiting: 'goal'` so the room's next message would replace the goal rather than be filed as an answer, and a stall counter capped how long that could go on. That machinery existed only because a pending card claimed the room's next message. It does not now: every chat message is a goal, so a greeting is answered with the opener, an out-of-domain request with the redirect, and whatever the person types next is simply run. Somebody who says hello twice gets the opener twice, which is the honest behaviour of a system that replies to what it is sent.

**Intake can block and can never authorise.** It stops a plainly out-of-domain request before it costs a retrieval. The converse does not hold: an intake that finishes says nothing about whether the corpus can ground an answer, and the **groundedness gate still runs exactly as before**. Non-zero proximity means "in the right field", which is precisely the property the measured leaks in [rag-knowledge.md](rag-knowledge.md) also have. Same rule decomposition carries, worded the same way: additive to grounding, never a source of it.

**User-facing copy is templated in the API, not generated.** `planner.py` already templates its refusals for the same reason: brand voice is an enforced rule (no em dashes, no hype, rule 22) and a generated sentence is one prompt drift away from breaking it on a trust surface. The model classifies; the words are ours.

**Rounds are capped at two, and that is a product decision rather than a measurement.** [vision.md](../00-overview/vision.md) makes user-touch-count per result a guardrail to drive down and this doc requires user-only facts to be raised as a single batched question, so a tree of one-question-at-a-time turns would satisfy the module and violate the product. Questions go out on one card of at most four, ordered by the required list. An intake that ends incomplete produces a thinner plan, which the card renders as visibly empty stages, and that is a better outcome than a third round.

**Asking no longer delays the plan, and the workspace answers first.** `needs_detail` used to end the run at the card. Node now posts the card and plans in the same run from `refined_goal` and the slots intake already has, so the person sees a plan with visibly empty stages beside the questions instead of an interview, and a finished card runs intake again with `round + 1` and the merged slots: the result supersedes a plan nobody approved, or becomes a replan diff for one that is running. Before round 0 Node hands this service what the room already knows, `room_profiles` (audience, offer, budget band, timeline) as `stated` slots, so a whole-funnel goal in a room that has answered before is `ready` without a question. That seeding is what forced the one change here: `merge_slots` now lets a **newer stated value replace an older stated one**, since a budget band stored last month must not beat the one typed into today's goal, and an answer on the card must be able to correct the round before. An inference still never overwrites a statement.

**The batch is one card, and the answers are one act each.** The questions used to go out as plain text and come back as one chat message, which this service parsed into slots from the `answers` list. They come back as `slots` now: the card in `apps/web` writes each answer as a `stated` slot through the embed action route (chips for the budget band and the timeline, a short field for the rest), Node hands the card's slots to `/intake` with `round + 1`, and `answers` arrives empty. This service did not change for that, which is the point of having kept it stateless: `merge_slots` already treats an incoming stated slot as the person's word, `completeness` already counts keys whatever their source, and `select_questions` already skips what is filled. The `answers` field stays in the contract for a caller that still has sentences to hand over.

**Failure degrades to the path that existed before it.** Any error, malformed JSON included, proceeds on the original goal rather than refusing: intake improves a query, it is not a precondition for answering, and letting an optional step take down a working path is the trade `decompose` already refused. Passing through grants nothing downstream, which is what makes it safe.

**And the prompt asking for that was not enough, which is now measured twice over.** A real goal produced `refined_goal: "get student sign-ups via website promotion"` with the audience word still in it, and it returned `refusing-v0`: 25 candidates, none above the threshold. Removing that one word returned a grounded plan from the same corpus. `INTAKE_PROMPT` already asked for exactly this and gave `travelers` as the worked example; the model complied on the example it was shown and not on a new one. **Third occurrence of the shape, so it gets the same answer as the other two: the rule moved into code.** `strip_particulars` removes the `icp` words, anything containing a digit, and anything containing a dot, after parsing.

**Its first version over-reached, and the way it failed is worth keeping.** It also drew particulars from `offer`, so "Website bluelly.com sign-ups" contributed `sign`, `ups` and `website`; stripping then removed the audience **and** the metric, left two content words, tripped the minimum-length guard, and returned the polluted original unchanged. The guard against gutting the query was what preserved the pollution. The measurement had already ruled it out, since "get sign-ups via website promotion" retrieves perfectly well. `icp` was the whole poison, so `icp` is the whole rule.

**Then length turned out to matter more than any of it.** With the query clean, `"get sign-ups for a new website via paid acquisition"` **still refused**, and four phrasings of one intent against one corpus isolated why:

| query                                               | words | result        |
| --------------------------------------------------- | ----: | ------------- |
| get sign-ups for a new website via paid acquisition |     9 | `refusing-v0` |
| get sign-ups from paid acquisition                  |     5 | grounded      |
| get signups from paid acquisition                   |     5 | grounded      |
| paid acquisition for a new website                  |     6 | grounded      |

Hyphenation did not decide it and neither did the wording. This is ADR-0009's finding arriving in production: a cross-encoder dilutes on long queries, and with the local threshold's margin at **1.76x** a few extra words is the whole distance. It is fatal rather than merely worse because **decomposition is additive to grounding**: the goal is searched first and the sub-queries are abandoned if it returns nothing, so a diluted goal takes the plan down before decomposition can help. The failing query drew 25 candidates where the others drew 150. `MAX_REFINED_GOAL_WORDS` is 7, matching the 7.1-word mean ADR-0009 measured, enforced in code and asked for in the prompt; function words are dropped before truncation, since they carry no signal at a cross-encoder. Verified end to end on the goal that failed: `"promote website to get signups"` now returns a six-stage plan with all six stages populated.

**The goal searches; the slots tailor. They must not be the same string.** `refined_goal` is a short practitioner search query, and the person's audience, budget, product name and numbers are deliberately kept out of it. They reach the **planner** instead, as a `context` block it may use to make steps concrete and may never cite.

That separation is measured, not tidy. Folding them in produced "Get signups for travelers with a $2000/month budget", and isolating one variable at a time showed why it failed: "Get signups for my website." plans fine, "Get signups with a $2000/month budget." also passes, so the number was never the problem, and **"Get signups for travelers." retrieves nothing at all**. A niche audience word dominates a short query at a cross-encoder and appears nowhere in a corpus of marketing principles, so the score drops under the threshold. In a longer phrasing enough marketing vocabulary survives for chunks to clear it, and then the groundedness gate refuses, reading the person's own audience as a topic the sources are obliged to cover. One word, two failures, two stages. **The fix deliberately does not touch the gate:** it was judging a polluted input correctly.

**The plan call needs its own token budget**, and this is the other thing that split. `generation_max_tokens` was one number shared by decomposition, the gate, the plan and the executor, and the gpt-5 family counts reasoning tokens against it. At 900 the plan JSON came back truncated, `parse_plan` rejected it, and the core degraded to cited prose exactly as designed, so a whole-funnel goal produced **no plan card at all** and nothing reported a fault. Measured: 4101 characters and "EOF while parsing a string" at 900, 4311 characters and valid at 4000. `generation_max_tokens_long` now covers the two calls that write something long.

**The refined goal stays short on purpose.** It is reranked like any other query, and ADR-0009 measured sub-query length falling from 20-30 words to a 7.1-word mean as a quality fix rather than only a cost one. Pasting every slot into it would undo that, so it is a restatement capped at 200 characters, not a summary of the intake.

### Measured against the live service

| Input                                        | Outcome         | Stages touched | Questions |
| -------------------------------------------- | --------------- | -------------: | --------: |
| "Hello"                                      | `not_a_request` |              0 |    opener |
| "help me open a cafe in Austin"              | `out_of_domain` |              0 |  redirect |
| "get me my first 100 customers"              | `needs_detail`  |              6 |         3 |
| "get me customers for my cafe"               | `needs_detail`  |              6 |         3 |
| "my CPA on facebook ads keeps climbing"      | `ready`         |              1 |         0 |
| "how do I set up conversion tracking in GA4" | `ready`         |              2 |         0 |

The last row is intake behaving correctly rather than leaking. GA4 tracking is a marketing question in marketing words, so it is in the right field and intake has no business refusing it; it is the **groundedness gate** that catches it, which is the division of labour this whole design rests on. Rows three and four are the pair worth keeping: the north-star case still asks rather than guessing, and the cafe splits correctly depending on whether the person is asking to open one or to fill one.

**Two defects were found by running this, and one of them was introduced by the fix above.** Adding `is_request` loosened the stage judgement, and "help me open a cafe" came back `ready` with all six stages, because the model reasoned that a cafe will eventually need marketing. True, and not what was asked. `touched` now asks **what the person is requesting** rather than what their venture will one day need, with both cafe phrasings given as the worked example. Separately, "the model returned no questions" was being read as "there is nothing left to ask", so a request with every required slot empty reported itself complete and planned; the two are now distinguished and the second is logged as a model failure while still proceeding, since we cannot ask what we were not given.

## The retrieval pipeline (`services/ai`)

`goal -> decompose -> per-sub-query [embed -> RRF in Postgres -> rerank -> drop below threshold] -> merge survivors -> groundedness gate`

- **The threshold ranks; the gate decides scope. They are different questions and only one of them is answerable by a number.** A rerank score says which chunk fits best, and that always has an answer when the query is marketing and the corpus is marketing. Measured on the golden set, an in-vocabulary but uncovered question ("how do I set up conversion tracking in GA4") scores **0.0211** against a **0.0013** threshold, while the legitimate broad goal the product is built around tops out at **0.0018**. The bands overlap by 12x on the local reranker and 4.8x on Cohere, so no threshold separates them, and raising it kills the north-star goal first.

  So `groundedness.assess` asks a model, once per goal on the cheap tier, whether the retrieved sources answer the question. It **fails closed**: a provider failure, malformed JSON, or a non-boolean `supported` all block, on the same asymmetry the eval applies (a miss is unhelpful but safe, a leak is not). It judges the **same sources block the planner will receive**, so it cannot approve one thing while the planner grounds in another. And it runs **before** generation rather than filtering its output, because a plan that is written and then discarded has already cost the call and is one refactor away from being displayed.

  It is measured by `--gate` against `scope_negatives`, which is a credentialed pass and not a CI gate ([rag-knowledge.md](rag-knowledge.md)). That pass scores the **false-refusal rate too**, because a gate measured only on what it should refuse scores perfectly by refusing everything. **That is not a hypothetical: the first measured run blocked 1.00 of uncovered questions and refused 0.36 of legitimate ones**, including two goals with a dedicated corpus document and the product's own north-star example. A one-sided measurement would have reported a perfect score and shipped it.

  **The cause is worth remembering because it is the second occurrence.** The prompt asked the model for a disposition ("be strict about adjacent sources", "when unsure, answer false") rather than a test, and it complied by refusing things it had just described as covered. ADR-0009 records the same shape in decomposition, where "most goals need one or two stages" took that same north-star case from coverage 1.00 to 0.33. The fix both times is to replace the disposition with something checkable: here, "could you write concrete steps quoting only these sources?", plus a rule that a refusal must name what is missing or it is not a refusal.

- **Decomposition is additive to grounding, never a source of it.** The goal is searched first, and if it retrieves nothing the sub-queries are abandoned. Without that gate the golden set caught a live leak: "how to get a car licence" decomposed into plausible marketing sub-queries, each of which legitimately retrieved marketing content and cleared the threshold, leaving the agent with cited sources for a question the corpus cannot answer. That is the exact failure the groundedness gate exists to prevent.

- **One rerank per sub-query, and the cheaper design was measured before being rejected.** Searching every sub-query but reranking once against the original goal changed nothing at all: candidate breadth was never the bottleneck (40 candidates against a ~43-chunk corpus). The bottleneck is the rerank, where a vague goal scores 0.066 against chunks a focused query scores 0.474 on. Coverage of a broad goal went 0.33 to 1.00 once each sub-query was scored on its own terms. The cost is real: N rerank calls per plan, which makes a production rerank key a prerequisite, and MRR fell 0.95 to 0.76 because merging survivors pushes the single best chunk down the list.

- **Fusion happens in SQL, not Python.** `public.hybrid_search` runs both candidate lists and the RRF merge in one query, so the network carries the final top-N instead of two candidate lists. RRF is rank-based, which is the point: cosine distance and `ts_rank_cd` are not comparable quantities and would need normalising otherwise.
- **The threshold is calibrated, not guessed, and it is now measured rather than assumed.** Originally set from the four-document seed corpus. Re-measured against the ten-document corpus on bge-m3 via the golden set: true positives score **0.127 to 0.637** and out-of-scope queries do not clear `0.05` at all, so the separation survived the corpus tripling and the embedder changing. Cohere's scores are corpus-dependent, so this stays something to re-measure rather than trust; `python -m octopus_ai.evaluation` is how ([rag-knowledge.md](rag-knowledge.md)).

  A caution learned here: an in-scope query dropping nothing is **correct**, not evidence the threshold stopped working. Reading "0 below threshold" on covered questions as a filtering failure led to a wrong conclusion that the eval then disproved. Judge the threshold on out-of-scope queries, which is exactly what the golden set's negative half is for.

- **Weak chunks are dropped, never used as padding.** Handing a model six loosely related paragraphs is how confident, wrong, "grounded" answers get produced.

- **Every candidate is recorded with the score that dropped it.** `RetrievalResult.scored` carries one `ScoredCandidate` per reranked candidate: the query it was scored against, the document, the rerank and RRF scores, and whether it survived. Built from values already in hand inside the loop that builds the chunks, so it costs nothing in the request path, and nothing in the request path reads it. It exists because `dropped_below_threshold` is a count, and a count cannot tell a survivor that missed by 1.76x from one that was nowhere near. Those two look identical from outside and mean opposite things: the first is a corpus that can answer the question in words it does not happen to use, the second is a corpus that cannot. `tools/rag-lens` plots it against the threshold line; see [rag-knowledge.md](rag-knowledge.md).

  Under decomposition the traces are **concatenated rather than merged**, because a chunk is scored once per sub-query and the per-query scores are the point. Collapsing them to a best score would hide that a chunk clears one stage's question and fails another's, which is the behaviour decomposition is bought for.

- **Every refusal is written down, and until now none of them were.** `planner.py` has split a refusal three ways since the groundedness gate landed, precisely because the three mean different things to whoever reads them, and all three then went to stdout. `gaps.py` appends each one to `retrieval_gaps`: which core, which surface, the question, the gate's own sentence naming what the sources lacked, and the nearest misses with the scores that decided them. That column is the valuable one, because the gate prompt already forbids a false verdict that cannot name what is missing, so every refusal arrives with a diagnosis attached.

  **Only the corpus signals go in.** A retrieval call that raised and a generation that came back unusable both produce a refusal a user sees, and neither says anything about coverage; those keep their logs and Sentry. `refusing-unverified-v1` is recorded despite not being an ingest signal, so that a spike in refusals can be attributed to the gate being down rather than to coverage collapsing, which is the confusion the three-core split exists to prevent in the first place.

  **It is fire-and-forget and swallows its own failures.** The caller has already decided to refuse and is only waiting to say so, while `db.py` retries three times with backoff against a 60-second timeout, so an awaited write could add minutes to a request whose entire content is "no". A lost row costs nothing: it is one sample of a signal that only means anything in aggregate. `redact.scrub` takes emails, URLs, phone numbers and long digit runs out of the goal first, in one place so no call site can forget (rule 8). See [rag-knowledge.md](rag-knowledge.md) for what it deliberately leaves in and why that is the opposite trade from `strip_particulars`.

- **A fourth core answers what the gate refuses, where refusing was the wrong product** ([ADR-0021](../40-adr/0021-a-labelled-ungrounded-tier.md)). `ungrounded-general-v1` runs only on an `unsupported` verdict over a retrieval that returned chunks, which is domain yes and coverage no. It emits a `post_message` and never a `propose_plan`, so an ungrounded answer structurally cannot become a task DAG that spends money; it is `grounded=False` with no citations, so every downstream consumer already refuses it for regulated purposes; it declines legal, tax, permit, medical, financial and the regulated corners of marketing in code; and the label is written by `ungrounded.frame` rather than asked of the model, because a disclaimer requested in a prompt is a disposition and this project has measured four of those failing. `UNGROUNDED_FALLBACK` restores the strict posture and is logged at startup beside `GROUNDEDNESS_CHECK`.

- **The refusal message describes the domain, never the document list.** Enumerating covered topics drifts the moment the corpus grows, and it fails in one direction only: the agent advertises a narrower corpus than it has, so a user whose question _is_ covered is told it is not and does not retry. The domain is fixed by the first vertical rather than by how many documents happen to be ingested.

- **The thread budget reached the service and nothing else, which is the same defect one level out.** `configure_torch_threads` lived in `main.py` and was therefore called only from the FastAPI lifespan, so the eval harness, `octopus_ai.seed` and `tools/rag-lens/probe.py` all ran torch on its own default and ignored `TORCH_NUM_THREADS` entirely. That matters most in the eval, which is the most CPU-bound thing in the repository: reranking is N forward passes per query and a run is dozens of queries, which is why `infra-devops.md` records CI shard timeouts being raised to 40 minutes. **CI runs `python -m octopus_ai.evaluation` directly rather than the container**, so the budget `docker-compose.yml` sets never reached the gate at all. Moved to `runtime.py`, a module that imports torch lazily and drags no FastAPI into a CLI, and called from all three eval entry points, the seeder and the probe. Unset still means "leave torch alone", so nothing changes for a caller that has not opted in. Measured on the machine that found it: torch defaults to **12 of 16** threads here, so the local gap is smaller than the 8-of-16 case the service hit, and it is a gap on every runner whose physical and logical counts differ.

- **Two settings decide how that budget is spent, and both default to doing nothing.** `RERANK_FANOUT` (default `1`) is how many sub-query rerank passes run at once; `runtime.thread_budget` divides `TORCH_NUM_THREADS` by it, so the two compose rather than compete, and `RERANK_FANOUT=0` is refused at startup because `asyncio.Semaphore(0)` never releases. `RERANK_BATCH_SIZE` (default `0`, one batch) is how many `(query, document)` pairs go through the cross-encoder per forward pass, length-sorted so a long chunk stops being padded onto every short one. The defaults are today's behaviour exactly, because the right value is a fact about a box; `docker-compose.yml` carries the measured pair and the section below carries the rows. `python -m octopus_ai.bench` is what produced them, and it is the first thing in this service that can time itself.

- **Torch is the CPU build, everywhere, and that is pinned in `uv.lock`.** Measured from the previous lockfile: `nvidia-*` plus `triton` came to **2,480 MB of the 3,179 MB** of Linux wheels, 78% of the dependency payload, for hardware no environment here has. CI runners are CPU, the Fly.io target is CPU, and this service already falls back to fp32 on CPU-only hosts. Pinned in the lockfile rather than only inside the container, because the alternative has CI scoring the golden set on one torch build while production runs another, and ADR-0009 records that such a bump moves model scores. `uv.lock` is already in the eval's trigger paths, so the gate re-measures the change rather than the change routing around the gate.

- **The service has a container, and the weights are baked into it** ([infra-devops.md](infra-devops.md)). Both snapshots ship in the image at stable paths, `HF_HUB_OFFLINE=1` is set, and nothing is fetched at run time: a silent network reach for a model is a bug, and this makes it fail loudly rather than succeed slowly. Measured on the built image: **5.15 GB peak RSS** with both models resident and ~17s from start to a warm `/health`.

- **The local embedder is warmed at service startup**, not on first use ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)). Loading bge-m3 takes seconds and a couple of GB; paying that inside the first request pushed a normal turn past Node's per-step timeout, so a cold service was indistinguishable from an unresponsive one. Warming also means a missing or corrupt model fails at startup with a named error rather than on a user's first question.

- **Coverage is not only which topics exist, it is how much each document says.** The seed corpus covered all six funnel stages at 7,443 words across thirteen documents, and the refusals it produced were correct: the groundedness gate asks whether concrete steps could be written quoting only these sources, and a 500-word principles document often fails that for its own topic. The documents are now 1,300 to 1,900 words each, 20,946 in total, 64 chunks to 145. **Deepening rather than widening was the deliberate order**, because the leaks this project has measured were all caused by documents written in general marketing vocabulary rather than by documents that say more about their own subject. No titles changed, so `golden.json` still points at the same documents. See [rag-knowledge.md](rag-knowledge.md) for what was added and the measurement.

- **Corpus coverage decides what the agent answers and what it refuses.** Because the threshold drops weak chunks, a goal with no in-scope sources degrades to `refusing-v0` by design. That makes coverage an orchestrator concern, not merely a knowledge-base one: every funnel stage without a document is a class of goal the agent will decline. The seed corpus now spans **all six funnel stages** plus compliance, partnerships and referrals ([rag-knowledge.md](rag-knowledge.md) carries the stage-by-stage map). Measurement was the standing gap and is now covered by a dedicated document, which is why `COVERED_STAGES` in `decompose.py` includes it: that tuple and the corpus have to move together, since listing a stage with no document spends rerank calls on nothing and shipping a document without listing the stage means broad goals never reach it.

- **The corpus also decides which _words_ work, which is a second and less obvious kind of coverage.** Measured: "marketing plan to get **registrations**" returned `refusing-v0` while the same request saying "**signups**" returned a full six-stage plan, because the corpus never used the first word and the local threshold's margin is 1.76x. Closed from both ends. The documents now use the words people actually use, and `vocabulary.normalise_query` rewrites the remaining variants (enquiries, installs, enrolments, clients, MRR) into corpus terms at the top of `Retriever.retrieve`, so it covers the executor's per-step re-retrieval and the goals that skip intake entirely. It **replaces** rather than expands, because query length is measured-fatal at a cross-encoder, and it is a curated domain table rather than a dictionary, because a general one pulls business-formation vocabulary into marketing queries.
- **A rate limit is not a transient 5xx, and must not share its backoff.** Provider quotas are quoted per minute, so retrying a `429` after half a second cannot succeed: it spends another call against the same exhausted quota and makes the next attempt likelier to fail. `429` therefore backs off on a minute scale (`Retry-After` when sent, else a 20s floor) while 5xx keeps the fast curve, so a genuine blip does not turn into a timeout inside the agent step. The floor is deliberately short of a full minute, since this runs inside a bounded step and waiting out the whole window trades a fast failure for a slow one. Found when the first armed CI eval run died against a trial key whose 0.5s and 1.0s retries were both rejected.

- **The database client retries too, which it did not, and the asymmetry cost a CI run.** `providers.py` has had bounded backoff since the first armed eval; `db.py` had none at all, so a single transient PostgREST response ended the request. One eval shard hit `401 PGRST303 "JWT issued at future"` and died, and because `--merge` refuses to report unless every golden case is present, **one lost shard took the whole gate red**. The other four passed on the same static credential in the same second, which is what identifies the cause: the token's `iat` cannot vary between shards, so the clock did, across the PostgREST nodes Supabase serves from. `PGRST303` is therefore retried, and it is the **only** 401 that is: an ordinary 401 means the key is wrong, and retrying it spends three attempts to reach a slower, vaguer version of the same answer. That is the distinction this service already draws when it refuses to treat a `429` like a transient `5xx`.

- **The rerank quota is capped where the call is made, not where the caller thinks it is.** `COHERE_RERANK_RPM` (default `0`, unlimited) puts a rolling-window limiter in front of the one metered call the service makes. It replaces per-case pacing in the eval harness, and the replacement was forced by a failure worth recording: the harness paced **cases** on the premise that one case was one rerank call, decomposition quietly made that one-to-many, and the harness went on pausing 10s between bursts of up to seven calls into a ten-per-minute quota. The premise was still asserted in two comments while `retrieval.py` did the opposite. A component cannot pace what it does not count, so the ceiling now sits next to the counter.

  Prevention and recovery are both kept. The limiter cannot know what **other** processes spend against the same key, which is not theoretical: a pull-request run and a merge-to-main run raced over one trial key and the second was rejected on its first call, having spent nothing. The `429` backoff above is what survives that; the limiter is what stops this service causing it.

- **Reranking runs in-process on `BAAI/bge-reranker-v2-m3`** ([ADR-0009](../40-adr/0009-local-reranker.md), amending ADR-0007's rerank pin). `RERANK_PROVIDER=local` is the default; `cohere` is retained as a working fallback and as the reference the local path is measured against. On the golden set the two are level: recall 1.00 both, coverage 1.00 local against 0.97 Cohere, MRR 0.91 against 0.95, zero leaks either way.

  **That parity only exists because the pipeline was fixed first.** Measured on the old pipeline the same model needed 265s per goal and looked undeployable. The fault was ours, not the model's: decomposition emitted the maximum number of sub-queries on every goal including out-of-scope ones, those sub-queries ran 20-30 words where a cross-encoder expects about six, a `measurement` sub-query was generated for a stage the corpus has no document for, and 40 candidates were reranked against a 43-chunk corpus when RRF already placed the answer at rank 1-3. Fixing those took rerank calls from 87 to 49 per eval run with identical gate outcomes, and a goal from 265s to 71s.

  What remains true is the shape of the cost curve: reranking is N forward passes per query where embedding is one, so **a smaller container is slower than a developer laptop, not faster** (71s per goal on 12 threads, 230s on one). Agent runs are asynchronous (`202 + runId`), so this sets how long a plan takes rather than whether it works.

  The load-bearing detail is that **`rerank_min_score` is per provider**. Cohere separates relevant from off-topic around 0.05; bge's equivalent separation sits at 0.0013. Sharing one number is a silent grounding failure, and it was observed rather than predicted: with Cohere's threshold applied to bge's scores the golden set came back at recall 0.45 while the eval banner printed the threshold that was not being used.

- **The local threshold's margin is the narrowest safety property in retrieval.** 0.0013 sits between the broadest legitimate goal (0.001772) and the strongest negative (0.001007), a 1.76x margin against roughly 9x on Cohere. The golden set's **negative half is therefore load-bearing** and must grow with the corpus; adding positives alone leaves this undefended.

- **The eval can be sharded, and a shard is forbidden from returning a verdict.** `--shard i/n --out` writes raw per-case results; `--merge` applies the thresholds once over the merged whole and **refuses unless every golden case is present**. The rule exists because scoring inside a shard would silently redefine the gate: recall over five cases is not the same statistic as recall over fifteen. The failure worth defending against is a shard that never reports rather than one that errors, since that shrinks the denominator and returns green over a set nobody ran in full.

- **Decomposition is sampled at `temperature: 0`, and that had to be sent explicitly.** `complete_json` omitted the parameter, so it inherited the provider default of **1.0** on what is a classification-shaped call: the same goal decomposed differently every time. The symptom was an eval that returned coverage 0.97-1.00 and MRR 0.83-0.95 across five runs of one unchanged commit, which makes a genuine regression indistinguishable from resampling. Prose generation (`complete`) deliberately keeps its own 0.3, since the two are different tasks with different tolerances for variety, and a test pins both so changing one is not assumed to change the other. This removes the deliberate variance rather than guaranteeing determinism; a provider may still vary at 0.

- **Decomposition breadth is judged from the goal's wording, not asserted as a prior.** A goal naming a specific problem gets the one or two stages that problem lives in; a goal naming only an outcome ("get my first 100 customers") is a whole-funnel request and gets every plausible stage. An earlier rewrite told the model "most goals need one or two stages" and took that exact case from coverage 1.00 to 0.33. Stages the corpus does not cover are filtered in code rather than requested in the prompt, because the corpus changes and prompts drift.

- **Ingestion supersedes rather than duplicates.** A changed document closes the previous version's validity window before the new one is inserted. Without that step re-ingestion silently produces two live copies that then get reranked against each other, which is exactly what happened the first time it was run.
- **Change detection covers the chunker and the embedding model, not just the text.** `content_hash` folds in a `CHUNKER_VERSION`, so changing how documents split forces a re-ingest instead of leaving the index built by code that no longer exists. It folds in the **active embedding model** for a sharper reason ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)): switching embedder leaves the source bytes identical, so without it every document is skipped as unchanged, the corpus keeps the old model's vectors while new rows claim the new one, and query vectors are then compared against a foreign vector space inside the same HNSW index. Nothing raises and nothing logs; retrieval just quietly gets worse.

- **The embedder is selectable, and the two are never mixed.** `EMBED_PROVIDER=openai` (default) or `local` for in-process **BAAI/bge-m3** ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)). Both emit 1024 dims, so `halfvec(1024)` and the HNSW index are untouched. torch is an optional extra and the local module is imported lazily, so the default path never installs it. Note the eval gate does not exist yet, so **which of the two retrieves better on this corpus is unmeasured**; the local option is justified on data-residency grounds, not on a quality claim.

## The proposal boundary (how "Python proposes, Node executes" is actually enforced)

The split is structural, not a convention anyone has to remember:

- `services/ai` holds **no database client and no Supabase key**. It cannot write, so a jailbroken prompt there cannot post as another member, move money, or touch a row. A test asserts the absence rather than trusting review to catch a future import.
- Every response is a list of **proposals** with a `kind`. Node parses them as a **discriminated union**, so an unknown kind fails the parse loudly rather than being silently dropped: the core inventing a proposal kind should break the run, not quietly do nothing. Two kinds exist, `post_message` and `propose_plan`, each handled explicitly in a `switch`. A plan proposal makes Node write both the message and its embed, and Node validates the payload against `packages/contracts` **before** storing it, so an invalid plan fails here where the row can be named rather than in the browser on every future read.
- Node parses the response against a schema before acting. An unrecognised shape is a contract break and fails the run, rather than being half-interpreted.
- The agent's message insert carries a **deterministic idempotency key** (`agent-run:{runId}:{index}`), so replaying a run cannot post twice.
- A failed run posts a **system message into the room**. Silence would be indistinguishable from the agent choosing not to reply (rule 16).

## Guardrails (layered defense, fast → smart)

1. Deterministic rule checks (allow-lists, spend caps, PII).
2. Small classifier (policy/injection).
3. LLM-judge critic (maker-checker).

Non-negotiables (full list in [security-compliance.md](../10-architecture/security-compliance.md)):

- **Authz + spend caps in tool code, not prompts.** A jailbroken prompt cannot overspend escrow or move money.
- **Injection quarantine:** all tool/web/document/node content is data, never instructions.
- **Idempotency / exactly-once** external side effects.
- **RAG grounding + citations** required for legal/tax/permit output; uncited/low-confidence claims → `unverified` → escalate.
- **Kill switch / pause** honored at safe checkpoints.
- **Full audit trail** — every plan diff, tool call, decision, confidence, escalation, payout is event-sourced.

## Escalation triggers (route to human node or user)

- **Legal restriction** — signing/notarizing, filings needing a qualified signature/in-person appearance, licensed sign-off. AI drafts/prepares; a human executes.
- **Physical presence** — site visits, inspections, meeting a landlord, equipment/venue, permit pickup.
- **High-risk / irreversible** — signing a lease, moving money beyond micro-thresholds, supplier contracts, hiring, publishing branded content → mandatory approval.
- **Low AI confidence** — failed `acceptance_criteria` after 2–3 tries, critic reject, or low RAG confidence on a jurisdiction-critical claim.
- **Local / tacit-knowledge gap** — negotiation, informal norms, language/dialect nuance.
- **Missing user-only fact** — personal ID for formation, real budget ceiling, risk appetite, subjective brand choice → escalates to the **user** as a single batched question.
- **User opt-in** — "always have a human review anything legal."
- **Policy / compliance flag** — a guardrail trips → freeze + human review, not silent retry.
- **Time / SLA breach** — task exceeds expected duration → escalate for unblocking.

## Human-in-the-loop waitpoints

- **The waitpoint is a row, not a token** ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)). A task parked at `escalated` or `needs_user` waits at zero compute for as long as it takes; there is no continuation to suspend, because ADR-0006 left none.
- The router puts it there. `packages/core/src/router.ts` sends every human-owned step to `escalated`, and the owner sends it to the marketplace from the project panel. **`request_human_node` is not built**: it was specified in Phase 0 as the tool that suspends a run on a vendor waitpoint, and both halves of that sentence stopped being true. Its remaining job, handing the matcher a set of requirements, is done by the stage-to-skill map in `packages/marketplace`.
- On verified completion the next tick picks the task up in its new state and the run continues. Resumption is a read, so it is deterministic by construction rather than by replay.

## AI-as-chat-member

- Streams tokens **inline** into the channel (accent bar + Agent tag + working pulse).
- Reports as **batched digests**, not chatter; surfaces only decisions that need the user.
- Its messages are the human-readable projection of the audit trail.

## Minimal-user-involvement policy

Surface to the user **only**: irreversible/high-risk approvals, subjective/brand choices, missing user-only facts, and money authorizations. Everything else runs autonomously.

## Key entities

`task_runs` · `agent_steps` (event-sourced) · `tool_invocations` (idempotency keys, audit, risk tier) · `escalations` · `artifacts`. **No waitpoint tokens**: the waiting task row is the waitpoint ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)). Full schema in [data-model.md](../10-architecture/data-model.md).

## Observability

Per-run tracing (`projectId` + `agentRunId`), LLM traces (prompt/response/token/cost) to the LLM-trace sink, kill switch/pause. **There is no step-level replay UI**, which [ADR-0010](../40-adr/0010-postgres-durable-runner.md) named as the real cost of owning the runner; what replaces it is the append-only `events` log, which records every transition with the rule that fired, plus the Phase 3 audit-trail explorer in [admin-ops.md](admin-ops.md). See [observability.md](../10-architecture/observability.md).

**Flywheel capture:** every plan diff, tool result, user approve/reject/edit, and human-node correction is event-sourced and projected into the [learning flywheel](../10-architecture/learning-flywheel.md) as labeled data — the AI should need fewer corrections over time.

### The Python service logs its structured context, as of this change

Every call site in `services/ai` passes `extra={...}`: `agent_run_id` on each
reasoning step, the groundedness verdict with its reason, the retrieval counts,
and the reason a structured plan was rejected. **None of it was ever emitted.**
The service only ever called `logging.getLogger`, so it inherited uvicorn's
default formatter, which drops non-standard `LogRecord` attributes silently.

That is worth recording as a defect rather than a tidy-up, because of which
field it discarded. `planner.py` catches a malformed plan and logs
`reason=str(exc)` before regenerating as prose, and that reason is the only thing
separating a truncated response from an upstream provider timeout. Both present
identically as "structured plan unusable, falling back to prose", and the
distinction was written and thrown away on every occurrence. The same was true of
every `agent_run_id`, which is what ties a log line back to the run a person is
waiting on, and which [observability.md](../10-architecture/observability.md)
requires be threaded across the seam.

`configure_logging` in `main.py` attaches a formatter that renders those fields,
scoped to the `octopus` logger with `propagate = False` so uvicorn's own access
logging is neither duplicated nor silenced. It is called first in `lifespan`, so
startup lines carry their context too.

**What it immediately surfaced.** A whole-funnel goal was reported to a user as a
timeout. With the extras visible, one reproduction showed the run had decomposed
into 6 sub-queries, paid 6 sequential rerank passes, taken 498s, and then been
**refused by the groundedness gate as `unsupported`** with a precise reason. The
refusal was correct and the person never saw it, because the API's 300s budget
discarded it and reported that the service had given up instead. Telling somebody
the reasoning service failed when it in fact answered, and answered "your goal is
outside my sources", is the same class of defect as reporting a timeout as an
outage. The latency itself is unfixed and recorded below.

### Sub-query fan-out is the dominant planning cost, and it is now measured rather than argued

`config.py` states the trade plainly: decomposition costs **one rerank per
sub-query**, because the cheap alternative (search every sub-query, rerank once
against the original goal) was built, measured, and found to change nothing.
That trade was priced when rerank was a metered Cohere call, where serialising
was the point and `rerank_rpm` was the ceiling. Since [ADR-0009](../40-adr/0009-local-reranker.md)
rerank runs in-process on CPU and is explicitly not rate-limited, so the loop
serialised CPU work for a reason that had expired.

Measured on a 16-core host with torch on 8 threads: 6 sub-queries, 498s end to
end, roughly 83s per pass. Nothing is wrong with any single pass; there are just
six of them in a row.

**Half of that was torch using half the machine.** `torch.set_num_threads`
defaults to the physical core count while a container is given the logical one,
so the service ran on 8 of 16 threads on a number nobody had chosen. Isolating
one rerank pass over 25 candidates in-container: **69.7s at the default 8, 36.8s
at 16.** `TORCH_NUM_THREADS` now carries that budget, applied at startup by
`configure_torch_threads` and set to 16 in `docker-compose.yml`. The same goal
that took **498s then took 267s**, a 1.86x improvement that matches the isolated
measurement, and it lands under even the 300s budget that had been discarding it.
(It now takes **121s**; the rest of this section is how, and what had to be
measured before anything could be chosen.)

Two smaller levers were measured and **not** taken. Capping `MAX_LENGTH` at 512
instead of 1024 saves only 32.5s against 36.8s, because `padding=True` pads to
the longest pair in the batch and real chunks tokenise to ~585, so the cap is
rarely what binds. Halving `retrieval_candidates` to 12 gives 34.0s against
36.8s, which is far less than linear and buys nothing worth the recall.

**Both of those conclusions are amended below by instrumentation neither had.**
The first identified the right culprit and drew the wrong lever from it: padding
to the longest pair is real and expensive, but the fix is to batch pairs of
similar length rather than to cap the length, and per-pair lengths measured on
the live corpus run 440-480 at the maximum against a ~250 mean, not ~585. The
second is simply not reproducible: with per-stage timing, 25 candidates against 12
is close to linear at 1.28s each, and the sublinear-looking 34.0-against-36.8 was
a hand-taken pair of numbers on a contended box.

**Nothing in this service could time itself, which is why every figure above was
taken by hand.** There was exactly one `time.monotonic()` in the whole codebase,
inside the rate limiter. `retrieval.py` now times embed, hybrid search and rerank
separately per pass: `retrieval complete` carries `embed_ms`, `search_ms` and
`rerank_ms`; `decomposed retrieval` adds `fanout`, `passes`, `base_ms`,
`subqueries_ms` (the wall of the gathered section), `rerank_ms` (the sum across
passes) and `total_ms`; and `local rerank pass` carries `pairs`, `batches`,
`max_tokens`, `padding_ratio`, `tokenize_ms` and `forward_ms`. The gap between
`subqueries_ms` and the summed `rerank_ms` is the concurrency actually achieved,
which is the one number that says whether a fan-out did anything. Every retrieval
log line now also carries `agent_run_id`; the retrieval path had never been given
one, so its logs could be read for what happened but not joined to the run they
happened in ([observability.md](../10-architecture/observability.md)).

**The fan-out is bounded, and the thread budget is divided rather than
multiplied.** `RERANK_FANOUT` runs at most K sub-query passes concurrently under
an `asyncio.Semaphore` while `runtime.thread_budget` sets torch to
`TORCH_NUM_THREADS // K`, so total CPU demand is unchanged and only the ordering
differs. The semaphore lives on the `Retriever`, of which `main.py` builds exactly
one, so two concurrent `/plan` requests share the bound the budget was divided
for. **The goal pass still runs first and alone**, outside the semaphore, because
`if not base.chunks: return base` is the grounding gate: a car-licence goal
decomposes into plausible marketing sub-queries that each legitimately retrieve
and clear the threshold, and the golden set's negative half caught exactly that.
Folding the goal into the gathered section would mean the sub-queries had already
run before the gate could refuse them.

**Fan-out was expected to be a wash and measured as a win, for a reason nobody had
guessed.** The arithmetic said it should barely help: if a pass saturates the box,
K passes at `budget/K` cost the same total CPU, and the goal pass runs alone at
the divided count with no concurrency to pay for its halving. The suspected escape
was a large fixed per-pass cost, implied by the recorded 34.0s-against-36.8s when
candidates were halved. **Both halves of that story are wrong.** The bench puts
the fixed cost at **1.4s, 4% of a 25-candidate pass**, and the pass is essentially
linear in candidates at 1.28s each. What actually makes concurrency win is that
**thread scaling is sublinear past 8**: halving a pass's threads costs about
**21%** more CPU time rather than 100%, so two passes sharing the budget finish
sooner than two passes taking turns with all of it. The near-linear 69.7s-at-8
against 36.8s-at-16 recorded above does not reproduce on the host these rows were
taken on.

**Batching is the larger win, and it was not the headline going in.** Every pass
tokenised 25 pairs with `padding=True`, which pads all of them to the longest, so
one long chunk was paid for 25 times. `RERANK_BATCH_SIZE` sorts pairs by length
(descending, so peak memory lands in the first batch) and chunks them, which took
padding from **37.4% of every token computed to 11.3%**. It cannot move a score,
because the attention mask already excludes padding, and it does not: **max drift
across the whole grid was 1.9e-07**.

Measured with `python -m octopus_ai.bench`, 6 sub-queries, `TORCH_NUM_THREADS=16`,
wall seconds for the whole retrieval:

| candidates | batch | fanout 1 | fanout 2 | fanout 3 |
| ---------- | ----- | -------- | -------- | -------- |
| 25         | 0     | 209.3    | 157.6    | 164.6    |
| 25         | 8     | 152.8    | 116.9    | 109.8    |
| 12         | 0     | 100.3    | 86.2     | 70.7     |
| 12         | 8     | 88.5     | 62.6     | 60.4     |

`docker-compose.yml` takes `RERANK_FANOUT: '2'` and `RERANK_BATCH_SIZE: '8'`:
**209.3s to 116.9s, a 1.79x improvement on top of the 1.86x the thread budget
already bought.** Confirmed in the container on the goal that produced the 267s
figure above, driven through `/plan` for real: 6 sub-queries, **`total_ms=121007`
against the recorded 267s**, with `subqueries_ms=92507` against a summed
`rerank_ms=185866` — the gap between those two is the concurrency, visible in the
log line rather than inferred. Fanout 3 measured marginally faster at 25 candidates and was not
taken, because `16 // 3` is 5 and leaves a core idle, and the 6% gap between them
is inside the run-to-run spread this benchmark showed on nominally identical
settings. Both settings **default to today's behaviour** (`1` and `0`), because
the right value is a fact about a box rather than about this code, and a
deployment that has not measured its own should not silently inherit ours.

**The reranker is warmed at startup now, beside the embedder.** It was lazy, so
the first plan on every fresh process paid the model load inside the request:
**18.4s for a cold first rerank against roughly 2s warm.** The warm-up is a real
forward pass rather than a bare load, because the first pass initialises kernels
that loading does not touch. What warming removes is the stall, not the peak: the
weights are resident before `/health` goes green (4.0 GiB, at **37s** against a
180s `start-period`), while the peak still arrives with the first real pass,
because what grows there is activations. The fan-out raises that peak from 5.3 to
**5.9 GiB**, which is the one thing `RERANK_FANOUT=2` costs and the reason to lower
it rather than the thread count on a small instance.

**One race was closed on the way**, because the fan-out would have made it
routine: `Providers` built the `LocalReranker` on an unguarded `is None` check, so
two coroutines arriving together each built one and each loaded ~1 GB of weights.
It needed two concurrent requests to surface under the sequential loop; concurrent
passes are now the normal case.

**Still not taken, and recorded rather than implied:** int8 dynamic quantisation
of the cross-encoder is the one remaining lever likely to halve a pass, and it is
out of scope here because it **changes scores**. It would need the full 65-minute
gate plus a recalibration of `RERANK_LOCAL_MIN_SCORE` against the 1.76x margin
([ADR-0009](../40-adr/0009-local-reranker.md)), which is the narrowest safety
property in retrieval. Everything in this section was chosen precisely because it
could not move a score, and the golden negatives were re-run through the real
pipeline at both configurations to prove it: all five still keep zero chunks on
identical digits, including the 0.001007 that defines the margin's lower bound.

## State model

The agent drives the project/task state machine owned by [business-projects-workflow.md](business-projects-workflow.md); it is the single writer to task states via the scheduler/router.
