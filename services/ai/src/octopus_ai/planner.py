"""The reasoning core.

Currently `deterministic-v0`: it does not call a model. That is deliberate rather
than a placeholder waiting to be filled with something impressive. A growth plan
that is not grounded in retrieval cannot be cited, and AGENTS.md rule 10 says
uncited output is flagged and cannot gate action. So the honest behaviour, until
RAG exists, is to acknowledge the goal and say plainly what it cannot do yet.

Brand voice (docs/20-design/brand.md): calm, precise, honest about limits. The
copy below is user-facing, so no em dashes (AGENTS.md rule 22).

SECURITY: `goal` is user-supplied and is DATA, never instructions (rule 8). It is
echoed back as text and nothing more. When a model is wired in here, the goal must
stay in the data channel and out of the system prompt.
"""

from .schemas import PlanRequest, PlanResponse, PostMessageProposal

CORE_NAME = "deterministic-v0"

_GOAL_ECHO_LIMIT = 300


def _echo(goal: str) -> str:
    """Quote the goal back, bounded, on one line."""
    flat = " ".join(goal.split())
    if len(flat) <= _GOAL_ECHO_LIMIT:
        return flat
    return flat[:_GOAL_ECHO_LIMIT].rstrip() + "..."


def plan(request: PlanRequest) -> PlanResponse:
    """Produce proposals for a stated goal.

    Returns proposals only. Acting on them is Node's decision and Node's job.
    """
    body = (
        f'Recorded your goal: "{_echo(request.goal)}"\n\n'
        "I am not going to draft a plan yet. Real planning needs the knowledge base and "
        "retrieval behind it, which are not connected in this build, and a growth plan I "
        "cannot cite is not worth acting on. Once retrieval is live I will come back with a "
        "full-funnel plan where every step shows the sources it rests on and when they were "
        "last verified.\n\n"
        "Nothing has been spent, published, or connected to your accounts."
    )

    return PlanResponse(
        proposals=[PostMessageProposal(body=body)],
        grounded=False,
        citations=[],
        reasoning_summary=(
            "deterministic-v0: acknowledged the goal and declined to plan ungrounded. "
            "No retrieval, no model call."
        ),
        core=CORE_NAME,
    )
