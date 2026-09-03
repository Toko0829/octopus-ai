"""Bounded-concurrent sub-query passes, and the ordering the gate depends on.

`RERANK_FANOUT` is a performance setting, so the tests that matter are not about
speed: they are about the two properties a fan-out can silently break. The goal
pass must still finish, alone, before any sub-query starts, because its result is
what decides whether sub-queries may run at all; and the merged chunks must not
depend on how many passes ran at once.

No torch and no network. The providers are stubbed and the concurrency is
observed by counting in-flight reranks, which is the thing the semaphore actually
bounds.
"""

import asyncio

import pytest

from octopus_ai.providers import RerankHit
from octopus_ai.retrieval import Retriever
from test_retrieval import StubDb, make_settings, row


class RecordingProviders:
    """Counts concurrent reranks and records the order of every stage.

    The sleep is deliberate rather than incidental: without a real suspension
    point inside `rerank`, a pass could complete between two others starting and
    a broken semaphore would still measure as bounded.
    """

    def __init__(self, score: float = 0.42) -> None:
        self.events: list[tuple[str, str]] = []
        self.embedded: list[str] = []
        self.reranked: list[str] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self._score = score

    async def embed(self, texts):
        self.embedded.append(texts[0])
        self.events.append(("embed", texts[0]))
        await asyncio.sleep(0)
        return [[0.0] * 1024 for _ in texts]

    async def rerank(self, query, documents, top_n):
        self.reranked.append(query)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        self.events.append(("rerank-start", query))
        try:
            await asyncio.sleep(0.01)
            hit_count = min(top_n, len(documents))
            return [RerankHit(index=i, score=self._score) for i in range(hit_count)]
        finally:
            self.in_flight -= 1
            self.events.append(("rerank-end", query))


def _rows():
    return [row("a", "Relevant"), row("b", "Also relevant")]


@pytest.mark.asyncio
async def test_fanout_one_is_the_sequential_loop_it_replaced():
    """The default must be indistinguishable from before this setting existed.

    Embed order equal to input order is the property `tests/test_vocabulary.py`
    already leans on, and one rerank in flight is the loop itself.
    """
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=1)
    providers = RecordingProviders()
    subs = ["q", "sub one", "sub two", "sub three"]

    await Retriever(settings, StubDb(_rows()), providers).retrieve("q", subqueries=subs)

    assert providers.embedded == ["q", "sub one", "sub two", "sub three"]
    assert providers.max_in_flight == 1


@pytest.mark.asyncio
async def test_fanout_two_runs_two_passes_at_once_and_no_more():
    """The bound is the point. Unbounded concurrency is what divides the budget wrongly."""
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=2)
    providers = RecordingProviders()
    subs = ["q", "one", "two", "three", "four", "five"]

    await Retriever(settings, StubDb(_rows()), providers).retrieve("q", subqueries=subs)

    assert providers.max_in_flight == 2
    # Every sub-query is still reranked against itself, which is what
    # decomposition is bought for; only the ordering changed.
    assert set(providers.reranked) == {"q", "one", "two", "three", "four", "five"}


@pytest.mark.asyncio
async def test_the_goal_pass_finishes_before_any_subquery_begins():
    """The grounding gate, expressed as an ordering.

    `if not base.chunks: return base` is what stops sub-queries manufacturing
    grounding for a goal the corpus cannot answer, and it was measured rather than
    assumed: a car-licence goal decomposed into plausible marketing sub-queries
    that each legitimately retrieved and cleared the threshold. Folding the goal
    into the gathered section would mean sub-queries had already run before the
    gate could refuse them.
    """
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=3)
    providers = RecordingProviders()
    subs = ["q", "one", "two", "three"]

    await Retriever(settings, StubDb(_rows()), providers).retrieve("q", subqueries=subs)

    base_done = providers.events.index(("rerank-end", "q"))
    first_sub = min(providers.events.index(("embed", sub)) for sub in ["one", "two", "three"])
    assert base_done < first_sub


@pytest.mark.asyncio
async def test_a_goal_that_retrieves_nothing_still_spends_no_subquery_pass():
    """The gate under fan-out. Concurrency must not race past a refusal."""
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=3)
    providers = RecordingProviders(score=0.0001)
    subs = ["q", "one", "two"]

    result = await Retriever(settings, StubDb(_rows()), providers).retrieve("q", subqueries=subs)

    assert result.grounded is False
    assert providers.reranked == ["q"]


