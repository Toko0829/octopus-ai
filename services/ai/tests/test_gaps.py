"""The refusal ledger: what it writes, and the properties that keep it harmless.

Two halves, and the second is the one that would go unnoticed if it broke. The
first asserts the row says what happened. The second asserts the ledger cannot
affect the request it is recording: a database that is down, slow, or rejecting
must produce a missing row and nothing else, because the caller has already
decided to refuse and is only waiting to say so.
"""

import asyncio

import pytest

from octopus_ai.gaps import GapLedger, summarise_sources
from octopus_ai.retrieval import RetrievalResult, RetrievedChunk, ScoredCandidate


def chunk(chunk_id: str, title: str) -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=chunk_id,
        document_id="doc-1",
        text="body",
        title=title,
        market="US",
        doc_type="playbook",
        effective_date=None,
        source_url=None,
        source_label="Octopus internal playbook",
        authority="internal",
        rrf_score=0.03,
        rerank_score=0.02,
    )


def scored(title: str, score: float, kept: bool = True, query: str = "q") -> ScoredCandidate:
    return ScoredCandidate(
        query=query,
        chunk_id=f"c-{title}-{score}",
        title=title,
        rerank_score=score,
        rrf_score=0.03,
        kept=kept,
    )


def result(chunks=(), scored_candidates=(), considered: int = 25) -> RetrievalResult:
    return RetrievalResult(
        chunks=list(chunks),
        candidates_considered=considered,
        dropped_below_threshold=max(0, len(scored_candidates) - len(chunks)),
        scored=tuple(scored_candidates),
    )


class FakeDb:
    """Records what was written. `fail` makes every write raise."""

    def __init__(self, fail: bool = False):
        self.rows: list[dict] = []
        self.fail = fail

    async def insert_retrieval_gap(self, row: dict) -> None:
        if self.fail:
            raise RuntimeError("PostgREST said no")
        self.rows.append(row)


