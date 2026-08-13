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
>
> **The plan is validated, not trusted.** `parse_plan` normalises the six stages into fixed order (the model omits and reorders them, and a card silently showing four stages reads as "the plan has four parts" rather than "two stages had no sources"), range-checks every citation index (a step citing `[7]` when six sources were supplied is a hallucinated reference the reader cannot follow), and rejects an all-empty plan outright, since six empty stages is a refusal wearing a card's clothing and the refusal path says it far more clearly. Ten tests cover those failures because each one renders as a plausible-looking card.
>
> Verified end to end: "my cost per acquisition on Meta ads is too high" returns a cited plan drawn from the corpus, while "get a restaurant liquor licence in Tbilisi" is refused rather than invented.
>
> **Not yet durable.** The run executes in-process, so a crash or deploy mid-run loses it; ADR-0001 puts this on Trigger.dev v3, which needs credentials this project does not have yet. `startRun` is already shaped for that move (one function, a run id, no shared state, no dependency on the request staying open). Verified: 11 API assertions plus a Realtime probe confirming the agent's message is broadcast to a subscribed member.

## Two-layer design

- **Durable execution backbone** (Trigger.dev v3): each agent run is a durable task — survives crashes/deploys, retries steps, and **sleeps for days on waitpoints** at zero compute. See [ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md).
- **Supervisor / orchestrator reasoning core**: the single writer to the task DAG. Spawns **ephemeral, read-only sub-agents as tools** (research, critique); they never write the DAG.

## Language & service boundary ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md))

The **reasoning core runs in the Python AI service** (`services/ai`, FastAPI + LlamaIndex): planning, drafting, RAG retrieval, and **tool selection** (deciding _what_ to do). The **durable backbone stays in Node** (`apps/agent`, Trigger.dev): it drives the Python core per step, holds human waitpoints, and executes **all side-effecting tools** (`post_message`, `write_artifact`, escrow, `request_human_node`) in the Postgres/RLS/Stripe world. **Python proposes, Node executes** — so authz + spend caps stay in Node tool code, and a jailbroken prompt in the Python core still cannot move money.

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

## The retrieval pipeline (`services/ai`)

`goal -> decompose -> per-sub-query [embed -> RRF in Postgres -> rerank -> drop below threshold] -> merge survivors`

- **Decomposition is additive to grounding, never a source of it.** The goal is searched first, and if it retrieves nothing the sub-queries are abandoned. Without that gate the golden set caught a live leak: "how to get a car licence" decomposed into plausible marketing sub-queries, each of which legitimately retrieved marketing content and cleared the threshold, leaving the agent with cited sources for a question the corpus cannot answer. That is the exact failure the groundedness gate exists to prevent.

- **One rerank per sub-query, and the cheaper design was measured before being rejected.** Searching every sub-query but reranking once against the original goal changed nothing at all: candidate breadth was never the bottleneck (40 candidates against a ~43-chunk corpus). The bottleneck is the rerank, where a vague goal scores 0.066 against chunks a focused query scores 0.474 on. Coverage of a broad goal went 0.33 to 1.00 once each sub-query was scored on its own terms. The cost is real: N rerank calls per plan, which makes a production rerank key a prerequisite, and MRR fell 0.95 to 0.76 because merging survivors pushes the single best chunk down the list.

- **Fusion happens in SQL, not Python.** `public.hybrid_search` runs both candidate lists and the RRF merge in one query, so the network carries the final top-N instead of two candidate lists. RRF is rank-based, which is the point: cosine distance and `ts_rank_cd` are not comparable quantities and would need normalising otherwise.
- **The threshold is calibrated, not guessed, and it is now measured rather than assumed.** Originally set from the four-document seed corpus. Re-measured against the ten-document corpus on bge-m3 via the golden set: true positives score **0.127 to 0.637** and out-of-scope queries do not clear `0.05` at all, so the separation survived the corpus tripling and the embedder changing. Cohere's scores are corpus-dependent, so this stays something to re-measure rather than trust; `python -m octopus_ai.evaluation` is how ([rag-knowledge.md](rag-knowledge.md)).

  A caution learned here: an in-scope query dropping nothing is **correct**, not evidence the threshold stopped working. Reading "0 below threshold" on covered questions as a filtering failure led to a wrong conclusion that the eval then disproved. Judge the threshold on out-of-scope queries, which is exactly what the golden set's negative half is for.

- **Weak chunks are dropped, never used as padding.** Handing a model six loosely related paragraphs is how confident, wrong, "grounded" answers get produced.

- **The refusal message describes the domain, never the document list.** Enumerating covered topics drifts the moment the corpus grows, and it fails in one direction only: the agent advertises a narrower corpus than it has, so a user whose question _is_ covered is told it is not and does not retry. The domain is fixed by the first vertical rather than by how many documents happen to be ingested.

- **The local embedder is warmed at service startup**, not on first use ([ADR-0008](../40-adr/0008-local-bge-m3-embeddings.md)). Loading bge-m3 takes seconds and a couple of GB; paying that inside the first request pushed a normal turn past Node's per-step timeout, so a cold service was indistinguishable from an unresponsive one. Warming also means a missing or corrupt model fails at startup with a named error rather than on a user's first question.

- **Corpus coverage decides what the agent answers and what it refuses.** Because the threshold drops weak chunks, a goal with no in-scope sources degrades to `refusing-v0` by design. That makes coverage an orchestrator concern, not merely a knowledge-base one: every funnel stage without a document is a class of goal the agent will decline. The seed corpus now spans strategy, content, creative, channels, conversion and compliance ([rag-knowledge.md](rag-knowledge.md) carries the stage-by-stage map); **measurement has no dedicated document**, so measurement-led goals are the known gap.
- **A rate limit is not a transient 5xx, and must not share its backoff.** Provider quotas are quoted per minute, so retrying a `429` after half a second cannot succeed: it spends another call against the same exhausted quota and makes the next attempt likelier to fail. `429` therefore backs off on a minute scale (`Retry-After` when sent, else a 20s floor) while 5xx keeps the fast curve, so a genuine blip does not turn into a timeout inside the agent step. The floor is deliberately short of a full minute, since this runs inside a bounded step and waiting out the whole window trades a fast failure for a slow one. Found when the first armed CI eval run died against a trial key whose 0.5s and 1.0s retries were both rejected.

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
