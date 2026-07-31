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
> - **`grounded-v1`** — retrieval found in-scope sources, so the reply is written from them and cites them by document title.
> - **`refusing-v0`** — nothing cleared the relevance threshold, so it declines to plan and says why. Retrieval failing or generation failing both degrade to this, never to an ungrounded answer.
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

`query -> embed -> [dense + sparse fused by RRF inside Postgres] -> cross-encoder rerank -> drop below threshold`

- **Fusion happens in SQL, not Python.** `public.hybrid_search` runs both candidate lists and the RRF merge in one query, so the network carries the final top-N instead of two candidate lists. RRF is rank-based, which is the point: cosine distance and `ts_rank_cd` are not comparable quantities and would need normalising otherwise.
- **The threshold is calibrated, not guessed.** Measured against the seed corpus: clearly relevant chunks score 0.063 to 0.667, a related-but-wrong document tops out near 0.068, and an off-topic query never exceeds 0.015. `0.05` separates them. **Re-calibrate as the corpus grows**; Cohere's scores are corpus-dependent.
- **Weak chunks are dropped, never used as padding.** Handing a model six loosely related paragraphs is how confident, wrong, "grounded" answers get produced.
- **Ingestion supersedes rather than duplicates.** A changed document closes the previous version's validity window before the new one is inserted. Without that step re-ingestion silently produces two live copies that then get reranked against each other, which is exactly what happened the first time it was run.
- **Change detection covers the chunker, not just the text.** `content_hash` folds in a `CHUNKER_VERSION`, so changing how documents split forces a re-ingest instead of leaving the index built by code that no longer exists.

## The proposal boundary (how "Python proposes, Node executes" is actually enforced)

The split is structural, not a convention anyone has to remember:

- `services/ai` holds **no database client and no Supabase key**. It cannot write, so a jailbroken prompt there cannot post as another member, move money, or touch a row. A test asserts the absence rather than trusting review to catch a future import.
- Every response is a list of **proposals** with a `kind`. Node has an explicit `switch` over the kinds it will honour, so the core cannot widen its own powers by inventing a new one; an unknown kind is ignored, not attempted.
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
