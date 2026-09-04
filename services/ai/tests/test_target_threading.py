"""Which calls take the workspace's target, and which must never take one.

The split is a safety property rather than a routing detail (ADR-0032 decision
5). Query decomposition, the groundedness gate and intake are pinned at
temperature 0 and their thresholds were MEASURED on the house model; the gate in
particular is scored two-sided by `--gate` on it. Routing those to whatever a
workspace happened to connect would move a safety threshold by configuration and
invalidate the only measurement standing behind it.

Nothing about that shows up in a passing response, which is why it is asserted
here rather than left to the reviewer of a future call site.
"""

import json

from octopus_ai.campaign import draft_campaign
from octopus_ai.config import Settings
from octopus_ai.decompose import decompose
from octopus_ai.executor import execute_task
from octopus_ai.groundedness import assess
from octopus_ai.planner import plan_grounded
from octopus_ai.replan import replan
from octopus_ai.retrieval import RetrievalResult
from octopus_ai.schemas import (
    ExecuteRequest,
    GenerationTarget,
    PlanRequest,
    ReplanRequest,
    ReplanTask,
    TraceContext,
)
from octopus_ai.ungrounded import answer_ungrounded

TARGET = GenerationTarget(
    vendor="anthropic", provider="anthropic", model="claude-sonnet-5", api_key="sk-customer"
)

_PLAN = {
    "title": "A plan",
    "summary": "A summary.",
    "stages": [
        {
            "stage": "strategy",
            "steps": [
                {
                    "id": "one",
                    "title": "Do the thing",
                    "detail": "The detail of the thing.",
                    "owner": "YOU",
                    "citations": [1],
                }
            ],
        }
    ],
}

_ARTIFACT = {"title": "A draft", "body": "The draft body.", "citations": ["A source"]}
_DIFF = {
    "summary": "What changes.",
    "ops": [
        {
            "op": "add_step",
            "stage": "strategy",
            "id": "added",
            "title": "An added step",
            "detail": "Why it is needed.",
            "owner": "YOU",
            "citations": [1],
        }
    ],
}


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": "sk-house",
        "cohere_api_key": "co-test",
        # Off, so the gate's own target rule is asserted directly below rather
        # than through five endpoint tests that would each need a verdict.
        "groundedness_check": False,
    }
    base.update(overrides)
    return Settings(**base)


class RecordingProviders:
    """Records the `target` of every generation call, and answers plausibly."""

    house_model = "gpt-5.4"

    def __init__(self, json_answer: dict | str = _PLAN, prose: str = "A paragraph."):
        self._json = json_answer if isinstance(json_answer, str) else json.dumps(json_answer)
        self._prose = prose
        self.targets: list[GenerationTarget | None] = []

    async def complete_json(self, *, system, user, model=None, max_tokens=None, target=None):
        self.targets.append(target)
        return self._json

    async def complete(self, *, system, user, max_tokens=None, target=None):
        self.targets.append(target)
        return self._prose


class Chunk:
    """The attributes a retrieved chunk is read for, and nothing else.

    Duck-typed like every other stub here: what is being asserted is routing, and
    building a real `RetrievedChunk` would tie these tests to the retrieval
    schema they are deliberately not about.
    """

    chunk_id = "chunk-1"
    citation_label = "A source"
    source_url = None
    effective_date = "2026-01-01"
    text = "Reference material for the goal."


def _retrieval() -> RetrievalResult:
    return RetrievalResult(
        chunks=[Chunk()], candidates_considered=10, dropped_below_threshold=0
    )


class StubRetriever:
    def __init__(self, retrieval: RetrievalResult):
        self._retrieval = retrieval

    async def retrieve(self, *_a, **_k):
        return self._retrieval


def _plan_request(**overrides) -> PlanRequest:
    base = {"room_id": "room-1", "goal": "a goal", "trace": TraceContext(agent_run_id="run-1")}
    base.update(overrides)
    return PlanRequest(**base)


