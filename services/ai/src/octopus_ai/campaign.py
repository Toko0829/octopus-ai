"""Draft a campaign for one step that is waiting on the owner's authorisation.

**Why this is not `/execute`.** Both take a single task and both retrieve for it,
but they answer different questions. `/execute` produces a deliverable a critic
reviews and a task carries; this produces a proposal only a person can accept.
`create_campaign` is `high_risk`, so `routeTask` parks the step at `needs_user`
and it never reaches `/execute` at all. Without this endpoint such a step is a
dead end: the owner is told it needs them and given nothing to say yes to.

**Declining is a first-class answer here, more than anywhere else in the
service.** A `needs_user` step under `high_risk_needs_authorisation` might be an
account connection, a publish, or a budget change rather than a campaign, and
Node cannot tell which without reading the step's words. It asks about all of
them and this module says no to most. A refusal costs the owner nothing, since
the step is already announced as needing them; a wrong campaign card asks
somebody to authorise spend on a channel nobody chose.

**And there is no budget anywhere in this file.** See `ProposeCampaignProposal`:
the owner types the number on the card. Nothing here should ever compute, infer
or default one, including from the `budget_band` intake slot, which is free text
a person wrote and not an authorisation.
"""

from __future__ import annotations

import json
import logging

from .config import Settings
from .groundedness import assess
from .planner import build_context_block, build_sources_block
from .providers import Providers
from .retrieval import RetrievalResult, Retriever
from .schemas import (
    Citation,
    ExecuteRequest,
    PlanResponse,
    PostMessageProposal,
    ProposeCampaignProposal,
)

logger = logging.getLogger(__name__)

CAMPAIGN_CORE = "campaign-v1"
DECLINING_CORE = "declining-campaign-v1"

_CAMPAIGN_RULES = """You are Octopus, proposing ONE advertising or outreach \
campaign for a single step of a marketing plan that a person has already approved.

The step is waiting for its owner to authorise it. Your proposal becomes a card \
they approve or reject. You are not starting anything.

Ground every claim in the SOURCES block. Cite by the 1-based number of the source \
you used. If the sources do not support a choice of channel for this step, decline.

DECLINE by returning {"decline": true, "why": "<one sentence>"} when any of these \
is true:
- The step is not about running a campaign (connecting an ad account, publishing \
one piece of content, changing a budget, or research are all NOT campaigns).
- The sources do not say which channel suits this step.
- The step is too vague to name a campaign.

Otherwise return JSON with exactly these fields:
  name: a short specific name for the campaign, at most 200 characters
  objective: what it is for, at most 500 characters, or null
  channel: one of "meta", "google", "email", "organic_social"
  summary: 2 to 4 sentences on why this channel for this step, in the owner's terms
  citations: array of 1-based source numbers supporting the channel choice

NEVER include a budget, a spend figure, a bid, a daily amount or a cost estimate \
in any field. The owner sets the budget themselves. A number you invent would be \
indistinguishable from one they authorised.

Write plainly. No em dashes. No hype. Do not promise results."""


def _decline(request: ExecuteRequest, why: str, retrieval: RetrievalResult | None) -> PlanResponse:
    """Say no, and say what would change the answer.

    A `post_message` rather than an empty proposal, matching `_refuse` in the
    executor: there is genuinely nothing to authorise, and a card with no channel
    would be caught by a Zod parse one layer later having already told the owner a
    campaign was ready.

    The copy deliberately does not apologise or imply the step is stuck. It is not:
    `notifyWaiting` has already said this step needs them, and that remains true
    and actionable.
    """
    considered = retrieval.candidates_considered if retrieval else 0
    return PlanResponse(
        proposals=[
            PostMessageProposal(
                body=(
                    f'I did not propose a campaign for "{request.title}". {why}\n\n'
                    "This step still needs you, and nothing has been spent or published."
                )
            )
        ],
        grounded=False,
        citations=[],
        reasoning_summary=f"{DECLINING_CORE}: {why} ({considered} candidates).",
        core=DECLINING_CORE,
    )


