"""What the campaign endpoint proposes, and the far more common case of it declining.

The property most worth pinning is the absence of a budget. `ProposeCampaignProposal`
has no budget field and `draft_campaign` strips budget-shaped keys before validation,
so a model that starts emitting a spend figure has it dropped rather than rendered on
a card where it would be indistinguishable from a number the owner authorised. That is
asserted here rather than left to the prompt, because a prompt is not an enforcement
mechanism (rule 7).

The second property is that declining is normal. Node asks about every step the router
stopped for an authorisation, and most of those are not campaigns: connecting an ad
account and publishing one post are both `high_risk` and neither is a campaign. A
decline returns a `post_message` saying so, which is the same shape the executor's
refusal uses.
"""

import json

import pytest

from octopus_ai.campaign import CAMPAIGN_CORE, DECLINING_CORE, draft_campaign
from octopus_ai.schemas import ExecuteRequest, ProposeCampaignProposal, TraceContext


def _request(title: str = "Turn the campaign on", detail: str = "Go live.") -> ExecuteRequest:
    return ExecuteRequest(
        task_id="11111111-1111-4111-8111-111111111111",
        title=title,
        detail=detail,
        stage="channels",
        trace=TraceContext(
            agent_run_id="22222222-2222-4222-8222-222222222222",
            project_id="33333333-3333-4333-8333-333333333333",
            room_id="44444444-4444-4444-8444-444444444444",
        ),
    )


class _Chunk:
    def __init__(self, i: int) -> None:
        self.chunk_id = f"c{i}"
        self.citation_label = f"Source {i}"
        self.source_url = None
        self.effective_date = None
        self.text = "Paid social carries cold reach for a creator launch."
        self.title = f"Source {i}"


class _Retrieval:
    def __init__(self, grounded: bool = True, n: int = 2) -> None:
        self.grounded = grounded
        self.chunks = [_Chunk(i) for i in range(1, n + 1)] if grounded else []
        self.candidates_considered = 8


class _Retriever:
    def __init__(self, retrieval: _Retrieval | None = None, boom: bool = False) -> None:
        self._retrieval = retrieval or _Retrieval()
        self._boom = boom

    async def retrieve(self, query, room_id=None, project_id=None, agent_run_id=None):
        if self._boom:
            raise RuntimeError("retrieval is down")
        return self._retrieval


class _Providers:
    """Answers with whatever JSON the test wants the model to have produced."""

    def __init__(self, payload) -> None:
        self._payload = payload
        self.seen_system: str | None = None

    async def complete_json(self, system, user, max_tokens=None):
        self.seen_system = system
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload if isinstance(self._payload, str) else json.dumps(self._payload)


class _Settings:
    groundedness_check = False
    active_groundedness_model = "test"
    generation_max_tokens_long = 2000


GOOD = {
    "name": "Meta prospecting, cold audiences",
    "objective": "First 100 customers",
    "channel": "meta",
    "summary": "Paid social carries cold reach for a creator launch.",
    "citations": [1],
}


# ------------------------------------------------------------------ proposing


@pytest.mark.asyncio
async def test_a_clean_draft_becomes_a_campaign_proposal():
    response = await draft_campaign(_request(), _Retriever(), _Providers(GOOD), _Settings())

    assert response.core == CAMPAIGN_CORE
    assert response.grounded is True
    assert len(response.proposals) == 1
    proposal = response.proposals[0]
    assert isinstance(proposal, ProposeCampaignProposal)
    assert proposal.channel == "meta"
    assert proposal.name == "Meta prospecting, cold audiences"


@pytest.mark.asyncio
async def test_the_task_id_comes_from_the_request_not_the_model():
    # The model is never asked for it and could not be trusted with it: the task
    # this authorises is the one Node asked about, and a model-supplied id would
    # let a draft close a different step.
    payload = dict(GOOD, task_id="99999999-9999-4999-8999-999999999999")
    response = await draft_campaign(_request(), _Retriever(), _Providers(payload), _Settings())

    assert response.proposals[0].task_id == "11111111-1111-4111-8111-111111111111"


