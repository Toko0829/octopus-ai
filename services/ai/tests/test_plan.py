"""Endpoint contract and the ADR-0006 invariants.

Runs with no API keys and no database: CI has neither, and a test suite that
needs live credentials is a test suite that gets skipped. Real providers are
exercised by the eval gate, not here.

TestClient is deliberately not used as a context manager, so the lifespan (which
builds real clients and requires configuration) never runs.
"""

from fastapi.testclient import TestClient

import octopus_ai.main as main_module
from octopus_ai.main import app
from octopus_ai.retrieval import RetrievalResult

client = TestClient(app)

GOAL = "launch and grow my focus app Rune, get me to my first 1,000 paying users"


def _payload(goal: str = GOAL, **trace):
    return {
        "room_id": "room-1",
        "goal": goal,
        "trace": {"agent_run_id": "run-1", "project_id": None, **trace},
    }


class StubRetriever:
    """Retrieval that returns nothing, forcing the refusal path."""

    def __init__(self, exc: Exception | None = None):
        self.exc = exc
        self.calls = 0

    async def retrieve(self, *_a, **_k):
        self.calls += 1
        if self.exc:
            raise self.exc
        return RetrievalResult(chunks=[], candidates_considered=0, dropped_below_threshold=0)


def _install(retriever) -> None:
    main_module.state.retriever = retriever
    main_module.state.providers = object()
    main_module.state.settings = object()


def test_health_ok_without_configuration():
    """Liveness must not depend on provider keys being present."""
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_health_reports_configuration_state_without_leaking_it():
    body = client.get("/health").json()
    assert "configured" in body
    assert isinstance(body["configured"], bool)
    assert "key" not in str(body).lower()


class TestSchemaValidation:
    def test_empty_goal_is_rejected(self):
        assert client.post("/plan", json=_payload(goal="")).status_code == 422

    def test_oversized_goal_is_rejected(self):
        assert client.post("/plan", json=_payload(goal="x" * 5000)).status_code == 422

    def test_trace_context_is_required(self):
        """agent_run_id is how a step here ties back to its run in Node."""
        res = client.post("/plan", json={"room_id": "r", "goal": GOAL})
        assert res.status_code == 422


class TestGroundedness:
    def test_empty_retrieval_refuses_rather_than_answering(self):
        _install(StubRetriever())
        body = client.post("/plan", json=_payload()).json()

        assert body["grounded"] is False
        assert body["citations"] == []
        assert body["core"] == "refusing-v0"
        assert len(body["proposals"]) == 1

    def test_retrieval_failure_refuses_rather_than_answering(self):
        """A broken index must not silently downgrade to parametric knowledge."""
        _install(StubRetriever(exc=RuntimeError("index unavailable")))
        body = client.post("/plan", json=_payload()).json()

        assert body["grounded"] is False
        assert body["core"] == "refusing-v0"

    def test_refusal_still_echoes_the_goal_so_it_is_not_lost(self):
        _install(StubRetriever())
        body = client.post("/plan", json=_payload(goal="grow my newsletter")).json()
        assert "grow my newsletter" in body["proposals"][0]["body"]

    def test_refusal_copy_has_no_em_dash(self):
        _install(StubRetriever())
        body = client.post("/plan", json=_payload()).json()
        assert "—" not in body["proposals"][0]["body"]


def test_proposals_are_the_only_output_shape():
    """ADR-0006: this service proposes. It must never return a result implying
    it performed an action."""
    _install(StubRetriever())
    body = client.post("/plan", json=_payload()).json()

    for proposal in body["proposals"]:
        assert proposal["kind"] == "post_message"
    assert "posted" not in body
    assert "message_id" not in body


def test_service_holds_no_database_client_for_user_data():
    """The 'Python cannot move money' argument is structural, not a convention.

    This service reads and writes the RAG corpus, but nothing here should ever
    import a Supabase client capable of acting as a user. If that changes, the
    ADR-0006 boundary needs rewriting, not this test deleting.
    """
    import octopus_ai.planner as planner_module

    for module in (main_module, planner_module):
        for attr in vars(module).values():
            assert "supabase" not in type(attr).__module__.lower()


class TestGenerationTarget:
    """The connector fields on the wire, and what a 422 is allowed to say back.

    The refusal path is enough for both: which model would have answered is
    settled before retrieval runs, and a request that never validates never
    reaches a provider at all.
    """

    def test_a_target_is_accepted_on_both_fields(self):
        _install(StubRetriever())
        payload = _payload()
        payload["generation"] = {
            "vendor": "anthropic",
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "api_key": "sk-customer",
        }
        payload["generation_fallback"] = {
            "vendor": "google",
            "provider": "google",
            "model": "gemini-3.8-flash",
            "api_key": "sk-customer-2",
        }

        assert client.post("/plan", json=payload).status_code == 200

    def test_a_request_without_one_still_validates(self):
        """A workspace that connects nothing is the majority case."""
        _install(StubRetriever())
        assert client.post("/plan", json=_payload()).status_code == 200

    def test_a_target_missing_a_field_never_echoes_the_key_back(self):
        """This is the leak, and it is a real one rather than a precaution.

        On a MISSING field pydantic v2 reports the error against the parent and
        puts the whole parent OBJECT in `input`, so FastAPI's default handler
        returns the customer's API key in the 422 body, from a path nobody thinks
        of as a data path. Verified directly against pydantic 2.13, not assumed.

        A wrong `vendor` does not leak, because a literal error's `input` is the
        one bad value. Both are covered here so the next person does not conclude
        from the harmless case that the handler is unnecessary.
        """
        payload = _payload()
        payload["generation"] = {
            "vendor": "anthropic",
            "provider": "anthropic",
            "api_key": "sk-customer-must-not-come-back",
        }

        res = client.post("/plan", json=payload)
        assert res.status_code == 422
        assert "sk-customer-must-not-come-back" not in res.text
        # Still usable: the field and the reason are the whole of what a caller
        # needs to fix its request.
        assert "model" in res.text

    def test_an_unknown_vendor_is_rejected_and_says_which_are_known(self):
        payload = _payload()
        payload["generation"] = {
            "vendor": "not-a-vendor",
            "provider": "anthropic",
            "model": "claude-sonnet-5",
            "api_key": "sk-customer-must-not-come-back",
        }

        res = client.post("/plan", json=payload)
        assert res.status_code == 422
        assert "sk-customer-must-not-come-back" not in res.text
        assert "vendor" in res.text

    def test_the_house_default_is_reported_without_a_key(self):
        """Node's settings surface has to be able to say what "Auto" means."""
        body = client.get("/health").json()
        assert "generation_model" in body
        assert "generation_provider" in body
        assert "api_key" not in body
