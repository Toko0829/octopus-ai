# Module: Business Projects & Workflow Engine

> Owns the venture lifecycle: a project, its RAG-compiled playbook, the persisted task DAG, the per-task state machine, and the scheduler that walks the graph marking tasks READY and dispatching them to AI executors or the human-node escalation subflow. **The contract between the LLM (proposes) and the durable layer (commits).**
>
> **Owner paths:** `packages/core/**` · **Depends on:** ai-orchestrator (planner writes/updates DAG; executors run tasks), rag-knowledge (playbook compilation, grounding), human-nodes-marketplace (escalation subflow), chat-discord (task threads, plan/approval cards), payments-billing (escrow tied to human tasks).
>
> Update on any change to the project/task states, DAG model, scheduler, or router.

## Project lifecycle

`DRAFT → PLANNING → ACTIVE → (PAUSED) → COMPLETED | CANCELLED`

- **DRAFT** — goal captured, not yet planned.
- **PLANNING** — orchestrator decomposing the goal into a RAG-grounded task DAG.
- **ACTIVE** — scheduler dispatching READY tasks.
- **PAUSED** — user kill-switch honored at a safe checkpoint.
- **COMPLETED / CANCELLED** — terminal.

## Playbook model

A **playbook = Business Archetype × Jurisdiction Pack**, compiled by [rag-knowledge](rag-knowledge.md) into a **typed DAG**. Versioned (`playbook_versions`) so a plan is reproducible and auditable. The same compiler that outputs an Austin cafe outputs a Berlin online store or (future) a Tbilisi cafe.

## Task node schema

Each task declares: `owner_type` (AI/HUMAN/USER), `inputs`, `expected_artifact`, `acceptance_criteria`, `deps`, `risk_tier`, `cost_estimate`, `jurisdiction_refs[]`. See [data-model.md](../10-architecture/data-model.md).

## Dependency model

`task_deps` edges are **hard** (must complete first), **soft** (preferred order), or **resource** (shared constraint). The scheduler parallelizes independent branches (the octopus's eight arms).

## Per-task state machine

```
PENDING → READY → ROUTING → { AI_RUNNING → AI_SELF_CHECK | ESCALATED | NEEDS_USER }
ESCALATED → MATCHING → OFFERED → CLAIMED → ESCROW_FUNDED → IN_PROGRESS
          → PROOF_SUBMITTED → IN_REVIEW → APPROVED → PAYOUT_PENDING → PAID → DONE
REJECTED → IN_PROGRESS (bounded re-do)   DISPUTED → ops review
FAILED | CANCELLED → terminal (may trigger replan diff)   BLOCKED → awaiting unblock
```

Every transition is **event-sourced** (immutable) for audit, liability, and disputes.

## Scheduler

Walks the DAG, detects **READY** tasks (all hard deps `APPROVED`), dispatches them, and **reconciles** the graph after each task (replan-by-diff). Honors pause/kill-switch at safe checkpoints.

## Router

Classifies task ownership: **AI** (executor runs it), **HUMAN** (escalation subflow → marketplace), or **USER** (batched question/approval). Driven by the task's flags and the escalation triggers in [ai-orchestrator.md](ai-orchestrator.md).

## Artifacts & verification

Executors write artifacts to Storage with `acceptance_criteria`. **Maker-checker**: an AI critic validates the artifact/proof; higher-risk items also require **user** approval before the task counts as `APPROVED` and unblocks dependents.

## Kill-switch / pause

The durable workflow honors a cancellation signal at the next safe checkpoint; in-flight escrow is handled per [payments-billing.md](payments-billing.md) (freeze/refund as appropriate).

## Key entities

`projects` · `tasks` · `task_deps` · `task_runs` · `artifacts` · `escalations` · `playbook_versions`.

## Relationship to the orchestrator

The orchestrator **proposes** (plans/updates the DAG, runs executors); this engine **commits** (persists state transitions durably, schedules, routes). The split keeps non-deterministic reasoning separate from deterministic, resumable state.
