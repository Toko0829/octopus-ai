"""Retrieval: hybrid search, then cross-encoder rerank, then a hard threshold.

The pipeline from rag.md, in order:

    query -> normalise vocabulary -> embed -> [dense + sparse, fused with RRF in
    Postgres] -> rerank -> drop weak

The last step is the one that is easy to skip and expensive to skip. A relevance
threshold DROPS weak chunks rather than padding the context window with them:
handing a model six loosely related paragraphs is how confident, wrong,
"grounded" answers get produced.

The first step is the newest. `vocabulary.normalise_query` rewrites the metric
words a founder uses into the ones the corpus is written in, because at a 1.76x
threshold margin a synonym the corpus lacks refuses a request the corpus can
answer. It runs here, on the goal and on every sub-query, rather than in intake:
this is the one point every retrieval passes through, including the executor's
per-step re-retrieval, the seed probe, both eval harnesses, and the goals that
skip intake's questions entirely via `_passthrough`.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import time
from dataclasses import dataclass

from .config import Settings
from .db import Database
from .providers import Providers
from .vocabulary import normalise_query

logger = logging.getLogger("octopus.ai.retrieval")


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    text: str
    title: str
    market: str | None
    doc_type: str | None
    effective_date: str | None
    source_url: str | None
    source_label: str | None
    authority: str | None
    rrf_score: float
    rerank_score: float

    @property
    def citation_label(self) -> str:
        """What the reader sees next to a claim.

        The document title, not the source label: a corpus where every citation
        reads "Octopus internal playbook" is unusable for checking anything, and
        checking is the entire purpose of a citation.
        """
        return self.title or self.source_label or "Untitled source"


@dataclass(frozen=True)
class ScoredCandidate:
    """One reranked candidate and the score that decided its fate.

    Recorded for every candidate, kept *and* dropped, because the number worth
    seeing is the margin rather than the count. A chunk at 0.0011 against a
    0.0013 threshold is a near-miss and one at 0.00002 is not, and a result that
    only reports `dropped_below_threshold` cannot tell those two apart. That
    distinction is exactly the one the registrations/signups refusal turned on:
    the corpus could answer the question and the survivor missed by a factor
    under two, which looked identical to "nothing relevant" from outside.

    Nothing in the request path reads this. It is built from values already in
    hand during the loop that builds the chunks, and `tools/rag-lens` plots it
    against the threshold line.
    """

    query: str
    chunk_id: str
    title: str
    rerank_score: float
    rrf_score: float
    kept: bool


@dataclass(frozen=True)
class PassTiming:
    """Where one retrieval pass spent its time.

    Recorded per pass rather than per request because the three stages are not
    remotely comparable and an aggregate hides which one moved: embedding is one
    forward pass, hybrid search is one round trip to Postgres, and reranking is N
    forward passes over a cross-encoder. Every latency figure in
    `ai-orchestrator.md` up to this point was taken by hand with a stopwatch,
    because the service had no timing instrumentation anywhere: one
    `time.monotonic()` in the rate limiter and nothing else. A number nobody can
    reproduce from a log line is a number that goes stale without anyone noticing.
    """

    query: str
    candidates: int
    embed_ms: int
    search_ms: int
    rerank_ms: int


@dataclass(frozen=True)
class RetrievalResult:
    chunks: list[RetrievedChunk]
    candidates_considered: int
    dropped_below_threshold: int
    # Defaulted so every existing construction site stays valid and so a caller
    # that does not care never has to thread it through.
    scored: tuple[ScoredCandidate, ...] = ()
    # Defaulted for the same reason. `wall_ms` is the whole `retrieve` call
    # including the gathered section, so it is NOT the sum of `timings`: under
    # fan-out the passes overlap, and the gap between the sum and the wall is the
    # concurrency actually achieved.
    timings: tuple[PassTiming, ...] = ()
    wall_ms: int = 0

    @property
    def grounded(self) -> bool:
        """True only if something survived. Empty retrieval is not grounding."""
        return len(self.chunks) > 0


def _with_wall(result: RetrievalResult, started: float) -> RetrievalResult:
    """Stamp the whole-call wall time onto a single-pass result.

    The undecomposed and gate-refused paths return the base pass directly, and
    that pass's own `wall_ms` covers only itself. Callers reading `wall_ms` should
    get "how long did retrieve take" on every path, not "on the decomposed one
    only", so the one-pass paths restate it rather than leaving a field that means
    something different depending on which branch produced it.
    """
    return dataclasses.replace(result, wall_ms=int((time.perf_counter() - started) * 1000))


class Retriever:
    def __init__(self, settings: Settings, db: Database, providers: Providers) -> None:
        self._s = settings
        self._db = db
        self._providers = providers
        # On the Retriever rather than per call, because `main.py` builds exactly
        # one for the process and the thread budget was divided for a
        # PROCESS-wide bound. A semaphore created per `retrieve` would let two
        # concurrent /plan requests run `2 * RERANK_FANOUT` passes on threads
        # divided for one.
        self._fanout = asyncio.Semaphore(settings.rerank_fanout)

    async def retrieve(
        self,
        query: str,
        *,
        market: str | None = None,
        business_type: str | None = None,
        project_id: str | None = None,
        room_id: str | None = None,
        subqueries: list[str] | None = None,
        agent_run_id: str | None = None,
    ) -> RetrievalResult:
        """Retrieve for a query, optionally widened by decomposed sub-queries.

        **Each sub-query is reranked against itself**, and the survivors are
        merged. That costs one rerank pass per sub-query, and the cost is
        deliberate: the cheaper design was tried first and measured, and it did
        not work.

        That design searched every sub-query but ran a single rerank against the
        original goal. It changed nothing, for a reason the numbers made obvious.
        Candidate breadth was never the bottleneck: when it was measured,
        `retrieval_candidates` was 40 against a corpus of ~43 chunks, so one
        search already returned nearly everything and a union had nothing to add.
        ADR-0009 later cut it to 25 on the same reasoning, and it is a setting
        tied to corpus size rather than a constant, so it is worth re-measuring
        as the corpus grows. The bottleneck is the rerank,
        where a broad goal scores uniformly badly against specific chunks (top
        0.066, against 0.474 for a focused query), so almost nothing clears the
        threshold and the planner is left with material for two or three stages.

        Scoring "how do I price my offer" against the pricing chunks is a
        question the cross-encoder can answer well. Scoring "get my first 100
        customers" against them is not. Hence one rerank per sub-query.

        **The sub-query passes are bounded-concurrent**, at most `RERANK_FANOUT`
        at a time, and the thread budget is divided by the same number
        (`runtime.thread_budget`) so total CPU demand is unchanged. The loop was
        sequential because rerank used to be a metered Cohere call where
        serialising was the point; since ADR-0009 it is in-process CPU work with
        no quota. Concurrency is NOT free here: the default is 1, because a pass
        already saturates the box and the goal pass has to run alone first, so
        fan-out is a measurement rather than an obvious win. `octopus_ai.bench`
        is what decides the number, and on the Cohere path `_RateLimiter` still
        serialises inside `rerank` regardless of what it says.

        **Vocabulary is normalised first**, here rather than inside
        `_retrieve_one`, so that function stays a pure "one query, one search"
        and there is exactly one place that rewrites anything. Sub-queries are
        normalised too: they are written by a model that has read the person's
        wording, so they inherit the person's vocabulary along with it.
        """
        started = time.perf_counter()
        # Merged into every log line this call emits. `observability.md` requires
        # the run id to be pivotable from any line, and until now the retrieval
        # path was never given one: its logs could be read for what happened but
        # not joined to the run they happened in.
        trace = {"agent_run_id": agent_run_id} if agent_run_id else {}

        query, fired = normalise_query(query)
        if subqueries:
            normalised_subs: list[str] = []
            for sub in subqueries:
                text, sub_fired = normalise_query(sub)
                normalised_subs.append(text)
                fired = fired + sub_fired
            subqueries = normalised_subs
        if fired:
            # Logged because a rewrite nobody can attribute is a rewrite nobody
            # can debug, and this one sits upstream of every retrieval.
            logger.info(
                "vocabulary normalised", extra={**trace, "rules": sorted(set(fired))}
            )

        queries = subqueries or [query]

        # The goal itself is always searched first, alone, and it is the gate. It
        # is deliberately NOT one of the fanned-out passes: the check below reads
        # its result to decide whether sub-queries may run at all, so running it
        # concurrently with them would destroy the property it exists for.
        base = await self._retrieve_one(
            query,
            market=market,
            business_type=business_type,
            project_id=project_id,
            room_id=room_id,
            agent_run_id=agent_run_id,
        )

        if len(queries) == 1:
            return _with_wall(base, started)

        # If the goal retrieves nothing, sub-queries must not manufacture
        # grounding for it. Measured, not assumed: with this check absent, "how
        # to get a car licence" decomposed into plausible marketing sub-queries
        # ("how do I position my offer"), each of which legitimately retrieved
        # marketing content and cleared the threshold. The agent then held cited
        # sources for a question the corpus cannot answer, which is the exact
        # failure the groundedness gate exists to prevent. The golden set's
        # negative half caught it.
        #
        # Decomposition is additive to an already-grounded answer. It never
        # creates grounding from nothing.
        if not base.chunks:
            logger.info(
                "goal retrieved nothing; skipping sub-queries rather than inventing grounding",
                extra={**trace, "subqueries": len(queries)},
            )
            return _with_wall(base, started)

        subs = [sub for sub in queries if sub != query]

        async def bounded(sub: str) -> RetrievalResult:
            async with self._fanout:
                return await self._retrieve_one(
                    sub,
                    market=market,
                    business_type=business_type,
                    project_id=project_id,
                    room_id=room_id,
                    agent_run_id=agent_run_id,
                )

        subs_started = time.perf_counter()
        # `gather` preserves INPUT order regardless of completion order, which is
        # what keeps the concatenated `scored` traces and the timings
        # deterministic under fan-out. The chunk merge below is order-invariant
        # anyway (a dict keyed on chunk_id keeping the max score), so the ordering
        # guarantee is for the diagnostics rather than the result.
        results = [base, *await asyncio.gather(*(bounded(sub) for sub in subs))]
        subqueries_ms = int((time.perf_counter() - subs_started) * 1000)

        # Merge survivors, keeping the best rerank score each chunk earned under
        # whichever sub-query suited it. Ordering by that score keeps the most
        # confidently-relevant material first regardless of which stage found it.
        best: dict[str, RetrievedChunk] = {}
        for result in results:
            for chunk in result.chunks:
                current = best.get(chunk.chunk_id)
                if current is None or chunk.rerank_score > current.rerank_score:
                    best[chunk.chunk_id] = chunk

        merged = sorted(best.values(), key=lambda c: c.rerank_score, reverse=True)
        considered = sum(r.candidates_considered for r in results)
        dropped = sum(r.dropped_below_threshold for r in results)

        timings = tuple(t for r in results for t in r.timings)
        total_ms = int((time.perf_counter() - started) * 1000)

        logger.info(
            "decomposed retrieval",
            extra={
                **trace,
                "subqueries": len(queries),
                "kept": len(merged),
                "documents": len({c.document_id for c in merged}),
                "fanout": self._s.rerank_fanout,
                "passes": len(results),
                "base_ms": base.wall_ms,
                # Wall of the gathered section, against the sum of the passes
                # inside it. The two are equal at fanout 1 and diverge by however
                # much concurrency was actually achieved, which is the one number
                # that says whether the fan-out did anything.
                "subqueries_ms": subqueries_ms,
                "rerank_ms": sum(t.rerank_ms for t in timings),
                "total_ms": total_ms,
            },
        )
        return RetrievalResult(
            chunks=merged,
            candidates_considered=considered,
            dropped_below_threshold=dropped,
            timings=timings,
            wall_ms=total_ms,
            # Concatenated rather than merged: a chunk scored once per sub-query
            # and the per-query scores are the point. Collapsing them to a best
            # score would hide that a chunk clears one stage's question and not
            # another's, which is the behaviour decomposition exists to buy.
            scored=tuple(c for r in results for c in r.scored),
        )

    async def _retrieve_one(
        self,
        query: str,
        *,
        market: str | None = None,
        business_type: str | None = None,
        project_id: str | None = None,
        room_id: str | None = None,
        agent_run_id: str | None = None,
    ) -> RetrievalResult:
        """One query: embed, hybrid search, rerank, drop below threshold.

        Each of the three stages is timed. They are not comparable in cost and
        the whole point of measuring is to stop guessing which one dominates, so
        an undifferentiated total would be the wrong instrument.
        """
        trace = {"agent_run_id": agent_run_id} if agent_run_id else {}
        started = time.perf_counter()

        stage = time.perf_counter()
        [query_vector] = await self._providers.embed([query])
        embed_ms = int((time.perf_counter() - stage) * 1000)

        stage = time.perf_counter()
        rows = await self._db.hybrid_search(
            embedding=query_vector,
            query=query,
            market=market,
            business_type=business_type,
            candidates=self._s.retrieval_candidates,
            limit=self._s.retrieval_candidates,
            project_id=project_id,
            room_id=room_id,
        )
        search_ms = int((time.perf_counter() - stage) * 1000)

        if not rows:
            logger.info(
                "retrieval returned no candidates",
                extra={**trace, "query_len": len(query), "embed_ms": embed_ms,
                       "search_ms": search_ms},
            )
            return RetrievalResult(
                chunks=[],
                candidates_considered=0,
                dropped_below_threshold=0,
                timings=(
                    PassTiming(
                        query=query,
                        candidates=0,
                        embed_ms=embed_ms,
                        search_ms=search_ms,
                        rerank_ms=0,
                    ),
                ),
                wall_ms=int((time.perf_counter() - started) * 1000),
            )

        # Rerank against the contextualised text, which is what was embedded and
        # what actually carries the situating detail. Falling back to the raw
        # chunk keeps this working for documents ingested without contextualising.
        documents = [
            f"{row.get('context_prefix') or ''}\n{row['chunk_text']}".strip() for row in rows
        ]
        stage = time.perf_counter()
        hits = await self._providers.rerank(query, documents, self._s.rerank_top_n)
        rerank_ms = int((time.perf_counter() - stage) * 1000)

        chunks: list[RetrievedChunk] = []
        scored: list[ScoredCandidate] = []
        dropped = 0
        for hit in hits:
            row = rows[hit.index]
            kept = hit.score >= self._s.active_rerank_min_score
            scored.append(
                ScoredCandidate(
                    query=query,
                    chunk_id=row["chunk_id"],
                    title=row["title"],
                    rerank_score=hit.score,
                    rrf_score=float(row.get("rrf_score") or 0.0),
                    kept=kept,
                )
            )
            if not kept:
                dropped += 1
                continue
            chunks.append(
                RetrievedChunk(
                    chunk_id=row["chunk_id"],
                    document_id=row["document_id"],
                    text=row["chunk_text"],
                    title=row["title"],
                    market=row.get("market"),
                    doc_type=row.get("doc_type"),
                    effective_date=row.get("effective_date"),
                    source_url=row.get("source_url"),
                    source_label=row.get("source_label"),
                    authority=row.get("authority"),
                    rrf_score=float(row.get("rrf_score") or 0.0),
                    rerank_score=hit.score,
                )
            )

        logger.info(
            "retrieval complete",
            extra={
                **trace,
                "candidates": len(rows),
                "kept": len(chunks),
                "dropped": dropped,
                "embed_ms": embed_ms,
                "search_ms": search_ms,
                "rerank_ms": rerank_ms,
            },
        )
        return RetrievalResult(
            chunks=chunks,
            candidates_considered=len(rows),
            dropped_below_threshold=dropped,
            scored=tuple(scored),
            timings=(
                PassTiming(
                    query=query,
                    candidates=len(rows),
                    embed_ms=embed_ms,
                    search_ms=search_ms,
                    rerank_ms=rerank_ms,
                ),
            ),
            wall_ms=int((time.perf_counter() - started) * 1000),
        )
