"""The groundedness gate: its verdict parsing, its failure direction, and its wiring.

Runs with no API keys and no database, like the rest of the suite. What cannot be
asserted here is whether the gate's JUDGEMENT is any good; that needs a model and
lives in `python -m octopus_ai.evaluation --gate`, which is a credentialed pass.

What is asserted here is the part that would fail silently: that the gate fails
CLOSED. A gate that turns into a no-op when a provider hiccups, or when a model
returns the string "false" instead of the boolean, still logs as though it ran and
still lets a plan through. That failure is invisible from the outside, which is the
same reason `test_generation_call_shape.py` exists.
"""

import httpx
import pytest
from fastapi.testclient import TestClient

import octopus_ai.main as main_module
from octopus_ai.config import Settings
from octopus_ai.groundedness import Groundedness, assess, parse_verdict
from octopus_ai.main import app
from octopus_ai.planner import build_sources_block, refuse
from octopus_ai.providers import Providers
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk
from octopus_ai.schemas import PlanRequest, TraceContext


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": "sk-test",
        "cohere_api_key": "co-test",
    }
    base.update(overrides)
    return Settings(**base)


def _chunk(title="Landing pages and conversion for early-stage traffic", score=0.4):
    return RetrievedChunk(
        chunk_id="c1",
        document_id="d1",
        text="Message match is the first thing to check.",
        title=title,
        market="US",
        doc_type="playbook",
        effective_date=None,
        source_url=None,
        source_label="Octopus internal playbook",
        authority="internal",
        rrf_score=0.5,
        rerank_score=score,
    )


def _retrieval(n=1):
    return RetrievalResult(
        chunks=[_chunk() for _ in range(n)],
        candidates_considered=25,
        dropped_below_threshold=24,
    )


