"""Wire schemas for the Node/Python seam.

These Pydantic models are the source of the service's OpenAPI document, which the
Node side consumes (ADR-0004 and ADR-0006). Changing a field here changes the
contract, so treat it like `packages/contracts`.

The central invariant of ADR-0006 is expressed in the types: this service returns
*proposals*. It never returns a result that implies it wrote anything, because it
cannot write. Node decides whether to act on a proposal and is where authz and
spend caps live.
"""

from typing import Literal

from pydantic import BaseModel, Field


class TraceContext(BaseModel):
    """Correlation IDs threaded through every service (observability.md).

    Carried explicitly across the seam rather than inferred, so a log line in
    Python can be pivoted back to the exact project and run in Node.
    """

    project_id: str | None = Field(default=None, description="The venture, when one exists.")
    agent_run_id: str = Field(description="The durable run this reasoning step belongs to.")
    room_id: str | None = Field(
        default=None,
        description=(
            "The workspace this step belongs to. A correlation id like the others, and "
            "also the retrieval scope: a room's own business documents are returned to "
            "that room and to nobody else. Optional so an older caller still validates, "
            "and absent means the shared corpus alone."
        ),
    )


class Citation(BaseModel):
    """A retrieved source backing a claim. Every one carries its effective date.

    Empty until RAG lands. An empty list is not "no sources needed"; it means the
    output is ungrounded, which is what `Proposal.grounded` reports.
    """

    source_id: str
    label: str
    url: str | None = None
    effective_date: str | None = None


class PostMessageProposal(BaseModel):
    """Propose that Node post a message to the room as the agent.

    Node performs the insert (`author_kind='agent'`), so RLS, idempotency and the
    audit trail all stay in the Postgres world.
    """

    kind: Literal["post_message"] = "post_message"
    body: str = Field(min_length=1, max_length=4000)


FUNNEL_STAGES = (
    "strategy",
    "content",
    "creative",
    "channels",
    "conversion",
    "measurement",
)

StageKey = Literal["strategy", "content", "creative", "channels", "conversion", "measurement"]

RISK_TIERS = ("read_only", "reversible", "external", "high_risk")

RiskTier = Literal["read_only", "reversible", "external", "high_risk"]


# A step id: lowercase, digits and hyphens, short enough to read in an audit
# event. Constrained rather than free text because it is a join key on the other
# side of the seam: `materialise_plan` builds an id -> task uuid map from it.
STEP_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{0,31}$"


class PlanStep(BaseModel):
    """One concrete action inside a funnel stage."""

    id: str | None = Field(
        default=None,
        pattern=STEP_ID_PATTERN,
        description=(
            "A short slug naming this step within this plan, so other steps can "
            "depend on it. Human-readable ('positioning-icp'), because it appears "
            "in audit events."
        ),
    )
    depends_on: list[str] = Field(
        default_factory=list,
        max_length=8,
        description=(
            "Ids of steps whose OUTPUT this step consumes. Hard dependencies only: "
            "the scheduler blocks on nothing else (see task_deps_satisfied). Coming "
            "later in the funnel is not a dependency."
        ),
    )
    title: str = Field(min_length=1, max_length=120)
    detail: str = Field(min_length=1, max_length=600)
    owner: Literal["AI", "HUMAN", "YOU"] = Field(
        description=(
            "Who executes this. AI runs autonomously; HUMAN needs an expert node; "
            "YOU needs the person (a decision, an authorisation, or a fact only they have)."
        )
    )
    citations: list[int] = Field(
        default_factory=list,
        description=(
            "1-based indices into PlanResponse.citations. A step with no citation is a "
            "step the corpus does not support, which the UI must show as unverified "
            "rather than render identically to a grounded one (AGENTS.md rule 10)."
        ),
    )
    risk_tier: RiskTier = Field(
        default="reversible",
        description=(
            "What running this step would do to the outside world. Mirrors "
            "public.task_risk_tier. The model proposes it per step; risk.clamp_risk_tier "
            "may raise it and can never lower it, because an authorisation decision the "
            "model can talk its way out of is not an authorisation decision."
        ),
    )
    acceptance_criteria: list[str] = Field(
        default_factory=list,
        max_length=3,
        description=(
            "Up to three checkable statements about what the finished step must contain. "
            "Checkable means a reader can say yes or no by looking at the artifact."
        ),
    )


