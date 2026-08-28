# Module: Business Projects & Workflow Engine

> Owns the venture lifecycle: a project, its RAG-compiled playbook, the persisted task DAG, the per-task state machine, and the scheduler that walks the graph marking tasks READY and dispatching them to AI executors or the human-node escalation subflow. **The contract between the LLM (proposes) and the durable layer (commits).**
>
> **Owner paths:** `packages/core/**` · **Depends on:** ai-orchestrator (planner writes/updates DAG; executors run tasks), rag-knowledge (playbook compilation, grounding), human-nodes-marketplace (escalation subflow), chat-discord (task threads, plan/approval cards), payments-billing (escrow tied to human tasks).
>
> Update on any change to the project/task states, DAG model, scheduler, or router.
>
> **Implementation status (Phase 2, in progress):** the **schema and both guards are live and applied** (`20260813120000_workflow_dag.sql`, hardened by `20260813130000`). `projects`, `tasks`, `task_deps`, `task_runs` and the append-only `events` log exist; the per-task state machine below is enforced by a trigger; the graph's acyclicity and single-project containment are enforced by another; and `private.task_deps_satisfied` answers the scheduler's READY question. Verified against the live database: `supabase/tests/rls_workflow.sql`, **33/33**.
>
> Built in this order deliberately. Both candidate durable runners ([ADR-0001](../40-adr/0001-durable-orchestration-trigger-vs-temporal.md) pins Trigger.dev, which is blocked on credentials) drive this structure and neither defines it, so building a runner first means building a runtime with nothing to run.
>
> **Approving a plan now materialises it** (`20260813140000`). `public.materialise_plan(embedId)` creates the project and one task per step in a single transaction, reading the payload from the card itself so what was approved is what gets built, and idempotent per card so a retry cannot produce a second project. Verified against the live database: `supabase/tests/materialise_plan.sql`, **19/19**. Details in [architecture.md](../10-architecture/architecture.md).
>
> **The scheduler and router are live** in `packages/core` (`20260813150000` adds their selection query). Approving a plan runs one tick immediately, so a person who just approved something sees where each step went.
>
> **The AI executor and the checker are live too** (`20260813160000` adds `artifacts`). An AI-owned task now runs end to end: `ROUTING → AI_RUNNING → AI_SELF_CHECK → APPROVED`, producing a cited artifact, and **an approved task satisfies its dependents**, so the graph actually moves. 32 Node tests; `supabase/tests/artifacts.sql` 12/12 against the live database.
>
> **The ticker is live** ([ADR-0010](../40-adr/0010-postgres-durable-runner.md)): a periodic pass reclaims runs whose worker died and walks every active project's graph, holding a lease so only one instance ticks. Approving a plan still ticks inline, so the interactive path never waits on the interval.
>
> **The graph has edges now** (`20260828120000`). The planner states which steps consume which other steps' output, and `materialise_plan` writes them as `hard` `task_deps` rows, so `task_deps_satisfied` and `private.tasks_ready` are enforcing a real graph rather than an empty set for the first time. See "Where the edges come from" below.
>
> **Not built yet:** `playbook_versions`, `escalations`, and replan-by-diff. **Consuming the question before the work succeeds is what makes a race safe and a failure silent.** The card is closed first so a second message cannot answer the same steps twice. The first live answer then hit an invalid enum value, every task failed, the failure was logged per task, and the room said **nothing at all**: the person had answered, the question had vanished, and no step had moved. The card is now **reopened** when nothing completes, so their next message is still read as an answer, and the run says so plainly. Losing a reply is bad; losing it without saying so is worse.

**An answered step is a finished step, and the machine had to say so.** The only arc out of `NEEDS_USER` was back to `ROUTING`, where the router applies rule 2 to a `user`-owned task and returns it to `NEEDS_USER`: the answer had nowhere to land and the loop had no end. Nothing failed, the task simply waited forever. `20260815220000` adds `NEEDS_USER → APPROVED`, and the semantics are the point rather than a convenience: the plan gave that person work only they could do, so answering **is** doing it, and `APPROVED` is the state that satisfies dependents. The answer is stored as an artifact `created_by: 'user'` with **no citations**, deliberately, since a person's own decision rests on no retrieved source and attaching one would attribute their judgement to the corpus. The checker never sees it: a human answering is not a maker to be checked.

