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
> - **`grounded-v1`** — the sources were good but the model could not produce a valid plan, so the reply falls back to cited prose. This degrades **sideways, not down**: a cited paragraph is still worth posting. It never falls back to an ungrounded plan, which is why the fallback re-generates from the same sources rather than salvaging malformed JSON.
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
> Verified end to end: "my cost per acquisition on Meta ads is too high" returns a cited plan drawn from the corpus, while "get a restaurant liquor licence in Tbilisi" is refused rather than invented.
>
> **`/execute` is live (Phase 2):** one AI-owned task from an approved plan, drafted as a cited artifact or refused. Two cores, `executing-v1` and `refusing-unexecutable-v1`. It **re-retrieves for the step** rather than inheriting the plan's sources, because the sources that justified "you need positioning work" are broader than the ones that help write the positioning, and it runs through the **same groundedness gate**, applied where it matters more: by then a person has approved the plan, so ungrounded output stops looking like a suggestion and starts looking like delivered work. A third proposal kind, `write_artifact`, whose citations are source **labels** rather than indices, because the checker's job includes catching a source the maker was never given and an index is checkable for range but not for provenance. Citations naming a source that was not supplied are **dropped here rather than passed on**, since the checker escalates a fabricated one and turning a model slip into a human's problem is worse than letting the remaining grounding be judged on its merits. See [business-projects-workflow.md](business-projects-workflow.md) for the checker.
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

| Tool                             | Risk tier  | Notes                                                                   |
| -------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `rag_retrieve`                   | read-only  | hybrid pgvector search; returns cited, dated sources                    |
| `web_research`                   | external   | results are **untrusted data**, injection-quarantined                   |
| `source_suppliers`               | external   | structured supplier lookup                                              |
| `compute_budget`                 | reversible | CapEx/OpEx model, illustrative projection                               |
| `draft_branding`                 | reversible | naming/logo/menu/site briefs                                            |
| `write_artifact`                 | reversible | to Supabase Storage                                                     |
| `post_message`                   | reversible | writes to chat as the AI member                                         |
| `fund_escrow` / `release_escrow` | high-risk  | spend caps + RBAC enforced **in tool code**; user approval required     |
| `request_human_node`             | high-risk  | creates task, hands matcher requirements, **suspends run on waitpoint** |

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

`COVERED_STAGES` is imported from `decompose.py` rather than restated, because a second list of which stages have documents would drift the first time one is ingested.

**Requirements scale with breadth, and a narrow request requires nothing.** That is the important half: "my CPA on paid social is too high" is already answerable, and interrogating someone who asked a precise question is how an intake step becomes the reason people stop using the product. The breadth test is the one decomposition already uses and which was measured there. A whole-funnel request requires ICP, offer, target metric and budget band; timeline is collected when offered and never blocks.

**Four outcomes, because two were not enough and the shortfall was visible on the first surface anyone touches.** The first version had a single `out_of_scope`, and "Hello" came back as "what you have described sits outside full-funnel digital marketing". A greeting is not a request that is out of scope. It is not a request.

| Outcome         | What it means                          | What the caller does                                                     |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `ready`         | enough is known                        | plan on `refined_goal`                                                   |
| `needs_detail`  | in scope, too vague                    | ask one batch of slot questions                                          |
| `not_a_request` | a greeting, a fragment, small talk     | open the conversation: what are you trying to grow                       |
| `out_of_domain` | a real request, another field entirely | name what is not on offer, then ask whether a growth goal sits inside it |

The last two both leave the conversation open rather than ending it, and they are separate because **the words differ where the mechanism does not**. A greeting has nothing to decline. A request from another field has something to decline, and the decline has to come **before** the question, or the question is a way of keeping someone talking rather than an honest redirect. Someone opening a cafe cannot be helped to open it, and may well want customers through its door, which is work this system does.

**That redirect is bounded.** `stalls` counts consecutive turns producing no usable goal, capped at two, and it is counted separately from the answer rounds because the two limit different things: rounds limit interrogating someone who **has** said what they want, stalls limit asking someone who has not. Following a thread is right; following it forever is a system that will not take no for an answer, so it stops and says so.

**A card knows whether it is waiting for a goal or for answers**, and that is the detail the multi-turn behaviour rests on. When it waits for a goal, the next message **replaces** the goal rather than being filed as an answer to it. Without that, a conversation opening with "Hello" would plan for the goal "Hello" forever with everything real buried in `answers`.

**Intake can block and can never authorise.** It stops a plainly out-of-domain request before it costs a retrieval. The converse does not hold: an intake that finishes says nothing about whether the corpus can ground an answer, and the **groundedness gate still runs exactly as before**. Non-zero proximity means "in the right field", which is precisely the property the measured leaks in [rag-knowledge.md](rag-knowledge.md) also have. Same rule decomposition carries, worded the same way: additive to grounding, never a source of it.

