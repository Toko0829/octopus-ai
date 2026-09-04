"""What happens between a rejected structured plan and the prose fallback.

Measured on a live container: two plans requested, two lost to the same defect,
zero cards shown. The model wrote a readable step id one character past the
pattern's length, Pydantic rejected the id, and `plan_grounded` fell straight to
a paragraph. Two things now sit between a rejected answer and that paragraph:
the id is normalised rather than rejected (`test_plan_parsing`), and a shape the
normaliser cannot fix earns exactly one corrective retry before prose.

These run without a model or a database, on a `Providers` stand-in that returns
scripted answers, so what they pin is the control flow and nothing else.
"""

import json

import pytest

from octopus_ai.config import Settings
from octopus_ai.planner import GROUNDED_CORE, GROUNDED_PLAN_CORE, plan_grounded
from octopus_ai.providers import ProviderError
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk
from octopus_ai.schemas import PlanRequest, TraceContext


def _settings() -> Settings:
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="secret",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
    )


def _retrieval() -> RetrievalResult:
    chunk = RetrievedChunk(
        chunk_id="c1",
        document_id="d1",
        text="Define the signup event before spending.",
        title="Paid ads CPA control",
        market="US",
        doc_type="playbook",
        effective_date=None,
        source_url=None,
        source_label="Octopus",
        authority=None,
        rrf_score=0.5,
        rerank_score=0.9,
    )
    return RetrievalResult(chunks=[chunk], candidates_considered=1, dropped_below_threshold=0)


def _request() -> PlanRequest:
    return PlanRequest(
        room_id="room-1",
        goal="get signups for my site",
        trace=TraceContext(agent_run_id="run-1"),
    )


def _plan_json(owner: str = "AI") -> str:
    return json.dumps(
        {
            "title": "Signups plan",
            "summary": "Track the event, then test one angle.",
            "stages": [
                {
                    "stage": "measurement",
                    "steps": [
                        {
                            "id": "define-signup-event",
                            "title": "Define the signup event",
                            "detail": "One counted event, written down.",
                            "owner": owner,
                            "citations": [1],
                        }
                    ],
                }
            ],
        }
    )


class ScriptedProviders:
    """Returns the scripted JSON answers in order; records every call."""

    # What a call with no target runs on, which is what `attribution` reports.
    house_model = "gpt-5.4"

    def __init__(self, json_answers: list[str | Exception], prose: str = "A cited paragraph."):
        self._json = list(json_answers)
        self._prose = prose
        self.json_calls: list[str] = []
        self.prose_calls = 0

    async def complete_json(self, *, system, user, model=None, max_tokens=None, **_kwargs) -> str:
        self.json_calls.append(user)
        answer = self._json.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    async def complete(self, *, system, user, **_kwargs) -> str:
        self.prose_calls += 1
        return self._prose


async def test_a_rejected_shape_is_retried_once_with_the_error_and_then_carded():
    providers = ScriptedProviders([_plan_json(owner="ROBOT"), _plan_json()])

    response = await plan_grounded(_request(), _retrieval(), providers, _settings())

    assert response.core == GROUNDED_PLAN_CORE
    assert response.proposals[0].kind == "propose_plan"
    assert providers.prose_calls == 0, "a fixable shape must not fall to prose"
    assert len(providers.json_calls) == 2
    second = providers.json_calls[1]
    assert "Your previous answer was rejected" in second
    assert "owner" in second, "the retry must be told which field was wrong"
    assert "(after 1 retry)" in response.reasoning_summary


async def test_two_rejected_shapes_fall_to_marked_prose():
    providers = ScriptedProviders([_plan_json(owner="ROBOT"), _plan_json(owner="ROBOT")])

    response = await plan_grounded(_request(), _retrieval(), providers, _settings())

    assert response.core == GROUNDED_CORE
    assert response.proposals[0].kind == "post_message"
    assert providers.prose_calls == 1
    assert len(providers.json_calls) == 2, "one retry, never more"
    body = response.proposals[0].body
    assert body.startswith("I could not build the plan card for this")
    assert body.endswith("A cited paragraph.")
    assert "—" not in body


async def test_a_provider_error_is_not_retried_here():
    """The provider layer backs off on its own; a second call would double it."""
    providers = ScriptedProviders([ProviderError("upstream 503")])

    response = await plan_grounded(_request(), _retrieval(), providers, _settings())

    assert response.core == GROUNDED_CORE
    assert len(providers.json_calls) == 1
    assert providers.prose_calls == 1


async def test_the_run_that_was_lost_now_produces_a_card_without_a_retry():
    """The live defect: a 35-character id. Normalisation makes the first answer fit."""
    raw = json.loads(_plan_json())
    raw["stages"][0]["steps"][0]["id"] = "define-signup-event-and-cpa-ceiling"
    providers = ScriptedProviders([json.dumps(raw)])

    response = await plan_grounded(_request(), _retrieval(), providers, _settings())

    assert response.core == GROUNDED_PLAN_CORE
    assert len(providers.json_calls) == 1
    assert "retry" not in response.reasoning_summary
    step = next(s for stage in response.proposals[0].stages for s in stage.steps)
    assert step.id == "define-signup-event-and-cpa-ceili"[:32]
    assert len(step.id) <= 32


@pytest.mark.parametrize("bad", ["{not json", "[]"])
async def test_non_object_answers_still_take_the_same_path(bad):
    providers = ScriptedProviders([bad, _plan_json()])
    response = await plan_grounded(_request(), _retrieval(), providers, _settings())
    assert response.core == GROUNDED_PLAN_CORE