**A waiting task now says so.** A tick that leaves steps in `NEEDS_USER` or `ESCALATED` posts one digest into the project's room, batched rather than one message per task, because `ai-orchestrator.md` requires digests and `vision.md` counts user touches as a guardrail to drive down. The two are **not merged**: only one is actionable, and a task waiting on an expert is waiting on a marketplace that does not exist, so the copy says that plainly instead of implying somebody is on their way.

## A step that stopped can be dealt with

`ESCALATED` meant "an expert should do this", and its only arc was `MATCHING`, the
first state of a marketplace that does not exist. Every step routed there was
**permanently stuck**: the other two exits, `CANCELLED` and `BLOCKED`, both say the
work will not happen rather than that somebody else will do it. Measured on the
live database: **17 steps across four projects that nobody could move, ever.**

That was survivable while nothing displayed it. The panel above now shows a person
"Needs an expert" beside work they are perfectly capable of doing, with no way to
act, so `20260827120000` gives `ESCALATED` the two arcs `NEEDS_USER` already had.
The argument is `20260815220000`'s, transferred: the plan gave the work to an
expert who cannot be brought in, so the owner taking it on **is** doing the step,
and `APPROVED` is what satisfies dependents. Their write-up is stored as an
artifact `created_by: 'user'` with no citations, because a person's own work rests
on no retrieved source.

**Retrying needed more than an arc.** A tick selects only `PENDING` tasks, so a
step parked in `ROUTING` is invisible to it and `ESCALATED -> ROUTING` on its own
would have swapped one dead end for another. `retryTask` in `@octopus/core` drives
the same path a tick drives, sharing `dispatchRouted` with it so there is one
definition of what happens after routing rather than two that drift.

**Retrying changes nothing by itself, and the copy says so.** The router applies
the same rules to the same task, so a step escalated for want of citations
escalates again. It is worth taking when something else changed, typically a
source the corpus was missing, which `POST /sources` exists to supply.

**This is not the marketplace.** `MATCHING` is untouched and nothing here presumes
what the matcher will do. It gives an owner a way to unstick their own project,
and the copy never implies an expert is on the way.

## The work is now visible

`GET /api/rooms/:roomId/projects` and `GET /api/projects/:projectId` expose the
DAG, and `ProjectPanel.tsx` renders it. Everything in this document, the states,
the router's verdicts, the artifacts, existed only as rows a developer with SQL
could reach; a person who approved a plan saw a digest and then a scrolling chat.

Two properties of the view are decisions rather than presentation:

- **Waiting and escalated are never added together.** A step in `NEEDS_USER` is
  something the person can act on. A step in `ESCALATED` is waiting on a
  marketplace that does not exist, so the copy says that plainly rather than
  implying somebody is on their way, which is the rule the waiting digest already
  follows.
- **Progress counts `APPROVED` as done**, matching `task_deps_satisfied` rather
  than waiting for `PAID`. If the number a person reads disagreed with the one the
  scheduler acts on, one of them would be lying.

## Project lifecycle

`DRAFT → PLANNING → ACTIVE → (PAUSED) → COMPLETED | CANCELLED`

- **DRAFT** — goal captured, not yet planned.
- **PLANNING** — orchestrator decomposing the goal into a RAG-grounded task DAG.
- **ACTIVE** — scheduler dispatching READY tasks.
- **PAUSED** — user kill-switch honored at a safe checkpoint.
- **COMPLETED / CANCELLED** — terminal.

### Starting something else while a question is open

