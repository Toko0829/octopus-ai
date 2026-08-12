"""Scoring logic for the retrieval eval.

No database and no network: these test the arithmetic and the pass/fail rule,
which is the part that must not quietly drift. Whether retrieval is actually
*good* is what running the eval against a real corpus answers, and that needs
credentials.
"""

from octopus_ai.evaluation import (
    MIN_POSITIVE_RECALL,
    CaseResult,
    EvalReport,
    GoldenCase,
    load_golden,
    score_case,
)
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk


def _chunk(title: str, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id="c",
        document_id="d",
        text="body",
        title=title,
        market="US",
        doc_type="playbook",
        effective_date=None,
        source_url=None,
        source_label="Octopus internal playbook",
        authority="internal",
        rrf_score=0.1,
        rerank_score=score,
    )


def _result(*chunks: RetrievedChunk) -> RetrievalResult:
    return RetrievalResult(chunks=list(chunks), candidates_considered=40, dropped_below_threshold=0)


def _positive(**kw) -> CaseResult:
    return CaseResult(
        case=GoldenCase(id="p", query="q", expect_docs=["Wanted"]),
        retrieved_titles=kw.get("titles", []),
        top_score=kw.get("top", None),
        candidates=40,
        dropped=0,
    )


def _negative(titles: list[str]) -> CaseResult:
    return CaseResult(
        case=GoldenCase(id="n", query="q", expect_docs=[]),
        retrieved_titles=titles,
        top_score=titles and 0.2 or None,
        candidates=40,
        dropped=0,
    )


def test_the_shipped_golden_set_parses_and_has_both_halves():
    cases = load_golden()
    positives = [c for c in cases if not c.is_negative]
    negatives = [c for c in cases if c.is_negative]

    assert positives, "a golden set with no positives measures nothing"
    # Negatives are what stop the agent grounding an answer in whatever was
    # nearest, so a set without them would pass while the dangerous failure ships.
    assert negatives, "a golden set with no negatives cannot catch a leak"
    assert len({c.id for c in cases}) == len(cases), "case ids must be unique"


def test_hit_requires_an_expected_document():
    hit = score_case(
        GoldenCase(id="p", query="q", expect_docs=["Wanted"]),
        _result(_chunk("Wanted", 0.5)),
    )
    miss = score_case(
        GoldenCase(id="p", query="q", expect_docs=["Wanted"]),
        _result(_chunk("Something else", 0.5)),
    )

    assert hit.hit and hit.rank_of_first_hit == 1
    assert not miss.hit and miss.rank_of_first_hit is None


def test_rank_is_the_position_of_the_first_expected_document():
    result = score_case(
        GoldenCase(id="p", query="q", expect_docs=["Wanted"]),
        _result(_chunk("Noise", 0.6), _chunk("Wanted", 0.4)),
    )
    assert result.rank_of_first_hit == 2


def test_a_negative_case_leaks_when_anything_survives():
    """The whole point of the negative half.

    Retrieval returning *something* for an out-of-scope query is what lets the
    planner produce a confident, cited answer with no support behind it.
    """
    assert _negative(["Anything at all"]).leaked
    assert not _negative([]).leaked


def test_one_leak_fails_the_gate_regardless_of_positive_recall():
    """Asymmetric on purpose: a leak is unsafe, a miss is merely unhelpful."""
    report = EvalReport(
        results=[
            _positive(titles=["Wanted"]),
            _positive(titles=["Wanted"]),
            _negative(["Off-topic doc"]),
        ]
    )

    assert report.positive_recall == 1.0
    assert len(report.leaks) == 1
    assert not report.passed


def test_clean_negatives_and_sufficient_recall_pass():
    report = EvalReport(
        results=[_positive(titles=["Wanted"]), _positive(titles=["Wanted"]), _negative([])]
    )
    assert report.positive_recall >= MIN_POSITIVE_RECALL
    assert report.passed


def test_low_recall_fails_even_with_no_leaks():
    report = EvalReport(
        results=[
            _positive(titles=["Wanted"]),
            _positive(titles=["Missed"]),
            _positive(titles=["Missed"]),
            _negative([]),
        ]
    )
    assert report.positive_recall < MIN_POSITIVE_RECALL
    assert not report.passed


def test_mrr_rewards_ranking_the_right_document_first():
    first = EvalReport(results=[_positive(titles=["Wanted"])])
    second = EvalReport(results=[_positive(titles=["Noise", "Wanted"])])

    assert first.mrr == 1.0
    assert second.mrr == 0.5