async def draft_campaign(
    request: ExecuteRequest,
    retriever: Retriever,
    providers: Providers,
    settings: Settings,
) -> PlanResponse:
    """Propose a campaign for one authorisation-blocked step, or decline."""
    # The step's own words, exactly as the executor builds its query. The intake
    # context is deliberately absent: putting the audience into a retrieval query
    # is the defect this project has measured twice.
    query = " ".join(f"{request.title}. {request.detail}".split())

    try:
        retrieval = await retriever.retrieve(
            query,
            room_id=request.trace.room_id,
            project_id=request.trace.project_id,
            agent_run_id=request.trace.agent_run_id,
        )
    except Exception:
        logger.exception(
            "retrieval failed while drafting a campaign",
            extra={"task_id": request.task_id},
        )
        return _decline(request, "Retrieval failed.", None)

    if not retrieval.grounded:
        return _decline(
            request,
            "Nothing in my sources covers which channel this step needs.",
            retrieval,
        )

    sources = build_sources_block(retrieval)

    if settings.groundedness_check:
        # The gate matters more here than when planning. A plan that cites
        # loosely-related sources is a weak suggestion; a campaign card that does
        # is an invitation to authorise spend on a channel nothing recommended.
        verdict = await assess(query, sources, providers, settings.active_groundedness_model)
        if not verdict.may_plan:
            return _decline(
                request,
                f"The sources I found do not actually cover it ({verdict.reason}).",
                retrieval,
            )

    citations = [
        Citation(
            source_id=chunk.chunk_id,
            label=chunk.citation_label,
            url=chunk.source_url,
            effective_date=chunk.effective_date,
        )
        for chunk in retrieval.chunks
    ]

    about = build_context_block(request.context)
    blocks = "\n\n".join(b for b in (sources, about) if b)
    user = f"{blocks}\n\nThe step to authorise:\n{request.title}\n{request.detail}".rstrip()

    try:
        raw = await providers.complete_json(
            system=_CAMPAIGN_RULES,
            user=user,
            max_tokens=settings.generation_max_tokens_long,
        )
    except Exception as exc:
        logger.warning(
            "campaign draft unusable",
            extra={"task_id": request.task_id, "reason": str(exc)[:200]},
        )
        return _decline(request, "The draft came back unusable.", retrieval)

    try:
        payload = json.loads(raw)
    except Exception:
        return _decline(request, "The draft came back unusable.", retrieval)

    if not isinstance(payload, dict):
        return _decline(request, "The draft came back unusable.", retrieval)

    # The model's own decline path, honoured rather than second-guessed. Asking it
    # to say no and then overriding that would leave no way for it to say no.
    if payload.get("decline"):
        why = str(payload.get("why") or "This step is not a campaign.")[:200]
        return _decline(request, why, retrieval)

    # Any budget-shaped field is dropped before validation rather than after.
    # `ProposeCampaignProposal` has no such field, so a model that emitted one
    # would fail validation and produce a decline, losing a usable proposal for a
    # field nobody reads. Stripping is the kinder half of the same rule.
    for banned in ("budget", "budget_cap", "budgetCap", "daily_budget", "spend", "bid"):
        payload.pop(banned, None)

    payload["task_id"] = request.task_id
    payload.pop("kind", None)

    try:
        proposal = ProposeCampaignProposal.model_validate(payload)
    except Exception as exc:
        logger.warning(
            "campaign proposal did not validate",
            extra={"task_id": request.task_id, "reason": str(exc)[:200]},
        )
        return _decline(request, "The draft came back unusable.", retrieval)

    # Citation indices are filtered against what was actually supplied, matching
    # the executor: an index past the end of the list renders as grounding that
    # does not exist, which rule 10 treats as worse than no citation at all.
    kept = [i for i in proposal.citations if 1 <= i <= len(citations)]
    dropped = len(proposal.citations) - len(kept)
    if dropped:
        logger.info(
            "dropped campaign citations pointing past the sources",
            extra={"task_id": request.task_id, "dropped": dropped},
        )
    proposal.citations = kept

    return PlanResponse(
        proposals=[proposal],
        grounded=True,
        citations=citations,
        reasoning_summary=(
            f"{CAMPAIGN_CORE}: proposed a {proposal.channel} campaign from "
            f"{len(citations)} sources. The owner sets the budget."
        ),
        core=CAMPAIGN_CORE,
    )