def _execute_request(**overrides) -> ExecuteRequest:
    base = {
        "task_id": "task-1",
        "title": "Draft the ad copy",
        "detail": "For cold traffic.",
        "trace": TraceContext(agent_run_id="run-1"),
    }
    base.update(overrides)
    return ExecuteRequest(**base)


# ------------------------------------------- the calls that take a target ----


async def test_the_planner_plans_on_the_target():
    providers = RecordingProviders()
    await plan_grounded(_plan_request(), _retrieval(), providers, _settings(), TARGET)

    assert providers.targets == [TARGET]


async def test_the_prose_fallback_stays_on_the_same_target():
    """A card that degrades to a paragraph must not also change model."""
    providers = RecordingProviders(json_answer="not json at all")
    await plan_grounded(_plan_request(), _retrieval(), providers, _settings(), TARGET)

    # One structured attempt, one corrective retry, then prose. All three on the
    # workspace's model: a corrective retry is the same model shown its own
    # error, not a second opinion.
    assert providers.targets == [TARGET, TARGET, TARGET]


async def test_the_executor_drafts_on_the_request_target():
    providers = RecordingProviders(json_answer=_ARTIFACT)
    await execute_task(
        _execute_request(generation=TARGET),
        StubRetriever(_retrieval()),
        providers,
        _settings(),
    )

    assert providers.targets == [TARGET]


async def test_the_campaign_drafter_uses_the_request_target():
    providers = RecordingProviders(json_answer={"decline": True, "why": "not a campaign"})
    await draft_campaign(
        _execute_request(generation=TARGET),
        StubRetriever(_retrieval()),
        providers,
        _settings(),
    )

    assert providers.targets == [TARGET]


async def test_replan_uses_the_request_target():
    providers = RecordingProviders(json_answer=_DIFF)
    request = ReplanRequest(
        project_id="project-1",
        goal="a goal",
        reason="the market moved",
        tasks=[
            ReplanTask(
                task_id="11111111-1111-4111-8111-111111111111",
                title="An existing step",
                stage="strategy",
                state="approved",
                owner="YOU",
            )
        ],
        trace=TraceContext(agent_run_id="run-1"),
        generation=TARGET,
    )
    await replan(request, StubRetriever(_retrieval()), providers, _settings())

    assert providers.targets == [TARGET]


async def test_the_ungrounded_tier_answers_on_the_target():
    providers = RecordingProviders()
    await answer_ungrounded("how do I build a webinar funnel", providers, TARGET)

    assert providers.targets == [TARGET]


# -------------------------------------- the calls that must not take one ----


async def test_decomposition_never_takes_a_target():
    """Its temperature-0 pin and its measured behaviour belong to the house model."""
    providers = RecordingProviders(json_answer={"queries": ["how do I price my offer"]})
    await decompose("a goal", providers)

    assert providers.targets == [None]


async def test_the_groundedness_gate_never_takes_a_target():
    """`--gate` scores this two-sided on the house model. Nothing else may run it."""
    providers = RecordingProviders(json_answer={"supported": True, "reason": "covered"})
    await assess("a goal", "SOURCES", providers)

    assert providers.targets == [None]


# ------------------------------------------------------- who answered ----


async def test_the_plan_reports_the_target_that_answered():
    providers = RecordingProviders()
    response = await plan_grounded(
        _plan_request(), _retrieval(), providers, _settings(), TARGET
    )

    assert (response.provider, response.model) == ("anthropic", "claude-sonnet-5")


async def test_the_plan_reports_the_house_model_when_there_is_no_target():
    """"Auto" is a real answer to "which model wrote this", not an absence."""
    providers = RecordingProviders()
    response = await plan_grounded(_plan_request(), _retrieval(), providers, _settings())

    assert (response.provider, response.model) == ("openai", "gpt-5.4")


