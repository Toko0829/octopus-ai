"""Scoring logic for the groundedness-gate pass (`--gate`).

Same split as `test_evaluation.py`: the arithmetic and the pass/fail rule are
tested here, and whether the gate's judgement is any good is what running it
against a real corpus answers, which needs credentials and a model.

The rule worth protecting is that this pass scores BOTH halves. A gate measured
only against the questions it should refuse is a gate that scores perfectly by
refusing everything, and that version would ship.
"""

import json
from pathlib import Path

import pytest

from octopus_ai.evaluation import (
    MIN_GATE_BLOCK_RATE,
    GateCaseResult,
    GateReport,
    GoldenCase,
    ScopeCase,
    load_golden,
    load_scope_negatives,
    run_gate_eval,
)
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk

GOLDEN = Path(__file__).resolve().parents[1] / "eval" / "golden.json"


def _case(case_id, *, expect_block, outcome, retrieved=3):
    return GateCaseResult(
        case_id=case_id,
        query="q",
        expect_block=expect_block,
        retrieved=retrieved,
        outcome=outcome,
        reason="because",
    )


class TestScoring:
    def test_a_blocked_scope_negative_counts_as_blocked(self):
        report = GateReport(results=[_case("s", expect_block=True, outcome="unsupported")])
        assert report.block_rate == 1.0

    def test_a_leaked_scope_negative_fails_the_pass(self):
        report = GateReport(
            results=[
                _case("s1", expect_block=True, outcome="unsupported"),
                _case("s2", expect_block=True, outcome="supported"),
                _case("p1", expect_block=False, outcome="supported"),
            ]
        )
        assert report.block_rate == 0.5
        assert not report.passed

    def test_refusing_everything_does_not_pass(self):
        """The whole reason both halves run in one pass.

        Scored on scope negatives alone this gate is perfect. It is also useless:
        it refuses every legitimate goal the product exists to answer.
        """
        report = GateReport(
            results=[
                _case("s1", expect_block=True, outcome="unsupported"),
                _case("s2", expect_block=True, outcome="unsupported"),
                _case("p1", expect_block=False, outcome="unsupported"),
                _case("p2", expect_block=False, outcome="unsupported"),
            ]
        )
        assert report.block_rate == MIN_GATE_BLOCK_RATE
        assert report.pass_rate == 0.0
        assert not report.passed, "a gate that blocks everything must not score a pass"

    def test_a_clean_run_passes(self):
        report = GateReport(
            results=[
                _case("s1", expect_block=True, outcome="unsupported"),
                _case("p1", expect_block=False, outcome="supported"),
                _case("p2", expect_block=False, outcome="supported"),
            ]
        )
        assert report.passed

    def test_unverified_counts_as_a_block_and_is_reported_separately(self):
        """It fails closed, so it blocks. But it measured the provider, not the prompt."""
        report = GateReport(results=[_case("s1", expect_block=True, outcome="unverified")])
        assert report.block_rate == 1.0
        assert [r.case_id for r in report.unverified] == ["s1"]
        assert "measured availability rather than judgement" in report.render()

    def test_the_stage_that_blocked_is_recorded(self):
        """Retrieval refusing and the gate refusing are both correct and not the same.

        Crediting the gate for retrieval's work would hide the day retrieval stops
        doing it.
        """
        by_retrieval = _case("s", expect_block=True, outcome="not-retrieved", retrieved=0)
        by_gate = _case("s", expect_block=True, outcome="unsupported", retrieved=4)
        assert by_retrieval.blocked_by == "retrieval"
        assert by_gate.blocked_by == "gate"


