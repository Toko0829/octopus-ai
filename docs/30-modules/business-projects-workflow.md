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
> **Replan-by-diff is live** (`20260828130000`, `20260828140000`). An owner can ask for a running plan to be changed, and gets a card of add / cancel / modify ops to approve. See "Changing a plan that is already running" below.
>
> **Not built yet:** `playbook_versions` and `escalations`. **Consuming the question before the work succeeds is what makes a race safe and a failure silent.** The card is closed first so a second message cannot answer the same steps twice. The first live answer then hit an invalid enum value, every task failed, the failure was logged per task, and the room said **nothing at all**: the person had answered, the question had vanished, and no step had moved. The card is now **reopened** when nothing completes, so their next message is still read as an answer, and the run says so plainly. Losing a reply is bad; losing it without saying so is worse.

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

## Changing a plan that is already running

`ai-orchestrator.md` has specified "replan by diff, not regeneration, preserving
completed work and audit history" since Phase 0, and nothing produced one,
because there was no way to ask for it. The gap became visible the moment the
project panel did: a person could see fifteen steps, disagree with three, and
have no move available short of abandoning the project and posting a new goal,
which throws away every deliverable already produced.

**Owner-initiated and owner-approved.** `POST /api/projects/:projectId/replan`
takes a reason in the person's own words and returns `202`; the core answers with
a diff; the diff is posted as a `replan` card; approving it runs
`public.apply_plan_diff`, through the ordinary embed-action route. So a change to
a running project crosses the same authorisation boundary the original plan did.
**Automatic replanning after each task is deliberately out of scope**, and the
argument is the one that put plan approval behind a card in the first place: a
model proposing something is not the same as somebody agreeing to it.

**Three ops, and the set is small on purpose.** Everything an owner wants is work
added, work called off, or work whose description was wrong, and each is
separately reviewable on a card. Capped at ten, because a card nobody reads is
not an authorisation.

**`modify_task` cannot change state, owner or risk tier, and that is the safety
property.** Changing who runs a step, or what it is permitted to touch, is a
different piece of work and goes through cancel plus add so the person sees both
halves. Routing an authorisation decision through the op that looks least like
one is exactly what rules 7 and 11 forbid. It is enforced by `apply_plan_diff`
naming three columns rather than accepting a payload, so there is no flag anybody
can pass to widen it, and asserted directly: the pgTAP suite approves a card that
asks for all three and checks the row did not move.

**A stale diff fails rather than half-applying.** The card was written against
the project as it was; by the time it is approved a step may have been approved,
failed or cancelled. An op naming such a step raises and the whole transaction
rolls back, including the ops that had already succeeded. Skipping the impossible
ones would apply a diff nobody reviewed.

**Cancelling a step does not release what depends on it.**
`task_deps_satisfied` counts a dependency satisfied at `approved` or later, and
`cancelled` is neither, so a dependent stays blocked. That is correct rather than
an oversight: work planned to consume an output that will now never exist should
not quietly proceed as though it had one. The prompt tells the model to deal with
dependents in the same diff, the card says so in as many words, and the pgTAP
suite asserts it so nobody later "fixes" it into auto-unblocking.

**A diff cannot reach another room's project.** The card is posted in a room and
names a project in its payload; `apply_plan_diff` checks the project resolves,
through its own plan card, to that same room. Nothing else on the path does: the
action route verifies the caller's membership of the card's room, which says
nothing about the project the payload names.

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

The marketplace half (`MATCHING` through `PAID`) has no code behind it until the matcher lands, **which is slice 4** of the sequence in [human-nodes-marketplace.md](human-nodes-marketplace.md). The states exist anyway: the machine is specified here in full, and adding them later would mean editing it twice and re-deriving arcs already written down. The marketplace **domain tables** landed ahead of it (`20260831120000` … `20260831123000`) with no writer at all, so the states remain unreachable and `escalated` remains a dead end until slice 4 — which is stated rather than implied, because twelve tasks are sitting in it.

### The eight arcs `20260815220000` dropped, and when each comes back

That migration rewrote `private.task_transition_allowed` from plpgsql to SQL to add one arc (`needs_user → approved`) and, in restating the map, **silently lost eight others** the original `20260813120000` had. Nothing asserted they had ever been there, which is why it went unnoticed for two weeks. Every one belongs to the marketplace half, so none was reachable and none has caused a defect — but each has to come back **with the slice that first makes it reachable**, never earlier, because an arc into a state nobody can leave is the `escalated` defect on purpose.