async def test_the_ungrounded_answer_reports_who_gave_it():
    """Slice 4 writes this pair into the gap ledger, per provider."""
    providers = RecordingProviders()
    with_target = await answer_ungrounded("how do I build a webinar funnel", providers, TARGET)
    house = await answer_ungrounded("how do I build a webinar funnel", providers)

    assert (with_target.provider, with_target.model) == ("anthropic", "claude-sonnet-5")
    assert (house.provider, house.model) == ("openai", "gpt-5.4")


async def test_the_executor_reports_the_model_that_drafted():
    """Found by driving the stack, not by any test here.

    `messages.model` and `task_runs.model` on the executor arm are both stamped
    from this pair. Slice 1 set it only in the planner, so a routed `/execute`
    came back grounded and unattributed, and Node correctly refused it as a
    contract break: the step retried, failed the same way, and escalated.
    """
    providers = RecordingProviders(json_answer=_ARTIFACT)
    response = await execute_task(
        _execute_request(generation=TARGET),
        StubRetriever(_retrieval()),
        providers,
        _settings(),
    )

    assert (response.provider, response.model) == ("anthropic", "claude-sonnet-5")


async def test_the_executor_reports_the_house_model_with_no_target():
    providers = RecordingProviders(json_answer=_ARTIFACT)
    response = await execute_task(
        _execute_request(), StubRetriever(_retrieval()), providers, _settings()
    )

    assert (response.provider, response.model) == ("openai", "gpt-5.4")


async def test_a_refusal_names_no_model_even_on_a_target():
    """Because none ran.

    The pair says WHAT ANSWERED, so a refusal that called no provider must report
    nothing rather than the model it would have used. Node reads it the same way:
    it demands attribution of a grounded answer only, so this null is accepted and
    a correct refusal is not turned into a failed run.
    """
    providers = RecordingProviders(json_answer=_ARTIFACT)
    response = await execute_task(
        _execute_request(generation=TARGET),
        StubRetriever(
            RetrievalResult(chunks=[], candidates_considered=9, dropped_below_threshold=9)
        ),
        providers,
        _settings(),
    )

    assert response.grounded is False
    assert (response.provider, response.model) == (None, None)


async def test_the_campaign_drafter_reports_the_model_that_drafted():
    providers = RecordingProviders(
        json_answer={
            "name": "Meta prospecting",
            "channel": "meta",
            "summary": "Cold audiences, creator angle.",
            "citations": [1],
        }
    )
    response = await draft_campaign(
        _execute_request(generation=TARGET),
        StubRetriever(_retrieval()),
        providers,
        _settings(),
    )

    assert response.grounded is True
    assert (response.provider, response.model) == ("anthropic", "claude-sonnet-5")


async def test_replan_reports_the_model_that_answered():
    providers = RecordingProviders(json_answer=_DIFF)
    request = ReplanRequest(
        project_id="project-1",
        goal="a goal",
        reason="the market moved",
        tasks=[
            ReplanTask(
                task_id="11111111-1111-4111-8111-111111111111",
                title="An existing step",
                stage="strategy",
                state="approved",
                owner="YOU",
            )
        ],
        trace=TraceContext(agent_run_id="run-1"),
        generation=TARGET,
    )
    response = await replan(request, StubRetriever(_retrieval()), providers, _settings())

    assert response.grounded is True
    assert (response.provider, response.model) == ("anthropic", "claude-sonnet-5")


async def test_intake_never_takes_a_target():
    """It runs on the cheap house tier, and `IntakeRequest` carries no target.

    Deliberate rather than an omission: intake is classification, it decides what
    to ask before anything has been retrieved, and its completeness threshold was
    measured on the house model like the other two.
    """
    from octopus_ai.intake import run_intake
    from octopus_ai.schemas import IntakeRequest

    providers = RecordingProviders(json_answer={"slots": [], "stages": []})
    await run_intake(
        IntakeRequest(room_id="room-1", goal="a goal", trace=TraceContext(agent_run_id="run-1")),
        providers,
        model="gpt-5.4-nano",
    )

    assert providers.targets == [None]
    assert "generation" not in IntakeRequest.model_fields