class PlanStage(BaseModel):
    """One of the six funnel stages, which may legitimately be empty.

    An empty `steps` list is meaningful output, not missing output: it says the
    corpus had nothing in scope for this stage. Padding it from parametric
    knowledge is the exact failure RAG exists to prevent, and a plan that looks
    complete while resting on nothing is worse than one with a visible gap.
    """

    stage: StageKey
    steps: list[PlanStep] = Field(default_factory=list, max_length=3)


class ProposePlanProposal(BaseModel):
    """Propose that Node persist a structured plan and render it as a card.

    Separate from `post_message` because Node must treat it differently: it writes
    an embed row as well as a message, and the embed carries `required_role`, so
    the approve action is authorised server-side rather than by the UI.
    """

    kind: Literal["propose_plan"] = "propose_plan"
    title: str = Field(min_length=1, max_length=140)
    summary: str = Field(min_length=1, max_length=800)
    stages: list[PlanStage] = Field(min_length=1, max_length=6)


class WriteArtifactProposal(BaseModel):
    """Propose that Node persist what a task produced.

    Separate from `post_message` because an artifact is the evidence a task is
    judged on, not a thing said in a room. Node writes the row, runs the checker
    over it, and moves the task; this service only drafts.

    `citations` are source LABELS rather than indices, unlike `PlanStep`. The
    checker's job is to catch a source the maker was never given, and it can only
    do that against something nameable: an index is checkable for range and not
    for provenance.
    """

    kind: Literal["write_artifact"] = "write_artifact"
    title: str = Field(min_length=1, max_length=140)
    body: str = Field(min_length=1, max_length=8000)
    citations: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------ replan ----
#
# Reconciling a running plan with what has actually happened, as a DIFF rather
# than a regenerated plan. `ai-orchestrator.md` has specified "replan by diff, not
# regeneration: preserving completed work and audit history" since Phase 0, and
# the reason is in the name. Regenerating discards the record of what was already
# approved, delivered and paid for, and the audit trail is the thing this system
# sells.
#
# Three operations, and the set is deliberately small. Everything an owner wants
# from a replan is expressible as work added, work called off, or work whose
# description was wrong, and each of those is separately reviewable on a card.


class AddStepOp(BaseModel):
    """Add one step to a running project.

    Carries everything `PlanStep` carries, plus the stage it belongs to, because
    a diff has no stage structure to sit inside. `depends_on` may name another
    step added by the same diff, by its `id`, or an existing task, by its UUID:
    both are references to a task that will exist when the diff is applied, and
    which kind a given string is can be decided by looking at it.
    """

    op: Literal["add_step"] = "add_step"
    stage: StageKey
    id: str = Field(
        pattern=STEP_ID_PATTERN,
        description="Names this step within this diff, so another added step can depend on it.",
    )
    title: str = Field(min_length=1, max_length=120)
    detail: str = Field(min_length=1, max_length=600)
    owner: Literal["AI", "HUMAN", "YOU"]
    citations: list[int] = Field(default_factory=list)
    risk_tier: RiskTier = "reversible"
    acceptance_criteria: list[str] = Field(default_factory=list, max_length=3)
    depends_on: list[str] = Field(default_factory=list, max_length=8)