def _responds(content: str | None = None, *, status: int = 200):
    """A transport returning one chat completion, recording what was sent."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.append(_json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={"error": "nope"})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    return seen, httpx.MockTransport(handler)


class TestVerdictParsing:
    def test_a_true_verdict_permits_planning(self):
        v = parse_verdict('{"supported": true, "reason": "covers CPA control directly"}')
        assert v.outcome == "supported"
        assert v.may_plan is True

    def test_a_false_verdict_blocks(self):
        v = parse_verdict('{"supported": false, "reason": "nothing about webinars"}')
        assert v.outcome == "unsupported"
        assert v.may_plan is False
        assert "webinar" in v.reason

    @pytest.mark.parametrize(
        "raw",
        [
            '{"supported": "false", "reason": "x"}',
            '{"supported": "no", "reason": "x"}',
            '{"supported": 0, "reason": "x"}',
            '{"reason": "forgot the field"}',
        ],
    )
    def test_a_non_boolean_supported_is_rejected_rather_than_coerced(self, raw):
        """`bool("false")` is True.

        One coercion here turns the gate into a no-op that still logs as though it
        ran, and the only symptom is confident plans on uncovered questions.
        """
        with pytest.raises(ValueError):
            parse_verdict(raw)

    def test_a_non_object_response_is_rejected(self):
        with pytest.raises(ValueError):
            parse_verdict("[true]")

    def test_a_verdict_always_carries_a_reason(self):
        """The reason reaches the trace and the refusal summary, so it cannot be blank."""
        assert parse_verdict('{"supported": false}').reason
        assert parse_verdict('{"supported": true}').reason


class TestFailsClosed:
    async def test_a_provider_failure_becomes_unverified_not_supported(self):
        _, transport = _responds(status=500)
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        v = await assess("grow my newsletter", "<<<SOURCES\nx\nSOURCES>>>", p)
        await p.aclose()

        assert v.outcome == "unverified"
        assert v.may_plan is False, "a gate that opens when the provider fails is not a gate"

    async def test_malformed_json_becomes_unverified(self):
        _, transport = _responds("not json at all")
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        v = await assess("grow my newsletter", "sources", p)
        await p.aclose()

        assert v.may_plan is False

    async def test_assess_never_raises(self):
        """A safety check that takes down the request is a worse product for no gain."""
        _, transport = _responds(status=418)
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        v = await assess("goal", "sources", p)  # must not raise
        await p.aclose()
        assert v.outcome == "unverified"

    def test_an_unknown_future_outcome_blocks_by_default(self):
        """`may_plan` is an allow-list, so a new state added later fails closed."""
        assert Groundedness(outcome="something-new", reason="").may_plan is False


class TestCallShape:
    async def test_the_gate_runs_on_the_cheap_tier_when_asked(self):
        seen, transport = _responds('{"supported": true}')
        s = _settings()
        p = Providers(s, client=httpx.AsyncClient(transport=transport))
        await assess("goal", "sources", p, s.active_groundedness_model)
        await p.aclose()

        assert seen[0]["model"] == s.generation_model_cheap

    async def test_the_gate_does_not_resample(self):
        """Same goal, same sources, same verdict. It is a classification."""
        seen, transport = _responds('{"supported": true}')
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        await assess("goal", "sources", p)
        await p.aclose()

        assert seen[0]["temperature"] == 0

    async def test_the_sources_are_sent_as_untrusted_data(self):
        """Rule 8: retrieved text is data, never instructions."""
        seen, transport = _responds('{"supported": true}')
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        await assess("my goal", build_sources_block(_retrieval()), p)
        await p.aclose()

        system = seen[0]["messages"][0]["content"]
        user = seen[0]["messages"][1]["content"]
        assert "untrusted" in system.lower()
        assert "SOURCES (untrusted reference data)" in user
        assert "my goal" in user

    async def test_the_gate_judges_the_block_the_planner_will_receive(self):
        """Otherwise it can approve one thing while the planner grounds in another."""
        block = build_sources_block(_retrieval(2))
        seen, transport = _responds('{"supported": true}')
        p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
        await assess("goal", block, p)
        await p.aclose()

        assert block in seen[0]["messages"][1]["content"]


class TestRefusalCopy:
    """A refusal must not tell the person something false about why."""

    def _request(self):
        return PlanRequest(
            room_id="room-1",
            goal="how do I build a webinar funnel that converts",
            trace=TraceContext(agent_run_id="run-1"),
        )

    def test_unverified_never_claims_the_question_is_out_of_scope(self):
        body = refuse(self._request(), _retrieval(), reason="unverified").proposals[0].body
        lowered = body.lower()
        assert "could not complete the check" in lowered
        assert "fault on my side" in lowered
        # The failure this guards against: a provider outage reported to the user
        # as "your question is outside my knowledge base", which is a false
        # statement on a trust surface.
        assert "nothing in my current knowledge base" not in lowered

    def test_unsupported_admits_material_was_found(self):
        """Saying 'nothing is relevant' would be wrong and would read as a bug."""
        body = refuse(self._request(), _retrieval(), reason="unsupported").proposals[0].body
        assert "found material in the same area" in body.lower()

    def test_each_reason_is_traceable_to_its_own_core(self):
        """A coverage gap and a provider outage must not share a dashboard line."""
        cores = {
            r: refuse(self._request(), _retrieval(), reason=r).core
            for r in ("no_sources", "unsupported", "unverified")
        }
        assert len(set(cores.values())) == 3
        assert cores["no_sources"] == "refusing-v0"

    @pytest.mark.parametrize("reason", ["no_sources", "unsupported", "unverified"])
    def test_no_em_dash_in_any_refusal(self, reason):
        """Rule 22. This is user-facing copy."""
        body = refuse(self._request(), _retrieval(), reason=reason).proposals[0].body
        assert "—" not in body

    @pytest.mark.parametrize("reason", ["no_sources", "unsupported", "unverified"])
    def test_every_refusal_says_nothing_was_spent(self, reason):
        body = refuse(self._request(), _retrieval(), reason=reason).proposals[0].body
        assert "Nothing has been spent" in body

    @pytest.mark.parametrize("reason", ["no_sources", "unsupported", "unverified"])
    def test_every_refusal_is_ungrounded_and_uncited(self, reason):
        """A refusal must never carry citations: there is nothing it is citing FOR."""
        res = refuse(self._request(), _retrieval(), reason=reason)
        assert res.grounded is False
        assert res.citations == []


class TestEndpointWiring:
    """The gate has to sit between retrieval and generation, not beside it."""

    class _Retriever:
        def __init__(self, result):
            self.result = result

        async def retrieve(self, *_a, **_k):
            return self.result

    class _Providers:
        """Records whether generation was reached. It must not be, when blocked."""

        def __init__(self, verdict: str):
            self.verdict = verdict
            self.generated = False

        async def complete_json(self, *, system, user, model=None, max_tokens=None):
            if "whether a set of reference sources" in system:
                return self.verdict
            self.generated = True
            return "{}"

        async def complete(self, *, system, user):
            self.generated = True
            return "text"

    def _install(self, verdict: str, *, enabled: bool = True):
        providers = self._Providers(verdict)
        main_module.state.retriever = self._Retriever(_retrieval(2))
        main_module.state.providers = providers
        main_module.state.settings = _settings(
            groundedness_check=enabled, query_decomposition=False
        )
        return providers

    def test_an_unsupported_verdict_refuses_before_generating(self):
        providers = self._install('{"supported": false, "reason": "no webinar material"}')
        body = (
            TestClient(app)
            .post(
                "/plan",
                json={
                    "room_id": "r",
                    "goal": "how do I build a webinar funnel",
                    "trace": {"agent_run_id": "run-1"},
                },
            )
            .json()
        )

        assert body["grounded"] is False
        assert body["core"] == "refusing-ungrounded-v1"
        assert body["citations"] == []
        assert providers.generated is False, (
            "the gate must block before generation, not filter its output: a plan "
            "that was written and then discarded has already cost the call"
        )

    def test_an_unverifiable_check_refuses_with_the_honest_reason(self):
        self._install("not json")
        body = (
            TestClient(app)
            .post(
                "/plan",
                json={"room_id": "r", "goal": "grow my app", "trace": {"agent_run_id": "run-1"}},
            )
            .json()
        )

        assert body["core"] == "refusing-unverified-v1"

    def test_a_supported_verdict_lets_generation_proceed(self):
        providers = self._install('{"supported": true, "reason": "covers it"}')
        TestClient(app).post(
            "/plan",
            json={"room_id": "r", "goal": "lower my CPA", "trace": {"agent_run_id": "run-1"}},
        ).json()

        assert providers.generated is True

    def test_disabling_the_gate_skips_it_entirely(self):
        """The flag exists so the eval can separate the stages. It must really skip."""
        providers = self._install('{"supported": false}', enabled=False)
        TestClient(app).post(
            "/plan",
            json={"room_id": "r", "goal": "lower my CPA", "trace": {"agent_run_id": "run-1"}},
        ).json()

        assert providers.generated is True
