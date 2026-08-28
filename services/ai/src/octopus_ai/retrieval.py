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

import logging
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
class RetrievalResult:
    chunks: list[RetrievedChunk]
    candidates_considered: int
    dropped_below_threshold: int
    # Defaulted so every existing construction site stays valid and so a caller
    # that does not care never has to thread it through.
    scored: tuple[ScoredCandidate, ...] = ()

    @property
    def grounded(self) -> bool:
        """True only if something survived. Empty retrieval is not grounding."""
        return len(self.chunks) > 0


class Retriever:
    def __init__(self, settings: Settings, db: Database, providers: Providers) -> None:
        self._s = settings
        self._db = db
        self._providers = providers

    async def retrieve(
        self,
        query: str,
        *,
        market: str | None = None,
        business_type: str | None = None,
        project_id: str | None = None,
        room_id: str | None = None,
        subqueries: list[str] | None = None,
    ) -> RetrievalResult:
        """Retrieve for a query, optionally widened by decomposed sub-queries.

        **Each sub-query is reranked against itself**, and the survivors are
        merged. That costs one rerank call per sub-query, which is the expensive,
        rate-limited stage, and the cost is deliberate: the cheaper design was
        tried first and measured, and it did not work.

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

        **Vocabulary is normalised first**, here rather than inside
        `_retrieve_one`, so that function stays a pure "one query, one search"
        and there is exactly one place that rewrites anything. Sub-queries are
        normalised too: they are written by a model that has read the person's
        wording, so they inherit the person's vocabulary along with it.
        """
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
            logger.info("vocabulary normalised", extra={"rules": sorted(set(fired))})

        queries = subqueries or [query]

        # The goal itself is always searched first, and it is the gate.
        base = await self._retrieve_one(
            query,
            market=market,
            business_type=business_type,
            project_id=project_id,
            room_id=room_id,
        )

        if len(queries) == 1:
            return base

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
                extra={"subqueries": len(queries)},
            )
            return base

        results = [base]
        for sub in queries:
            if sub == query:
                continue
            results.append(
                await self._retrieve_one(
                    sub,
                    market=market,
                    business_type=business_type,
                    project_id=project_id,
                    room_id=room_id,
                )
            )

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

        logger.info(
            "decomposed retrieval",
            extra={
                "subqueries": len(queries),
                "kept": len(merged),
                "documents": len({c.document_id for c in merged}),
            },
        )
        return RetrievalResult(
            chunks=merged,
            candidates_considered=considered,
            dropped_below_threshold=dropped,
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
    ) -> RetrievalResult:
        """One query: embed, hybrid search, rerank, drop below threshold."""
        [query_vector] = await self._providers.embed([query])

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

        if not rows:
            logger.info("retrieval returned no candidates", extra={"query_len": len(query)})
            return RetrievalResult(chunks=[], candidates_considered=0, dropped_below_threshold=0)

        # Rerank against the contextualised text, which is what was embedded and
        # what actually carries the situating detail. Falling back to the raw
        # chunk keeps this working for documents ingested without contextualising.
        documents = [
            f"{row.get('context_prefix') or ''}\n{row['chunk_text']}".strip() for row in rows
        ]
        hits = await self._providers.rerank(query, documents, self._s.rerank_top_n)

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
                "candidates": len(rows),
                "kept": len(chunks),
                "dropped": dropped,
            },
        )
        return RetrievalResult(
            chunks=chunks,
            candidates_considered=len(rows),
            dropped_below_threshold=dropped,
            scored=tuple(scored),
        )
