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


class PlanStep(BaseModel):
    """One concrete action inside a funnel stage."""

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


Proposal = PostMessageProposal | ProposePlanProposal | WriteArtifactProposal


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