**User-facing copy is templated in the API, not generated.** `planner.py` already templates its refusals for the same reason: brand voice is an enforced rule (no em dashes, no hype, rule 22) and a generated sentence is one prompt drift away from breaking it on a trust surface. The model classifies; the words are ours.

**Rounds are capped at two, and that is a product decision rather than a measurement.** [vision.md](../00-overview/vision.md) makes user-touch-count per result a guardrail to drive down and this doc requires user-only facts to be raised as a single batched question, so a tree of one-question-at-a-time turns would satisfy the module and violate the product. Questions go out in one batch of at most four, ordered by the required list. An intake that ends incomplete produces a thinner plan, which the card renders as visibly empty stages, and that is a better outcome than a third round.

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

- **The refusal message describes the domain, never the document list.** Enumerating covered topics drifts the moment the corpus grows, and it fails in one direction only: the agent advertises a narrower corpus than it has, so a user whose question _is_ covered is told it is not and does not retry. The domain is fixed by the first vertical rather than by how many documents happen to be ingested.

- **Torch is the CPU build, everywhere, and that is pinned in `uv.lock`.** Measured from the previous lockfile: `nvidia-*` plus `triton` came to **2,480 MB of the 3,179 MB** of Linux wheels, 78% of the dependency payload, for hardware no environment here has. CI runners are CPU, the Fly.io target is CPU, and this service already falls back to fp32 on CPU-only hosts. Pinned in the lockfile rather than only inside the container, because the alternative has CI scoring the golden set on one torch build while production runs another, and ADR-0009 records that such a bump moves model scores. `uv.lock` is already in the eval's trigger paths, so the gate re-measures the change rather than the change routing around the gate.

- **The service has a container, and the weights are baked into it** ([infra-devops.md](infra-devops.md)). Both snapshots ship in the image at stable paths, `HF_HUB_OFFLINE=1` is set, and nothing is fetched at run time: a silent network reach for a model is a bug, and this makes it fail loudly rather than succeed slowly. Measured on the built image: **5.15 GB peak RSS** with both models resident and ~17s from start to a warm `/health`.

- **The local embedder is warmed at service startup**, not on first use ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)). Loading bge-m3 takes seconds and a couple of GB; paying that inside the first request pushed a normal turn past Node's per-step timeout, so a cold service was indistinguishable from an unresponsive one. Warming also means a missing or corrupt model fails at startup with a named error rather than on a user's first question.

- **Corpus coverage decides what the agent answers and what it refuses.** Because the threshold drops weak chunks, a goal with no in-scope sources degrades to `refusing-v0` by design. That makes coverage an orchestrator concern, not merely a knowledge-base one: every funnel stage without a document is a class of goal the agent will decline. The seed corpus now spans strategy, content, creative, channels, conversion and compliance ([rag-knowledge.md](rag-knowledge.md) carries the stage-by-stage map); **measurement has no dedicated document**, so measurement-led goals are the known gap.
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

- `request_human_node` creates a task row, hands the matcher the requirements, and the agent **suspends on a Trigger.dev waitpoint token**.
- On verified completion the matcher/Fastify **completes the token** and the run **resumes deterministically** at the suspended step.

## AI-as-chat-member

- Streams tokens **inline** into the channel (accent bar + Agent tag + working pulse).
- Reports as **batched digests**, not chatter; surfaces only decisions that need the user.
- Its messages are the human-readable projection of the audit trail.

## Minimal-user-involvement policy

Surface to the user **only**: irreversible/high-risk approvals, subjective/brand choices, missing user-only facts, and money authorizations. Everything else runs autonomously.

## Key entities

`task_runs` · `agent_steps` (event-sourced) · `tool_invocations` (idempotency keys, audit, risk tier) · `escalations` · `artifacts` · waitpoint tokens. Full schema in [data-model.md](../10-architecture/data-model.md).

## Observability

Per-run tracing (`projectId` + `agentRunId`), LLM traces (prompt/response/token/cost) to the LLM-trace sink, Trigger.dev run UI for step-level replay, kill switch/pause. See [observability.md](../10-architecture/observability.md).

**Flywheel capture:** every plan diff, tool result, user approve/reject/edit, and human-node correction is event-sourced and projected into the [learning flywheel](../10-architecture/learning-flywheel.md) as labeled data — the AI should need fewer corrections over time.

## State model

The agent drives the project/task state machine owned by [business-projects-workflow.md](business-projects-workflow.md); it is the single writer to task states via the scheduler/router.