class CancelTaskOp(BaseModel):
    """Call off a step that has not been done yet.

    `reason` is required and is not decoration: a cancelled step is the one kind
    of change that destroys planned work, so the audit trail has to say on whose
    account and why. It is written into the `task.replan_cancelled` event.

    **A cancelled step does not release what depends on it.** `task_deps_satisfied`
    counts a dependency satisfied at `approved` or later, and `cancelled` is
    neither, so a dependent stays blocked. That is correct rather than an
    oversight: work planned to consume an output that will now never exist should
    not quietly proceed as though it had one. A diff that cancels a step usually
    has to say what happens to its dependents too.
    """

    op: Literal["cancel_task"] = "cancel_task"
    task_id: str
    reason: str = Field(min_length=1, max_length=400)


class ModifyTaskOp(BaseModel):
    """Correct the description of a step that is still going to happen.

    **Only three fields, and the exclusions are the safety property.** State,
    owner and risk tier are absent on purpose. Changing who runs a step, or what
    it is permitted to touch, is not an edit to that step: it is a different piece
    of work, and it goes through `cancel_task` plus `add_step` so a person sees
    both halves on the card and approves them. Allowing a "modify" to move a step
    from HUMAN to AI, or from `high_risk` to `reversible`, would route an
    authorisation decision through the field that looks least like one, which is
    exactly what rules 7 and 11 forbid.

    `add_depends_on` adds edges and cannot remove them, for the same reason. A
    removable edge is a way to unblock a step whose prerequisite was never done.
    """

    op: Literal["modify_task"] = "modify_task"
    task_id: str
    detail: str | None = Field(default=None, min_length=1, max_length=600)
    acceptance_criteria: list[str] | None = Field(default=None, max_length=3)
    add_depends_on: list[str] = Field(default_factory=list, max_length=8)


ReplanOp = AddStepOp | CancelTaskOp | ModifyTaskOp


class ProposeReplanProposal(BaseModel):
    """Propose that Node render a diff card the owner can approve.

    Approving it is what applies the diff, exactly as approving a plan card is
    what creates the project. The card is the authorisation boundary, so this
    service proposes a change to a running project and never makes one.
    """

    kind: Literal["propose_replan"] = "propose_replan"
    project_id: str
    summary: str = Field(
        min_length=1,
        max_length=800,
        description="What this diff changes and why, in the owner's terms. Rendered on the card.",
    )
    ops: list[ReplanOp] = Field(
        min_length=1,
        max_length=10,
        description=(
            "Capped at ten because a card a person will not read is not an "
            "authorisation. A change larger than this is a new plan, not a diff."
        ),
    )


Proposal = (
    PostMessageProposal | ProposePlanProposal | WriteArtifactProposal | ProposeReplanProposal
)


# ------------------------------------------------------------------ intake ----
#
# The slots `full-funnel-creator.md` step 1 already names: "Turn the one-liner
# into ICP, offer, target metric, budget band, timeline." Kept in that document's
# vocabulary rather than invented here, so the playbook stays the specification
# and this stays its implementation.
INTAKE_SLOTS = (
    "icp",
    "offer",
    "target_metric",
    "budget_band",
    "timeline",
)

IntakeSlotKey = Literal["icp", "offer", "target_metric", "budget_band", "timeline"]


class IntakeSlot(BaseModel):
    """One thing we now know about what the person wants.

    `source` separates what they actually said from what the model concluded, and
    that distinction is load-bearing rather than informational. An inferred slot is
    a guess about someone's business that will end up shaping a plan they act on,
    so the card that confirms the intake has to be able to show it as a guess. It
    also means a wrong inference is traceable to the model rather than blamed on
    the person for "saying" something they never said.
    """

    key: IntakeSlotKey
    value: str = Field(min_length=1, max_length=400)
    source: Literal["stated", "inferred"]


class IntakeQuestion(BaseModel):
    """One question to put to the person, tied to the slot it fills.

    Carrying the slot rather than only the text is what lets the next round match
    an answer to what it answered without asking the model to remember.
    """

    slot: IntakeSlotKey
    question: str = Field(min_length=1, max_length=240)


