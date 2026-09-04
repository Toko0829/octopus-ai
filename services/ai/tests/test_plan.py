"""Endpoint contract and the ADR-0006 invariants.

Runs with no API keys and no database: CI has neither, and a test suite that
needs live credentials is a test suite that gets skipped. Real providers are
exercised by the eval gate, not here.

TestClient is deliberately not used as a context manager, so the lifespan (which
builds real clients and requires configuration) never runs.
"""

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import octopus_ai.main as main_module
from octopus_ai.gaps import GapLedger
from octopus_ai.groundedness import Groundedness
from octopus_ai.main import app
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk
from octopus_ai.schemas import PlanResponse, PostMessageProposal

client = TestClient(app)


async def _drain() -> None:
    """Let the ledger's scheduled write run. `record` returns before it has."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)

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


class TestTheAnsweredGapNamesItsConnector:
    """What the ledger records when the ungrounded tier answers, and when it does not.

    The ledger row is the one place a person reads to decide what to ingest next,
    and once a workspace routes Fallback to its own connector, two rows with the
    same core, the same gate reason and the same near misses can be two entirely
    different products. This drives the real `/plan` path rather than
    `GapLedger.record` directly, because the fact worth pinning is not that the
    ledger stores a string it was handed: it is that **the string comes from the
    response the tier actually produced** rather than from the target we asked
    for or from the configured house model.
    """

    @staticmethod
    def _chunk() -> RetrievedChunk:
        return RetrievedChunk(
            chunk_id="c1",
            document_id="doc-1",
            text="Landing pages convert when the promise matches the ad.",
            title="Landing pages",
            market="US",
            doc_type="playbook",
            effective_date=None,
            source_url=None,
            source_label="Octopus internal playbook",
            authority="internal",
            rrf_score=0.03,
            rerank_score=0.02,
        )

    class _Retriever:
        """Retrieval that returns something, so the gate rather than the threshold decides."""

        def __init__(self, chunk):
            self._chunk = chunk

        async def retrieve(self, *_a, **_k):
            return RetrievalResult(
                chunks=[self._chunk], candidates_considered=25, dropped_below_threshold=3
            )

    class _Db:
        def __init__(self):
            self.rows: list[dict] = []

        async def insert_retrieval_gap(self, row: dict) -> None:
            self.rows.append(row)

    def _install_gate(self, monkeypatch, outcome: str, answer):
        """The gate refuses; `answer` is what the tier then returns (or None)."""
        db = self._Db()
        main_module.state.retriever = self._Retriever(self._chunk())
        main_module.state.providers = object()
        main_module.state.settings = SimpleNamespace(
            query_decomposition=False,
            generation_model_cheap="gpt-5.4-nano",
            groundedness_check=True,
            active_groundedness_model="gpt-5.4-nano",
            ungrounded_fallback=True,
        )
        main_module.state.gaps = GapLedger(db)

        async def _assess(*_a, **_k):
            return Groundedness(
                outcome=outcome, reason="the sources never discuss webinars or live sessions"
            )

        async def _answer(*_a, **_k):
            return answer

        monkeypatch.setattr(main_module, "assess", _assess)
        monkeypatch.setattr(main_module, "answer_ungrounded", _answer)
        return db

    def teardown_method(self):
        # The ledger is process state on `main_module`; leaving one installed
        # would make every later refusal test write rows into a dead stub.
        main_module.state.gaps = None

    @pytest.mark.asyncio
    async def test_an_answered_gap_records_the_model_that_answered(self, monkeypatch):
        answered = PlanResponse(
            proposals=[PostMessageProposal(body="General practice, labelled.")],
            grounded=False,
            citations=[],
            reasoning_summary="ungrounded",
            core="ungrounded-general-v1",
            provider="anthropic",
            model="claude-opus-5",
        )
        db = self._install_gate(monkeypatch, "unsupported", answered)

        res = client.post("/plan", json=_payload(goal="how do i build a webinar funnel"))
        assert res.status_code == 200
        await _drain()

        [row] = db.rows
        assert row["core"] == "ungrounded-general-v1"
        assert row["provider"] == "anthropic"
        assert row["model"] == "claude-opus-5"

    @pytest.mark.asyncio
    async def test_a_gate_refusal_records_no_model_because_none_was_called(self, monkeypatch):
        """`unverified` never attempts the tier at all, so nothing answered.

        This is the row that would be wrong if the attribution were read off the
        configuration instead of off the answer: the house model is right there in
        settings, and stamping it here would claim a model wrote a refusal it
        never saw.
        """
        db = self._install_gate(monkeypatch, "unverified", None)

        res = client.post("/plan", json=_payload(goal="how do i build a webinar funnel"))
        assert res.status_code == 200
        await _drain()

        [row] = db.rows
        assert row["core"] == "refusing-unverified-v1"
        assert row["provider"] is None
        assert row["model"] is None

    @pytest.mark.asyncio
    async def test_a_declined_tier_records_no_model_either(self, monkeypatch):
        """`answer_ungrounded` returning None is how a regulated topic declines.

        `is_regulated` runs before any provider is called, so a customer's own key
        is never spent on a tax question and the row that results must name
        nobody. Asserted here rather than only in `test_ungrounded.py` because the
        two halves live in different modules and the row is written by this one.
        """
        db = self._install_gate(monkeypatch, "unsupported", None)

        res = client.post("/plan", json=_payload(goal="do i need to register for vat"))
        assert res.status_code == 200
        await _drain()

        [row] = db.rows
        assert row["core"] == "refusing-ungrounded-v1"
        assert row["provider"] is None
        assert row["model"] is None