class TestHarness:
    class _Retriever:
        """Returns chunks for everything, which is the leaking case being defended against."""

        def __init__(self, chunks=1):
            self.chunks = chunks
            self.queries: list[str] = []

        async def retrieve(self, query, **_k):
            self.queries.append(query)
            return RetrievalResult(
                chunks=[
                    RetrievedChunk(
                        chunk_id=f"c{i}",
                        document_id="d",
                        text="t",
                        title="Landing pages and conversion for early-stage traffic",
                        market="US",
                        doc_type="playbook",
                        effective_date=None,
                        source_url=None,
                        source_label="internal",
                        authority="internal",
                        rrf_score=0.1,
                        rerank_score=0.4,
                    )
                    for i in range(self.chunks)
                ],
                candidates_considered=25,
                dropped_below_threshold=21,
            )

    async def test_both_halves_are_run(self):
        async def gate(query, _retrieval):
            return ("unsupported" if "webinar" in query else "supported", "r")

        report = await run_gate_eval(
            self._Retriever(),
            gate,
            scope_cases=[ScopeCase(id="s", query="webinar funnel")],
            positive_cases=[GoldenCase(id="p", query="lower my CPA", expect_docs=["X"])],
        )

        assert report.block_rate == 1.0
        assert report.pass_rate == 1.0
        assert report.passed

    async def test_the_gate_is_not_called_when_retrieval_returned_nothing(self):
        """Production does not call it either: retrieval has already refused."""
        called = False

        async def gate(_q, _r):
            nonlocal called
            called = True
            return ("supported", "r")

        report = await run_gate_eval(
            self._Retriever(chunks=0),
            gate,
            scope_cases=[ScopeCase(id="s", query="webinar funnel")],
            positive_cases=[],
        )

        assert called is False
        assert report.scope[0].blocked_by == "retrieval"
        assert report.block_rate == 1.0

    async def test_decomposition_is_used_when_supplied(self):
        """The eval must mirror production. One that skips it measures nobody's pipeline."""

        async def decomposer(q):
            return [q, "sub query one"]

        async def gate(_q, _r):
            return ("supported", "r")

        retriever = self._Retriever()
        await run_gate_eval(
            retriever,
            gate,
            scope_cases=[],
            positive_cases=[GoldenCase(id="p", query="grow my app", expect_docs=["X"])],
            decomposer=decomposer,
        )
        assert retriever.queries == ["grow my app"]


class TestGoldenFile:
    def test_scope_negatives_load(self):
        cases = load_scope_negatives(GOLDEN)
        assert len(cases) >= 5
        assert all(c.query and c.notes for c in cases)

    def test_scope_negatives_are_not_in_the_retrieval_gate(self):
        """Filing them as ordinary negatives would fail the CI gate permanently.

        Retrieval leaks on these by design and no threshold can fix it, so the
        retrieval gate must never be asked to assert something about them.
        """
        retrieval_ids = {c.id for c in load_golden(GOLDEN)}
        scope_ids = {c.id for c in load_scope_negatives(GOLDEN)}
        assert retrieval_ids.isdisjoint(scope_ids)

    def test_ids_are_unique_across_both_sets(self):
        raw = json.loads(GOLDEN.read_text(encoding="utf-8"))
        ids = [c["id"] for c in raw["cases"]] + [c["id"] for c in raw["scope_negatives"]]
        assert len(ids) == len(set(ids))

    def test_scope_negatives_are_marketing_vocabulary(self):
        """The point of this half.

        The four ordinary negatives are all business-formation topics, far from the
        corpus in words as well as subject, so they only ever tested the easy
        direction. These have to share vocabulary with the corpus or they are
        testing the same easy thing again.
        """
        marketing_words = {
            "funnel",
            "conversion",
            "ad",
            "ads",
            "rank",
            "influencer",
            "sponsored",
            "affiliate",
            "commission",
            "tracking",
            "headlines",
            "post",
        }
        for case in load_scope_negatives(GOLDEN):
            words = set(case.query.lower().replace(",", " ").split())
            assert words & marketing_words, (
                f"{case.id} shares no marketing vocabulary with the corpus, so it "
                "tests the same easy direction the existing negatives already cover"
            )

    @pytest.mark.parametrize("case_id", ["scope-webinar-funnel", "scope-ga4-tracking"])
    def test_the_measured_leaks_are_present(self, case_id):
        """These two are the evidence in rag-knowledge.md's overlap table.

        If either is ever deleted, the claim that the threshold cannot be a scope
        gate loses the measurement that supports it.
        """
        assert case_id in {c.id for c in load_scope_negatives(GOLDEN)}