class IntakeRequest(BaseModel):
    """Advance the intake by one round.

    Stateless on this side: Node holds the conversation and passes back what it
    has. `services/ai` owns no table and no session (ADR-0006), so making intake
    multi-turn must not be the thing that gives it one.
    """

    room_id: str
    goal: str = Field(min_length=1, max_length=4000, description="The original one-liner.")
    answers: list[str] = Field(
        default_factory=list,
        max_length=20,
        description="What the person has said since the goal, newest last. Untrusted data.",
    )
    slots: list[IntakeSlot] = Field(
        default_factory=list, description="What previous rounds established. Node carries this."
    )
    round: int = Field(default=0, ge=0, le=10, description="Rounds already completed.")
    trace: TraceContext


class IntakeResponse(BaseModel):
    """What we now know, how sure we are it is enough, and what to ask next.

    Deliberately NOT a `PlanResponse`. Intake produces no proposals because it
    performs nothing: Node decides whether to ask the questions, and the plan run
    is a separate call. Returning proposals here would also mean adding a kind to
    the discriminated union, which Node would fail to parse until it learned it.
    """

    slots: list[IntakeSlot]
    focus_stages: list[str] = Field(
        default_factory=list,
        description=(
            "Funnel stages the stated intent touches, whether or not the corpus covers them."
        ),
    )

    completeness: float = Field(
        ge=0.0,
        le=1.0,
        description=(
            "Share of the REQUIRED slots that are filled. Counted in code from a "
            "required set that depends on how broad the intent is, never scored by "
            "the model: a model asked to rate its own certainty is answering a "
            "different question from the one that matters."
        ),
    )
    proximity: float = Field(
        ge=0.0,
        le=1.0,
        description=(
            "Share of the touched stages the corpus actually covers. 0 means the "
            "request sits outside what this system can ground, and no number of "
            "further questions changes that."
        ),
    )

    ready: bool = Field(description="True when the caller should stop asking and run the plan.")

    outcome: Literal["ready", "needs_detail", "not_a_request", "out_of_domain"] = Field(
        description=(
            "What this turn established, and what the caller should do next.\n\n"
            "`not_a_request` and `out_of_domain` are separate on purpose, because "
            "they were one thing once and it produced a bad answer: a greeting and "
            "a request from another industry both scored zero coverage and both got "
            "told they sat outside digital marketing. A greeting is not a request "
            "that is out of scope, it is not a request, and the reply it deserves is "
            "a question rather than a refusal.\n\n"
            "`out_of_domain` still cannot be planned, but it is worth one redirect "
            "rather than a dead end: someone opening a cafe cannot be helped to open "
            "it and may well want customers through its door, which is work this "
            "system does. The redirect names what is not on offer before asking, so "
            "it is an honest question rather than a way of keeping someone talking."
        )
    )

    questions: list[IntakeQuestion] = Field(
        default_factory=list,
        max_length=4,
        description="Ask these together, as one batch, or not at all.",
    )
    refined_goal: str = Field(
        description=(
            "The goal restated from the filled slots, for retrieval to use instead "
            "of the original one-liner. Equal to the original when nothing was learned."
        )
    )

    reasoning_summary: str
    core: str


class ReplanTask(BaseModel):
    """One task of the running project, as the reasoning core sees it.

    Sent by Node rather than read from the database, because this service reaches
    Postgres for retrieval only and the DAG is Node's to own (ADR-0006). `state`
    travels because it decides what may be proposed: a step already approved is
    history, and proposing to cancel it is proposing to rewrite the record.
    """

    task_id: str
    title: str
    detail: str = ""
    stage: str | None = None
    state: str
    owner: Literal["AI", "HUMAN", "YOU"]
    depends_on: list[str] = Field(
        default_factory=list,
        description=(
            "Task UUIDs this one already waits on. Sent so the core can tell "
            "whether an edge it is about to propose closes a cycle, rather than "
            "leaving the acyclicity trigger to discover it under the owner's "
            "approval click."
        ),
    )