async def drain() -> None:
    """Let the scheduled writes run. `record` returns before they have."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


# --- summarise_sources -------------------------------------------------------


def test_nearest_misses_are_ordered_best_first():
    r = result(scored_candidates=[scored("C", 0.001), scored("A", 0.02), scored("B", 0.008)])
    assert [s["title"] for s in summarise_sources(r)] == ["A", "B", "C"]


def test_one_document_scored_under_several_subqueries_appears_once():
    """Decomposition scores a document per sub-query.

    Five rows for the same document is five slots spent saying one thing, and the
    kept score should be the best one it earned under whichever sub-query suited
    it, matching how `Retriever.retrieve` merges survivors.
    """
    r = result(
        scored_candidates=[
            scored("Organic social", 0.004, query="should I post myself"),
            scored("Organic social", 0.031, query="how do I grow a following"),
            scored("Organic social", 0.001, query="what should I write"),
        ]
    )
    summary = summarise_sources(r)
    assert len(summary) == 1
    assert summary[0]["score"] == pytest.approx(0.031)


def test_it_keeps_the_kept_flag_so_a_near_miss_is_distinguishable():
    """A count cannot tell a survivor that missed by 1.76x from one nowhere near."""
    r = result(
        scored_candidates=[scored("Kept", 0.02, kept=True), scored("Dropped", 0.0001, False)]
    )
    assert [s["kept"] for s in summarise_sources(r)] == [True, False]


def test_it_is_capped():
    r = result(scored_candidates=[scored(f"D{i}", i / 1000) for i in range(20)])
    assert len(summarise_sources(r)) == 5


def test_no_retrieval_is_an_empty_list_not_a_crash():
    assert summarise_sources(None) == []


# --- what the row says -------------------------------------------------------


@pytest.mark.asyncio
async def test_an_ungrounded_refusal_records_the_gates_reason():
    db = FakeDb()
    r = result(
        chunks=[chunk("c1", "Landing pages")],
        scored_candidates=[scored("Landing pages", 0.0067)],
    )

    GapLedger(db).record(
        core="refusing-ungrounded-v1",
        surface="plan",
        goal="how do I build a webinar funnel that converts",
        retrieval=r,
        reason="the sources never discuss webinars or live sessions",
        room_id="room-1",
        agent_run_id="run-1",
    )
    await drain()

    [row] = db.rows
    assert row["core"] == "refusing-ungrounded-v1"
    assert row["surface"] == "plan"
    assert row["reason"] == "the sources never discuss webinars or live sessions"
    assert row["chunks_retrieved"] == 1
    assert row["candidates_considered"] == 25
    assert row["top_sources"][0]["title"] == "Landing pages"


@pytest.mark.asyncio
async def test_a_no_sources_refusal_records_no_reason():
    """`reason` means "the gate named what was missing".

    Empty string would be a row claiming the gate named nothing, which is a
    different statement from the gate never having run.
    """
    db = FakeDb()
    GapLedger(db).record(
        core="refusing-v0", surface="plan", goal="how to get a car licence", retrieval=result()
    )
    await drain()

    assert db.rows[0]["reason"] is None
    assert db.rows[0]["chunks_retrieved"] == 0


@pytest.mark.asyncio
async def test_the_goal_is_scrubbed_before_it_is_stored():
    """One place decides what reaches the table, so no call site can forget."""
    db = FakeDb()
    GapLedger(db).record(
        core="refusing-v0",
        surface="plan",
        goal="get signups for bluelly.com, email ana@shop.com",
        retrieval=result(),
    )
    await drain()

    stored = db.rows[0]["goal"]
    assert "bluelly" not in stored
    assert "@" not in stored
    # And the part that makes the row worth keeping is still there.
    assert "get signups" in stored


@pytest.mark.asyncio
async def test_the_execute_surface_is_recorded_distinctly():
    """A step refusal means the corpus was thinner than the approved plan assumed."""
    db = FakeDb()
    GapLedger(db).record(
        core="refusing-ungrounded-v1",
        surface="execute",
        goal="Write the cold ad copy. Three variants for the paid test.",
        retrieval=result(chunks=[chunk("c1", "Creative direction")]),
        reason="no source describes ad copy for a paid social test",
    )
    await drain()

    assert db.rows[0]["surface"] == "execute"


@pytest.mark.asyncio
async def test_an_answered_gap_names_the_connector_that_answered_it():
    """The queue is read per provider, so the row has to carry one.

    Two rows with the same core, the same gate reason and the same near misses can
    be two different products once a workspace routes Fallback to its own
    connector. Without this pair, reading the queue averages them.
    """
    db = FakeDb()
    GapLedger(db).record(
        core="ungrounded-general-v1",
        surface="plan",
        goal="how do i build a webinar funnel for my course",
        retrieval=result(chunks=[chunk("c1", "Landing pages")]),
        reason="the sources never discuss webinars or live sessions",
        provider="anthropic",
        model="claude-opus-5",
    )
    await drain()

    assert db.rows[0]["provider"] == "anthropic"
    assert db.rows[0]["model"] == "claude-opus-5"


@pytest.mark.asyncio
async def test_a_refusal_names_no_model_because_no_model_was_called():
    """The default matters more than the value here.

    Every refusal core reaches the ledger without an answer: `refusing-v0` never
    got to generation, and both gate cores are the gate declining or being
    unavailable. Filling these in from the configured house model would put an
    attribution on a sentence no model wrote, which is the mistake
    `messages_model_agent_only` exists to make impossible one table over.
    """
    db = FakeDb()
    for core, retrieved in (
        ("refusing-v0", result()),
        ("refusing-ungrounded-v1", result(chunks=[chunk("c1", "Landing pages")])),
        ("refusing-unverified-v1", result(chunks=[chunk("c1", "Landing pages")])),
    ):
        GapLedger(db).record(core=core, surface="plan", goal="anything", retrieval=retrieved)
    await drain()

    assert len(db.rows) == 3
    assert all(row["provider"] is None and row["model"] is None for row in db.rows)


# --- and it must not be able to hurt the request -----------------------------


@pytest.mark.asyncio
async def test_record_returns_before_the_write_happens():
    """Fire-and-forget: the caller has already decided to refuse.

    A write that retries three times with backoff against a 60-second timeout
    could otherwise add minutes to a request whose entire content is "no".
    """
    db = FakeDb()
    GapLedger(db).record(core="refusing-v0", surface="plan", goal="anything", retrieval=result())

    assert db.rows == []  # nothing written yet, and record() has already returned
    await drain()
    assert len(db.rows) == 1


@pytest.mark.asyncio
async def test_a_failing_database_does_not_raise():
    """A lost gap row costs nothing. An exception on the refusal path costs the refusal."""
    ledger = GapLedger(FakeDb(fail=True))
    ledger.record(core="refusing-v0", surface="plan", goal="anything", retrieval=result())
    await drain()  # must not raise, here or as an unretrieved task exception


@pytest.mark.asyncio
async def test_the_task_is_held_so_the_loop_cannot_collect_it():
    """`create_task` keeps only a weak reference.

    A scheduled write that vanishes mid-flight is the silent failure rule 16
    forbids, so the module holds a reference until the task is done.
    """
    from octopus_ai import gaps

    db = FakeDb()
    GapLedger(db).record(core="refusing-v0", surface="plan", goal="anything", retrieval=result())

    assert len(gaps._in_flight) == 1
    await drain()
    assert gaps._in_flight == set()


def test_no_running_loop_drops_the_row_rather_than_raising():
    """Synchronous callers exist only in tests, and dropping is correct there."""
    GapLedger(FakeDb()).record(
        core="refusing-v0", surface="plan", goal="anything", retrieval=result()
    )