`decideIntakeTurn` reads every message from the room owner as a reply to whatever the room is waiting for. That is right almost always, and it had no way out. It cost a real goal: four steps were waiting on decisions, the person typed a brand new request, and it was filed as the answer to all four. Nothing failed, and what they actually asked for was gone.

A message beginning `new goal:` (or `new:`) is now read as a new goal, and the stale card is moved to `dismissed` before planning, conditionally on `pending` so two runs racing cannot both act on it. The question and the waiting digest both advertise it, because an escape nobody is told about is not one.

**No content heuristic decides this.** Guessing whether a sentence is "a new topic" would be wrong in both directions, and the expensive direction is discarding an answer somebody was asked for. An explicit prefix is unambiguous. `new goal:` with nothing after it leaves the card open rather than planning for an empty string.

## Playbook model

A **playbook = Business Archetype × Jurisdiction Pack**, compiled by [rag-knowledge](rag-knowledge.md) into a **typed DAG**. Versioned (`playbook_versions`) so a plan is reproducible and auditable. The same compiler that outputs an Austin cafe outputs a Berlin online store or (future) a Tbilisi cafe.

## Task node schema

Each task declares: `owner_type` (AI/HUMAN/USER), `inputs`, `expected_artifact`, `acceptance_criteria`, `deps`, `risk_tier`, `cost_estimate`, `jurisdiction_refs[]`. See [data-model.md](../10-architecture/data-model.md).

## Dependency model

