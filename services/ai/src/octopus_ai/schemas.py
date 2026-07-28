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


Proposal = PostMessageProposal


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
