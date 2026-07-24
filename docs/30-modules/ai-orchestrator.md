# Module: AI Orchestrator (Agent Runtime)

> The **business-operator brain**: a durable, supervisor-pattern agent that plans a task DAG, executes AI-capable steps via typed tools, grounds every step in RAG, enforces guardrails, and suspends on human waitpoints. The **single writer** to the task graph.
>
> **Owner paths:** `apps/agent/**`, `packages/agent-tools/**` · **Depends on:** rag-knowledge, business-projects-workflow, chat-discord, human-nodes-marketplace, payments-billing, integrations.
>
> Update this doc on any change to the planning loop, tool registry, guardrails, escalation triggers, or state model.

## Two-layer design

- **Durable execution backbone** (Trigger.dev v3): each agent run is a durable task — survives crashes/deploys, retries steps, and **sleeps for days on waitpoints** at zero compute. See [ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md).
- **Supervisor / orchestrator reasoning core**: the single writer to the task DAG. Spawns **ephemeral, read-only sub-agents as tools** (research, critique); they never write the DAG.

## Planner / executor loop

- **Model tiering:** stronger model for planning + critic, faster model for executor steps, cheap model for classification/routing. Never a single hardcoded model.
- **Plan-then-act:** decompose the goal → RAG-grounded task DAG → dispatch READY tasks → execute → **maker-checker critic** validates against `acceptance_criteria` → reconcile.
- **Replan by diff, not regeneration:** after each task, reconcile the DAG with add/cancel/modify **diffs** — preserving completed work and audit history.

## Typed tool registry

Every tool is a Zod-typed function with a **risk tier**. Tools have **no ambient DB power** — they act through scoped Fastify endpoints.

| Tool | Risk tier | Notes |
|---|---|---|
| `rag_retrieve` | read-only | hybrid pgvector search; returns cited, dated sources |
| `web_research` | external | results are **untrusted data**, injection-quarantined |
| `source_suppliers` | external | structured supplier lookup |
| `compute_budget` | reversible | CapEx/OpEx model, illustrative projection |
| `draft_branding` | reversible | naming/logo/menu/site briefs |
| `write_artifact` | reversible | to Supabase Storage |
| `post_message` | reversible | writes to chat as the AI member |
| `fund_escrow` / `release_escrow` | high-risk | spend caps + RBAC enforced **in tool code**; user approval required |
| `request_human_node` | high-risk | creates task, hands matcher requirements, **suspends run on waitpoint** |

> **First-vertical tools:** the marketing growth engine adds typed, guardrailed tools — `generate_creative`, `draft_copy`, `connect_channel`, `create_campaign`/`create_ad_set`/`create_ad`, `publish_content`, `set_budget`, `pull_metrics`, `optimize_campaign` — all `high-risk` where they publish or spend (spend caps enforced in tool code). See [marketing-growth-engine.md](marketing-growth-engine.md).

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