| Arc                             | Restored in | Why not earlier                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matching → failed`             | slice 4     | no eligible node is a real outcome; without it the task strands mid-search                                                                                                                                                                                                                                                                                              |
| `offered → failed`              | slice 4     | the cascade exhausted the pool                                                                                                                                                                                                                                                                                                                                          |
| `claimed → matching`            | **never**   | ❌ slice 5 decided against it ([ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md)): accept and fund are one transaction, so `claimed` is transit-only and the arc has no producer. The no-show path leaves from `escrow_funded` or later, in slice 6                                                                                                       |
| `proof_submitted → in_progress` | **never**   | ❌ slice 6 built the loop and decided against it ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md)). Booked for two uses, and neither survives: retraction has no producer, and the floor check bouncing a bad submission does not need it, because the check runs **before anything is written and before the task moves**, so a bounce leaves the step where it was |
| `escrow_funded → disputed`      | slice 8     | a `disputed` task with no ops console is a state nobody can leave                                                                                                                                                                                                                                                                                                       |
| `in_progress → disputed`        | slice 8     | as above                                                                                                                                                                                                                                                                                                                                                                |
| `rejected → disputed`           | slice 8     | as above                                                                                                                                                                                                                                                                                                                                                                |
| `payout_pending → disputed`     | slice 8     | as above                                                                                                                                                                                                                                                                                                                                                                |

**A ninth nobody had counted: `blocked → failed`.** The universal `p_to in ('cancelled', 'blocked')` rule is evaluated before the `blocked` case, so `blocked → cancelled` survived by accident and `blocked → failed` did not. Recorded here rather than fixed, since nothing writes `blocked` yet either.

`supabase/tests/marketplace_rls.sql` pins two of these as **still absent** (`matching → failed` refused, `escalated → matching` allowed), so slice 4's decision reads as dated rather than as drift.

**Three of the eight are now permanently dropped rather than pending**, and each
has an ADR reversing the booking above:
[ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md) for
the two `→ failed` arcs, and
[ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md) for
`claimed → matching`. That is worth noticing rather than smoothing over: **five
consecutive marketplace slices have restored no arc at all**, which says the
machine `20260813120000` declared was drawn wider than the product has needed.

**`offered → claimed` and `claimed → escrow_funded` were never dropped**, and it
is worth saying so beside this table because slice 5 is the slice that first walks
them. They have been in the map since `20260813120000` and simply had no producer
for a year of commits. `public.accept_offer` (`20260904125000`) walks both, as two
conditional UPDATEs in one transaction, so every guard fires and both moves write
their own `task.transitioned` event.

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

Artifacts are inline text (`body`) when what a step produced is prose, which is everything the AI writes today, and a file in Storage when it is genuinely a file. A database constraint refuses a row with neither, because an artifact with no content is a task that reported success and produced nothing.

**The file half became real in `20260829124000`, and it had been half-built for two weeks.** `storage_path` existed, `Artifact.storagePath` was on the wire, the project route selected it, and the panel had an arm that said "This one is a file rather than text." There was no bucket, no policy, no reader and no writer, so that arm was reachable only by a row nobody could create. What exists now:

- **A private bucket**, path `<project_id>/<artifact_id>/<filename>`. The first segment is the tenant and the `storage.objects` select policy reads it, so a file written anywhere else in the bucket is visible to nobody.
- **`GET /api/projects/:projectId/artifacts/:artifactId/file-url`**, which reads the artifact row **as the caller** (RLS row visibility is the authorization) and then mints a ten-minute signed URL with the service key. The URL is a bearer capability: minted per click, never stored, never logged.
- **`writeFileArtifact`** in `apps/api/src/lib/artifact-files.ts`, which uploads the object and writes the row together and **removes the object if the row fails**. Postgres has no transaction across object storage, so the compensation is explicit. Row-first would be worse: it satisfies the check constraint while pointing at nothing, and the panel would list a delivered artifact that 404s on download.
- **A Download control** in the project panel, where the sentence used to be.

**Uploads are Node-initiated only.** The Python service has no storage keys by design ([ADR-0006](../40-adr/0006-python-ai-service-node-backend.md)) and never handles bytes, so `WriteArtifactProposal` and `ArtifactEmbedPayload` are unchanged and there is **no file-producing proposal kind**. A wire shape designed before its first producer is a guess, and unknown kinds already fail loudly; that seam changes when a byte-producer exists.

**`writeFileArtifact` got its first production caller in slice 6**, having been written, tested and never invoked since `20260829124000`. A node hands over proof through `POST /api/node/engagements/:id/proof`, which is the only multipart route in this API. One defect went with it: the writer hardcoded `created_by: 'agent'`, which was harmless while it had no caller and would have made every proof lie about its author; it takes a `createdBy` now.

### A second maker, and a second checker for it ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md))

Slice 6 adds the other kind of maker: **a person**. Their proof is an `artifacts` row with `kind = 'proof'` rather than a table of its own, and the ADR records why a second deliverable table loses.

`review` is the wrong checker for it. Its three real checks are about **citations**, and a node's proof cites nothing by construction: it is evidence that something happened in the world, not a claim resting on a retrieved source, so `lost_grounding` would fail every proof ever submitted and `fabricated_citation` could never fire. `reviewProof` sits beside it:

| Failure                | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `empty_proof`          | nothing was handed over, or only files with no word about them |
| `too_short`            | "done" rather than a hand-off                                  |
| `unaddressed_criteria` | a thing the step asked for has no answer against it            |

The third is what gives **`tasks.acceptance_criteria` its first consumer** since `20260816120000`, which named this as the cost it was accepting: "backfilling criteria for finished work is far more expensive than emitting them with the step."

**It cannot approve anything**, and that is the difference from the AI path rather than a detail. `nextStateAfterProofReview` returns only `in_review` or `in_progress`: a failure returns the step to the node with its reasons, and there is no attempt counter, because a person who left a field blank fixes it in ten seconds and a limit would eventually strand somebody mid-task with money held against work they are still trying to deliver. Deciding that a person's work is finished, and therefore that they are owed money, is the owner's.

**No LLM judge, and the argument is stronger than it was above.** There the risk is a flaky verdict propagating through the graph; here the gate stands between a person and being paid, and `stage-skills.ts` already refused to hand a model authority over which humans get work.

## What else lives in `packages/core`

`decideIntakeTurn` sits here for the same reason the router does: it is a decision, it has no IO, and a reader should be able to check it without running anything. It answers whether a new chat message is a fresh goal or the answer to an open intake question, which is genuinely ambiguous on the wire, since both arrive as a message that starts an agent run.

Two of its rules are safety rather than convenience. **Only the room's owner can answer**, because intake answers state the person's own budget, customers and timeline and a human node in the room must not supply those; the embed's `required_role` cannot enforce it, since an answer never reaches the action route. And **the round cap is enforced here too**, not only in the AI service, so a card written before the cap changed cannot hold someone in an interrogation. It belongs to intake rather than to the DAG; see [ai-orchestrator.md](ai-orchestrator.md).

## Kill-switch / pause

The durable workflow honors a cancellation signal at the next safe checkpoint; in-flight escrow is handled per [payments-billing.md](payments-billing.md) (freeze/refund as appropriate).

## Key entities

`projects` · `tasks` · `task_deps` · `task_runs` · `artifacts` · `escalations` · `playbook_versions`.

## Relationship to the orchestrator

The orchestrator **proposes** (plans/updates the DAG, runs executors); this engine **commits** (persists state transitions durably, schedules, routes). The split keeps non-deterministic reasoning separate from deterministic, resumable state.

## `matching` and `offered` have producers now (slice 4)

Both states were declared by `20260813120000` and had no code behind them for the
length of the project. As of `20260903120000`:

- **`escalated → matching`** is the owner clicking "Find an expert" on the project
  panel, through `find_expert` on the resolution route. Not a sweep: a sweep
  claiming every escalated step on deploy would have pushed twelve live tasks at a
  cold-start pool and removed the two controls that already worked.
- **`matching → offered`** is the matcher sweep inserting one offer.
- **`offered → matching`** is the cascade, after a decline or a 48-hour expiry.
- **`matching → escalated`** is exhaustion: nobody left to ask, so the step returns
  to its owner with a message
  ([ADR-0018](../40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)).

**`matching → failed` and `offered → failed` stay dropped.** They were booked to
this slice and the slice decided against them: `failed` is terminal, it would block
every dependent step, and it would put beyond reach work the owner can still take.
The ADR dates the reversal and `marketplace_rls.sql` carries the corrected wording.

- **`offered → claimed → escrow_funded`** is acceptance, both moves inside
  `public.accept_offer`'s single transaction. `claimed` is therefore **never
  observable**, which is the premise
  [ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md) rests on and the
  reason `claimed → matching` stays dropped.

**The sweep is the clock's side of this domain, and `accept_offer` is the person's
side.** That sentence replaces "the sweep is the single writer of `tasks.state`
here", which was true while a node could only decline: the decline route settles
the offer row and stops, and the next tick moves the task. Acceptance changed it,
because accepting and funding are inseparable and there is nothing safe to leave
half done.

**What keeps them apart is not a single writer, it is that every move on both
sides is a conditional UPDATE on the row it read**, so a loser performs nothing
rather than overwriting a winner. Sweep first: the accept's `status = 'open'`
conditional matches zero rows and the whole transaction unwinds. Accept first: all
three sweep phases read states the accepted pair no longer occupies. They cannot
interleave past each other, because the cascade only moves a task whose latest
offer is already settled. Walked through in `match.ts`'s header and in
`accept_offer`'s, and asserted in `match.test.ts`.

**`escrow_funded → in_progress` has its producer, as of slice 6**, and so does
every other arc between it and `approved`. A node starts the step, hands it over
with a note and optional files, and the owner approves it or sends it back.

**The core loop needed no migration**, which is worth stating plainly because it
is what this table exists to make possible: every arc it walks
(`escrow_funded → in_progress`, `rejected → in_progress`,
`in_progress → proof_submitted`, `proof_submitted → in_review`,
`in_review → approved | rejected`) has been in the map since `20260813120000`
with nothing able to walk it. Slice 6 supplied walkers and changed no arc.

**`in_review` is transit-only.** A submission lands at `proof_submitted` and
stays there until somebody looks, because that is the honest state; the owner's
action walks `proof_submitted → in_review → approved | rejected` as two
conditional updates in one request, which is `accept_offer`'s idiom and makes
`in_review` unobservable for the same reason `claimed` is
([ADR-0019](../40-adr/0019-claimed-to-matching-stays-dropped.md)).

**The AI cannot reach `approved` on a human step.** `reviewProof` in
`packages/core` returns only `in_review` or `in_progress`: deciding that a
person's work is finished, and therefore that they are owed money, is not a
verdict a deterministic floor check or a model gets to make. It is also the first
consumer `tasks.acceptance_criteria` has ever had.

**A human step now runs all the way to `done`** (marketplace slice 7,
`20260907120000`…`123000`). The ticker's payout sweep moves it
`approved → payout_pending`, and `public.settle_payout` walks
`payout_pending → paid → done` in the same transaction that releases the escrow
hold and ends the engagement. `paid` is transit-only in the sense `in_review`
already was: a step passes through it, and one found sitting in it is one whose
sweep died. That slice needed **no migration to this machine** — every arc it
walks was declared by `20260813120000` and walkable by nothing — which makes two
consecutive slices where the answer to "which migration adds the arc" is "none".

### `done` has a producer on the human arm and none on the AI arm

Worth stating plainly, because it is this module's gap rather than the
marketplace's, and because somebody reading `task_state` would reasonably assume
otherwise.

Until slice 7 **nothing in this system had ever reached `done`**. AI work stops at
`approved`, where the executor leaves it after the checker passes; owner-resolved
work stops at `approved` too; and `task_deps_satisfied` counts `approved` as
satisfied, so the graph never needed anything further. The panel labels `approved`
as "Done" and `DONE_STATES` in `project-progress.ts` includes it. So `done` was
vestigial rather than missing — until a step could be paid for, at which point
stopping at `paid` would have left a finished, settled step non-terminal forever.

`settle_payout` therefore produces `done`, **for human steps only**. The
consequence for the AI arm is small but real and is not being glossed:
`private.task_state_is_terminal` is `('done','failed','cancelled')`, and "anything
non-terminal may be CANCELLED" is a universal rule in this map, so **a kill switch
can still cancel an AI step that already produced its artifact and passed its
check**. Nothing bad happens to money there — an AI step has no engagement and no
hold, which is exactly why the payout sweep's join skips it without asking whose
step it is — but the audit trail can record a finished piece of work as cancelled.

It was deliberately **not** closed from a marketplace slice. `approved → done` on
an AI step involves no money, its producer would be `executor.ts`, and closing
another module's arc from inside one whose subject is a state machine is how a
repository ends up with two half-owners of one map. The trigger to build it is the
first cancellation that lands on an already-approved AI step, or the first reader
who needs "finished" to mean one state rather than two.
`supabase/tests/marketplace_payout.sql` asserts the absence, so the gap fails a
test's description rather than being rediscovered.