@pytest.mark.asyncio
async def test_the_merged_result_does_not_depend_on_the_fanout():
    """A performance setting that changes an answer is not a performance setting."""
    subs = ["q", "one", "two", "three", "four"]
    rows = _rows()

    sequential = await Retriever(
        make_settings(rerank_min_score=0.05, rerank_fanout=1),
        StubDb(rows),
        RecordingProviders(),
    ).retrieve("q", subqueries=subs)
    concurrent = await Retriever(
        make_settings(rerank_min_score=0.05, rerank_fanout=3),
        StubDb(rows),
        RecordingProviders(),
    ).retrieve("q", subqueries=subs)

    assert [c.chunk_id for c in concurrent.chunks] == [c.chunk_id for c in sequential.chunks]
    assert concurrent.candidates_considered == sequential.candidates_considered
    assert concurrent.dropped_below_threshold == sequential.dropped_below_threshold
    # `gather` preserves INPUT order regardless of completion order, which is what
    # keeps the per-query score traces deterministic under fan-out.
    assert [c.query for c in concurrent.scored] == [c.query for c in sequential.scored]


@pytest.mark.asyncio
async def test_every_pass_carries_its_own_timing():
    """One entry per pass, because the stages are not comparable across passes.

    `wall_ms` is the whole call rather than the sum: under fan-out the passes
    overlap, and the gap between the sum and the wall is the concurrency actually
    achieved.
    """
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=2)
    subs = ["q", "one", "two"]

    result = await Retriever(settings, StubDb(_rows()), RecordingProviders()).retrieve(
        "q", subqueries=subs
    )

    assert [t.query for t in result.timings] == ["q", "one", "two"]
    assert all(t.candidates == 2 for t in result.timings)
    assert result.wall_ms >= 0
    assert all(t.rerank_ms >= 0 for t in result.timings)


@pytest.mark.asyncio
async def test_a_single_pass_still_reports_the_whole_call(caplog):
    """The undecomposed path returns the base pass directly, so it must restate the wall.

    Otherwise `wall_ms` would mean "this call" on one branch and "one pass of it"
    on another, which is the kind of field that gets read wrong once and then
    quoted in a doc.
    """
    settings = make_settings(rerank_min_score=0.05)

    result = await Retriever(settings, StubDb(_rows()), RecordingProviders()).retrieve("q")

    assert len(result.timings) == 1
    assert result.wall_ms >= result.timings[0].rerank_ms


@pytest.mark.asyncio
async def test_the_run_id_reaches_the_log_line(caplog):
    """observability.md requires the run id to be pivotable from any log line.

    The retrieval path was never given one, so its logs could be read for what
    happened but not joined to the run it happened in.
    """
    settings = make_settings(rerank_min_score=0.05, rerank_fanout=2)
    caplog.set_level("INFO", logger="octopus.ai.retrieval")

    await Retriever(settings, StubDb(_rows()), RecordingProviders()).retrieve(
        "q", subqueries=["q", "one"], agent_run_id="run-abc"
    )

    complete = [r for r in caplog.records if r.message == "retrieval complete"]
    assert complete, "no retrieval completed"
    assert all(getattr(r, "agent_run_id", None) == "run-abc" for r in complete)

    decomposed = [r for r in caplog.records if r.message == "decomposed retrieval"]
    assert [getattr(r, "agent_run_id", None) for r in decomposed] == ["run-abc"]
    assert decomposed[0].fanout == 2
    assert decomposed[0].passes == 2


@pytest.mark.asyncio
async def test_no_run_id_leaves_the_field_off_rather_than_logging_none(caplog):
    """A literal `None` in a log field is worse than its absence: it is filterable."""
    settings = make_settings(rerank_min_score=0.05)
    caplog.set_level("INFO", logger="octopus.ai.retrieval")

    await Retriever(settings, StubDb(_rows()), RecordingProviders()).retrieve("q")

    complete = [r for r in caplog.records if r.message == "retrieval complete"]
    assert complete
    assert not hasattr(complete[0], "agent_run_id")