class ReplanRequest(BaseModel):
    """Reconcile a running project with what the owner now knows.

    Owner-initiated. Nothing in this system replans on its own, and that is a
    scope decision rather than a missing feature: automatic replanning would
    change a running project with no card and no approval, which is the one
    property the plan card exists to provide.
    """

    project_id: str
    goal: str = Field(min_length=1, max_length=4000)
    reason: str = Field(
        min_length=1,
        max_length=1000,
        description="Why the owner wants the plan changed, in their own words.",
    )
    tasks: list[ReplanTask] = Field(min_length=1, max_length=200)
    context: list[IntakeSlot] = Field(default_factory=list)
    trace: TraceContext


class ExecuteRequest(BaseModel):
    """Execute one AI-owned task from an approved plan.

    Carries the task rather than the goal: by this point the plan is agreed and
    what matters is the single step. The service re-retrieves for that step rather
    than reusing the plan's sources, because a step is far narrower than the goal
    that produced it and deserves its own retrieval.
    """

    task_id: str
    title: str = Field(min_length=1, max_length=200)
    detail: str = Field(default="", max_length=2000)
    stage: str | None = None

    context: list[IntakeSlot] = Field(
        default_factory=list,
        description=(
            "What intake established about this person: audience, offer, budget, "
            "timeline. Same block the planner receives, and governed by the same "
            "two rules: it may make the deliverable CONCRETE, and it may never be "
            "cited. "
            "It reaches the executor because it previously did not, and the cost "
            "was measured. On a run where the person gave their audience, 4 of 15 "
            "plan steps mentioned it and 1 of 8 artifacts did, that one only "
            "because the planner had written the word into a step title. So the "
            "plan knew who it was for and the work did not: ad copy came back "
            "aimed at a marketer rather than at the customer. "
            "It is deliberately NOT added to the retrieval query. That is the "
            "defect this project already measured twice, where a niche audience "
            "word dominates a short query at a cross-encoder and retrieves "
            "nothing at all."
        ),
    )
    trace: TraceContext


class PlanRequest(BaseModel):
    room_id: str
    goal: str = Field(min_length=1, max_length=4000)

    context: list[IntakeSlot] = Field(
        default_factory=list,
        description=(
            "What intake established about this person: audience, offer, budget, "
            "timeline. Handed to the PLANNER and deliberately kept out of the "
            "retrieval query and out of the groundedness gate.\n\n"
            "That separation is measured rather than stylistic. Folding these into "
            "the goal was tried and it broke retrieval: 'Get signups for travelers.' "
            "returned nothing at all, because a niche audience word dominates a short "
            "query at a cross-encoder and appears nowhere in a corpus of marketing "
            "principles. The same word survived a longer phrasing and was then refused "
            "by the gate, which read the person's own particulars as a topic the "
            "sources were obliged to cover. Neither failure is the gate being wrong; "
            "both are the query having been polluted before it got there."
        ),
    )

    trace: TraceContext


class PlanResponse(BaseModel):
    proposals: list[Proposal]

    grounded: bool = Field(
        description=(
            "True only when every claim is backed by retrieved, in-date sources. "
            "False means the output must not gate a regulated or irreversible action "
            "(AGENTS.md rule 10)."
        )
    )
    citations: list[Citation] = Field(default_factory=list)

    reasoning_summary: str = Field(
        description="Short, human-readable account of what the core did. Goes to traces, not chat."
    )

    core: str = Field(
        description=(
            "Which reasoning core produced this, e.g. 'deterministic-v0'. Recorded so a "
            "regression can be tied to a core or prompt version."
        )
    )