@pytest.mark.asyncio
async def test_no_budget_reaches_the_card_however_the_model_phrases_it():
    # The property this whole card exists to protect. Every one of these keys is a
    # spend figure, and none of them has anywhere to go.
    payload = dict(
        GOOD,
        budget=5000,
        budget_cap=5000,
        budgetCap=5000,
        daily_budget=100,
        spend=5000,
        bid=2.5,
    )
    response = await draft_campaign(_request(), _Retriever(), _Providers(payload), _Settings())

    proposal = response.proposals[0]
    assert isinstance(proposal, ProposeCampaignProposal)
    dumped = proposal.model_dump()
    assert not any("budget" in k or k in {"spend", "bid"} for k in dumped)


@pytest.mark.asyncio
async def test_the_prompt_forbids_a_budget_as_well_as_the_schema():
    # Belt and braces on purpose: the schema is the enforcement, the prompt is what
    # stops the model wasting a field. If the instruction is ever dropped the schema
    # still holds, but the drafts get worse silently, so the instruction is pinned.
    providers = _Providers(GOOD)
    await draft_campaign(_request(), _Retriever(), providers, _Settings())

    assert "NEVER include a budget" in (providers.seen_system or "")


@pytest.mark.asyncio
async def test_citations_past_the_end_of_the_sources_are_dropped():
    # Rule 10 is about what a reader can follow. An index with nothing behind it
    # reads as grounding that exists, which is worse than no citation.
    payload = dict(GOOD, citations=[1, 7])
    response = await draft_campaign(
        _request(), _Retriever(_Retrieval(n=2)), _Providers(payload), _Settings()
    )

    assert response.proposals[0].citations == [1]


# ------------------------------------------------------------------ declining


@pytest.mark.asyncio
async def test_the_model_may_decline_and_is_taken_at_its_word():
    payload = {"decline": True, "why": "This step connects an ad account rather than running one."}
    response = await draft_campaign(_request(), _Retriever(), _Providers(payload), _Settings())

    assert response.core == DECLINING_CORE
    assert response.proposals[0].kind == "post_message"
    assert "connects an ad account" in response.proposals[0].body


@pytest.mark.asyncio
async def test_a_decline_says_the_step_still_needs_the_owner():
    # The step is not stuck and the copy must not imply it is: `notifyWaiting` has
    # already told the room it needs them, and that stays true and actionable.
    payload = {"decline": True, "why": "Not a campaign."}
    response = await draft_campaign(_request(), _Retriever(), _Providers(payload), _Settings())

    body = response.proposals[0].body
    assert "still needs you" in body
    assert "nothing has been spent or published" in body.lower()


@pytest.mark.asyncio
async def test_ungrounded_retrieval_declines_rather_than_guessing_a_channel():
    response = await draft_campaign(
        _request(), _Retriever(_Retrieval(grounded=False)), _Providers(GOOD), _Settings()
    )

    assert response.core == DECLINING_CORE
    assert response.grounded is False


@pytest.mark.asyncio
async def test_a_retrieval_failure_declines_and_does_not_raise():
    # Node treats a raise as a service failure and posts a system notice about the
    # reasoning core being unreachable, which is a worse and less true message than
    # this one.
    response = await draft_campaign(
        _request(), _Retriever(boom=True), _Providers(GOOD), _Settings()
    )

    assert response.core == DECLINING_CORE


@pytest.mark.asyncio
async def test_unparseable_json_declines():
    response = await draft_campaign(
        _request(), _Retriever(), _Providers("not json at all"), _Settings()
    )

    assert response.core == DECLINING_CORE


@pytest.mark.asyncio
async def test_an_unknown_channel_declines_rather_than_defaulting_to_one():
    # `tiktok` is not in `public.marketing_channel`. Defaulting to meta here would
    # ask somebody to authorise spend on a channel nothing proposed, and
    # `materialise_campaign` would refuse it anyway with a less useful message.
    payload = dict(GOOD, channel="tiktok")
    response = await draft_campaign(_request(), _Retriever(), _Providers(payload), _Settings())

    assert response.core == DECLINING_CORE


@pytest.mark.asyncio
async def test_a_provider_failure_declines():
    response = await draft_campaign(
        _request(), _Retriever(), _Providers(RuntimeError("provider down")), _Settings()
    )

    assert response.core == DECLINING_CORE