`task_deps` edges are **hard** (must complete first), **soft** (preferred order), or **resource** (shared constraint). The scheduler parallelizes independent branches (the octopus's eight arms).

## Where the edges come from

For two weeks this table existed, was indexed, was guarded against cycles and
cross-project edges, and **held no rows**. `materialise_plan` said why, and the
reason was right at the time: the planner emitted stages and steps, so the only
edges available would have been inferred from stage order, and "strategy must
finish before content" is a constraint nobody stated. The consequence was that
every plan was flat and one tick dispatched all of it at once.

`PlanStep` now carries an `id` and a `depends_on`, and three rules govern them.

**The planner states edges; nothing infers them.** Stage order is still
presentation. A step depends on another only when it consumes that step's output,
which is the one relationship the planner is asked about, and the prompt tells it
to leave the edge out when unsure. `materialise_plan` writes exactly what the card
says and derives nothing.

**Every edge is `hard`.** That is what "consumes the output of" means, and it is
the only kind the scheduler consults anyway. `soft` and `resource` stay in the
enum for orderings and shared constraints nothing produces yet; picking between
them here would mean guessing which the model meant.

**A bad edge never costs a plan, and a bad edge never reaches the table.** Those
are two different layers doing opposite things on purpose. In `services/ai`,
`plan_graph.sanitise_dependencies` drops a reference that resolves to nothing and
flattens the graph entirely on a cycle or a duplicate id, because a plan is worth
far more than its edges and a flat plan is exactly what shipped before this
existed. In Postgres, `materialise_plan` **raises** on an unresolvable reference
or a duplicate id, and the acyclicity trigger raises on a cycle. The layering is
the same one the risk tier uses: the model proposes, code repairs what is safe to
repair, and the database refuses to guess about anything that still reaches it,
because a card can also arrive from an older service, a replay or a hand edit.
Every repair is logged, since the recurring defect in this repository is never the
drop itself but the silence around it.

**Nothing ticks when a task is approved, and that is a decision.** Approving a
task now unblocks its dependents, so the obvious move is for the executor to run a
tick when the critic passes. It does not. The executor's contract is to finish the
task it was given, and the 30-second ticker already walks every active project, so
correctness is covered; what an inline tick would buy is latency, against a step
that costs roughly 70 seconds of reranking anyway. It would also race the ticker
into logging refused transitions that are not failures. The cost is that a chain
of N dependent steps takes up to N ticker intervals longer than it used to, which
is recorded here rather than left for somebody to measure and call a regression.

**Also not built, and named rather than implied:** the project panel shows a
blocked step as `pending` with no indication of what it is waiting for. That is
accurate and uninformative, and fixing it needs the API to return each task's
dependencies, which is a wider change than this one.

## Per-task state machine

```
PENDING → READY → ROUTING → { AI_RUNNING → AI_SELF_CHECK | ESCALATED | NEEDS_USER }
NEEDS_USER → APPROVED (the person answered, and their answer is the deliverable)
           → ROUTING  (the answer changes what should happen next)
ESCALATED  → APPROVED (the owner did it themselves; their write-up is the deliverable)
           → ROUTING  (another attempt, worth taking when something changed)
ESCALATED → MATCHING → OFFERED → CLAIMED → ESCROW_FUNDED → IN_PROGRESS
          → PROOF_SUBMITTED → IN_REVIEW → APPROVED → PAYOUT_PENDING → PAID → DONE
REJECTED → IN_PROGRESS (bounded re-do)   DISPUTED → ops review
FAILED | CANCELLED → terminal (may trigger replan diff)   BLOCKED → awaiting unblock
```

Every transition is **event-sourced** (immutable) for audit, liability, and disputes.

**This machine is enforced in Postgres, not in the runner.** `private.task_transition_allowed` holds the arcs and a `before update` trigger on `tasks` applies them, so an illegal jump is refused for `service_role` and superuser alike. That placement is the point: a task moved straight to `APPROVED` is a task that gets paid for without being done, and the guard has to outlive whichever orchestrator is current when someone tries it.

Two rules are expressed once rather than drawn on every state, because listing them twenty times is twenty chances to forget one: anything non-terminal may be **CANCELLED** (the kill switch must not have states it cannot reach) and anything non-terminal may become **BLOCKED**. Terminal is checked first, so no arc can resurrect a cancelled task.

The diagram above is the specification and the code is derived from it, including the arcs the diagram implies but does not draw: a critic that passes (`AI_SELF_CHECK → APPROVED`), a user who answers (`NEEDS_USER → APPROVED` when their answer **is** the step, `NEEDS_USER → ROUTING` when it changes what happens next), an offer that expires back into the cascade (`OFFERED → MATCHING`), and the two exits from `APPROVED` (`→ DONE` for AI work, `→ PAYOUT_PENDING` for work somebody is owed for). Where the two disagree, this doc is right and the code is the bug.

The marketplace half (`MATCHING` through `PAID`) has no code behind it until the matcher lands. The states exist anyway: the machine is specified here in full, and adding them later would mean editing it twice and re-deriving arcs already written down.

## Scheduler

Walks the DAG, detects **READY** tasks (all hard deps `APPROVED`), dispatches them, and **reconciles** the graph after each task (replan-by-diff). Honors pause/kill-switch at safe checkpoints.

The predicate is live as `private.task_deps_satisfied(task)`, and two of its choices are deliberate. Only **hard** dependencies block: soft is an ordering preference and resource is a shared-constraint hint, so treating either as blocking would stall a graph that is progressing perfectly well. And a dependency counts as satisfied at **`APPROVED` or later**, not at `DONE`, because a dependent step can start once the work it needed is accepted, where waiting for `PAID` would hold the whole graph on a bank transfer.

**The graph is guaranteed acyclic by the database**, not by the code that builds it. A cycle makes "are all hard deps done" unanswerable, and the failure is silent: the project simply never advances. Edges also cannot cross projects, or one tenant's graph could block another's and the project would stop being a unit of cancellation.

**One tick, and what it deliberately will not do.** `packages/core/src/scheduler.ts` walks each ready task through `PENDING → READY → ROUTING → target`. Every hop is a real transition through the trigger, so each is validated and each writes an event; collapsing them would be faster and would lose the record of a task having been routed at all.

A task routed to `AI_RUNNING` **only gets there if an executor was supplied**. One now is, so those tasks run; without it the tick reports `awaiting_executor` and leaves them in `ROUTING`, which stays a supported configuration for any caller that only wants to classify work. The rule behind it holds either way: `AI_RUNNING` asserts the AI is running it, and setting it with nothing behind it would put a false statement in the audit trail. `ESCALATED` and `NEEDS_USER` are not held back, because both mean "waiting for someone" and both are true the moment they are set, marketplace or no marketplace.

**Once dispatched, the task is the executor's, not the scheduler's.** The scheduler only ever selects `PENDING` tasks, so it will never revisit this one; the retry loop therefore lives in the executor rather than being left to a future tick that would not come.

**A refused transition must arrive with its reason, and for a while it did not.** supabase-js returns errors as plain objects rather than `Error` instances, so the tick's `String(err)` collapsed every database refusal to `[object Object]`. Sixteen tasks failed on every tick for an hour while the log named nothing, and the message it was discarding identified the missing privilege exactly. The adapter now converts a Postgrest error into a real `Error` carrying its code and details, and the tick serialises anything else rather than stringifying it.

A tick is a **best-effort sweep, not a transaction**. One task that fails to transition does not stop the others, because the alternative is that a single unroutable task freezes the project and every subsequent tick finds the same state and freezes again. Failures are recorded, never swallowed: the guard in Postgres is the authority, so a scheduler that quietly skipped its refusals would be hiding the disagreement.

**Selection is not its job.** `private.tasks_ready` answers which tasks are ready, in SQL, so there is one definition. A TypeScript reimplementation would be a second, and they would drift the first time the dependency semantics changed.

## Router

Classifies task ownership: **AI** (executor runs it), **HUMAN** (escalation subflow → marketplace), or **USER** (batched question/approval). Driven by the task's flags and the escalation triggers in [ai-orchestrator.md](ai-orchestrator.md).

**`owner_type` is what the planner proposed, not what the router decides**, and that distinction is the whole reason this component exists. The planner is a language model, so its opinion about who should do something is an input. A router that simply believed it would put authorisation back in the prompt, which is what rules 7 and 11 forbid.

Live in `packages/core/src/router.ts`, pure and tested. Five rules, in priority order, and the order is the safety property:

| #   | Rule                                      | Target       | Why                                                                                                                                                                                             |
| --- | ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `high_risk`                               | `needs_user` | Irreversible or money-moving work always asks the person. **Outranks `owner_type`**, so a plan marking such a step `AI` is exactly what this catches.                                           |
| 2   | owner `user`                              | `needs_user` | A decision, an authorisation, or a fact only they have.                                                                                                                                         |
| 3   | owner `human`                             | `escalated`  | Judgement, taste, relationships, access.                                                                                                                                                        |
| 4   | owner `ai`, no citations, not `read_only` | `escalated`  | Rule 10 applied to work rather than prose. Letting the AI act on an uncited step would make the citation requirement cosmetic: the claim flagged unverified while the action it gates proceeds. |
| 5   | owner `ai`                                | `ai_running` | The ordinary case.                                                                                                                                                                              |

Rule 4 exempts `read_only` deliberately. Research that changes nothing gates nothing, and escalating it would bury the marketplace in zero-risk work, which is how a safety rule ends up switched off.

**Rules 1 and 4 both read a column that nothing wrote until `20260816120000`, and it is worth recording how long that went unnoticed.** `risk_tier` has existed since `20260813120000` and `materialise_plan` never set it, so every task built from a plan card took the default `reversible`. Rule 1 could therefore never fire on a real plan, and rule 4's `read_only` exemption could never apply, meaning every uncited AI step escalated. The rules were implemented, unit-tested and written down in three documents; the producer was missing, and nothing in a type check, a lint or a pgTAP suite asks whether a column anybody writes. The tier is now proposed per step by the planner, raised in code where the step commits to an act ([ai-orchestrator.md](ai-orchestrator.md)), and carried onto the row by `materialise_plan`, with an unrecognised value raising rather than defaulting. `supabase/tests/materialise_plan.sql` asserts an AI-owned `high_risk` step reaches the table as `high_risk`, which is the fact rule 1 depends on and the one that was false.

Every decision carries the **rule that fired**, recorded as a `task.routed` event rather than re-derived later. "Why did this escalate" is the first question anyone debugging a stuck project asks, and reconstructing it after the fact means guessing at the inputs the task had at the time.

## Artifacts & verification

Executors write artifacts to Storage with `acceptance_criteria`. **Maker-checker**: an AI critic validates the artifact/proof; higher-risk items also require **user** approval before the task counts as `APPROVED` and unblocks dependents.

**The maker** is `services/ai`'s `/execute`, and it re-retrieves for the step rather than inheriting the plan's sources. The plan was retrieved for a whole goal, and the sources that justified "you need positioning work" are broader than the ones that help write the positioning; reusing them hands the model the goal's context to answer a much narrower question, which is the mismatch decomposition exists to fix one level up. It runs through the **same groundedness gate as planning**, applied where it matters more: a plan citing loosely-related sources is a bad suggestion, a deliverable that does is work someone will use. Refusing to execute is a correct outcome and escalates rather than retrying, since asking the same core about the same corpus produces the same refusal more slowly.

**The checker is deterministic, and that is a decision.** This doc says "AI critic", and an LLM judge is the obvious reading; the project already rejected that shape for the generation eval because a judge bills per call and returns a different answer each time. The reasoning is stronger here, because this verdict decides whether a task **unblocks its dependents**, so a flaky one propagates through the graph. `packages/core/src/critic.ts` checks what is checkable and refuses to pretend about the rest:

| Failure               | Meaning                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `empty_output`        | the step produced nothing                                              |
| `too_short`           | a stub rather than a draft                                             |
| `lost_grounding`      | a step the plan cited now cites nothing (rule 10, applied to the work) |
| `fabricated_citation` | names a source it was never given                                      |

It cannot tell you whether the positioning advice is good. It can tell you the maker returned nothing or invented a source, and those are the failures that otherwise reach a person as confident output. An LLM critic belongs **on top of** this later, once these floor conditions hold, not instead of it.

`fabricated_citation` never retries: asking the same maker again is how you get a second invented source, so it escalates immediately. Everything else gets one bounded re-do, because "produced nothing" is the kind of failure a retry plausibly fixes. **Each attempt is its own `task_runs` row**, so a retry never erases why the previous one failed.

Artifacts are inline text (`body`) rather than Storage for now: the only thing the AI produces today is prose, and putting a paragraph in object storage would mean a fetch to read it and a bucket policy to get right. `storage_path` arrives with the first artifact that is genuinely a file. A database constraint refuses a row with neither, because an artifact with no content is a task that reported success and produced nothing.

## What else lives in `packages/core`

`decideIntakeTurn` sits here for the same reason the router does: it is a decision, it has no IO, and a reader should be able to check it without running anything. It answers whether a new chat message is a fresh goal or the answer to an open intake question, which is genuinely ambiguous on the wire, since both arrive as a message that starts an agent run.

Two of its rules are safety rather than convenience. **Only the room's owner can answer**, because intake answers state the person's own budget, customers and timeline and a human node in the room must not supply those; the embed's `required_role` cannot enforce it, since an answer never reaches the action route. And **the round cap is enforced here too**, not only in the AI service, so a card written before the cap changed cannot hold someone in an interrogation. It belongs to intake rather than to the DAG; see [ai-orchestrator.md](ai-orchestrator.md).

## Kill-switch / pause

The durable workflow honors a cancellation signal at the next safe checkpoint; in-flight escrow is handled per [payments-billing.md](payments-billing.md) (freeze/refund as appropriate).

## Key entities

`projects` · `tasks` · `task_deps` · `task_runs` · `artifacts` · `escalations` · `playbook_versions`.

## Relationship to the orchestrator

The orchestrator **proposes** (plans/updates the DAG, runs executors); this engine **commits** (persists state transitions durably, schedules, routes). The split keeps non-deterministic reasoning separate from deterministic, resumable state.