class SourceRequest(BaseModel):
    """Ingest one document the user supplied about their own business.

    **What this exists to fix, measured rather than assumed.** Every artifact the
    executor produced ended with a variant of "product-specific claims could not
    be included", because the corpus is marketing principles and knows nothing
    about the user's product. The ad copy came back written about advertising.

    Scoped to a ROOM, not a project. A project does not exist until a plan is
    approved, business knowledge arrives before that, and one room now carries
    many projects over its life. What someone tells us about their company
    belongs to the workspace rather than to one plan inside it.

    SECURITY: `text` is what a person typed or what a page said. It is DATA, not
    instructions (rule 8). It reaches a prompt only inside the same delimited
    SOURCES block the corpus travels in, and it is scoped to its own room, so
    anything hostile inside it can only affect that room's own output.
    """

    room_id: str
    title: str = Field(min_length=1, max_length=140)
    text: str = Field(min_length=1, max_length=120_000)
    source_url: str | None = Field(
        default=None,
        description=(
            "Where the text came from, when it was fetched from a page. Stored on the "
            "document and returned with every citation drawn from it, so a reader can "
            "open the thing being cited. It was accepted and discarded until "
            "20260827101000 gave documents a URL of their own."
        ),
    )
    trace: TraceContext


class SourceResponse(BaseModel):
    document_id: str
    chunks_written: int
    skipped_unchanged: bool = Field(
        description=(
            "True when the content hash matched what is already stored, so nothing "
            "was re-embedded. Re-submitting the same text is cheap and safe."
        )
    )
    superseded: bool = Field(
        description=(
            "True when this replaced an earlier version of the same titled document. "
            "The old version is closed rather than deleted, so retrieval stops seeing "
            "it while the audit trail keeps it."
        )
    )


class IngestRequest(BaseModel):
    """Ingest one crawled document into the SHARED reference corpus.

    The caller is the crawl sweep in `apps/api`, which owns outbound HTTP because
    this service talks to Postgres and to model providers and to nothing else
    (architecture.md). Node fetches, guards the URL, and decides the page changed;
    this endpoint does the part that needs the embedder.

    **Deliberately not `/sources`.** That one is room-scoped and hardcodes its
    label, authority and doc type, because everything arriving there is a person
    describing their own business. A crawled regulator page is a different trust
    claim with different metadata, and overloading one endpoint would mean a
    request body whose meaning depends on which fields happen to be set.

    SECURITY: `text` is whatever a page said. It is DATA, not instructions
    (rule 8), and it reaches a prompt only inside the delimited SOURCES block the
    rest of the corpus travels in. Unlike a room source it is *shared*, so there
    is no per-room blast radius here: the registry in `crawl-registry.ts` is the
    control, and it is a checked-in allow-list rather than anything a user names.
    """

    title: str = Field(
        min_length=1,
        max_length=200,
        description=(
            "Stable across re-crawls. Document identity is (source_id, title), so a "
            "title that drifts orphans the previous version as still-in-force instead "
            "of superseding it. It is also the key the eval golden set matches on."
        ),
    )
    text: str = Field(min_length=1, max_length=200_000)
    source_label: str = Field(min_length=1, max_length=200)
    source_url: str = Field(
        min_length=1,
        max_length=2_000,
        description=(
            "Required here, unlike on a room source. A crawled document exists "
            "because a page does, and a citation nobody can open is the thing this "
            "whole path was built to stop."
        ),
    )
    authority: Literal["official", "vendor", "research", "internal"] = Field(
        description=(
            "Mirrors public.source_authority. Stated by the registry rather than "
            "inferred from the URL: whether a page is authoritative is an editorial "
            "judgement, and guessing it from a hostname is how a vendor blog becomes "
            "a regulator."
        )
    )
    market: str | None = Field(
        default=None,
        description="Unambiguous key, e.g. 'US', 'UK', 'EU'. Never generalised across borders.",
    )
    business_type: str | None = None
    doc_type: str | None = None
    effective_date: str | None = Field(
        default=None,
        description=(
            "ISO date. The day this version was read from the page, which is the "
            "honest claim: we know when we saw it, not when its publisher wrote it."
        ),
    )
    lang: str = "english"
    trace: TraceContext
