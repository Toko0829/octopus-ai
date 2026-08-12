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


Proposal = PostMessageProposal | ProposePlanProposal


class PlanRequest(BaseModel):
    room_id: str
    goal: str = Field(min_length=1, max_length=4000)
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
