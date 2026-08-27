"""Retrieval: hybrid search, then cross-encoder rerank, then a hard threshold.

The pipeline from rag.md, in order:

    query -> embed -> [dense + sparse, fused with RRF in Postgres] -> rerank -> drop weak

The last step is the one that is easy to skip and expensive to skip. A relevance
threshold DROPS weak chunks rather than padding the context window with them:
handing a model six loosely related paragraphs is how confident, wrong,
"grounded" answers get produced.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .config import Settings
from .db import Database
from .providers import Providers

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
class RetrievalResult:
    chunks: list[RetrievedChunk]
    candidates_considered: int
    dropped_below_threshold: int

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
        Candidate breadth was never the bottleneck: `retrieval_candidates` is 40
        against a corpus of ~43 chunks, so one search already returns nearly
        everything and a union has nothing to add. The bottleneck is the rerank,
        where a broad goal scores uniformly badly against specific chunks (top
        0.066, against 0.474 for a focused query), so almost nothing clears the
        threshold and the planner is left with material for two or three stages.

        Scoring "how do I price my offer" against the pricing chunks is a
        question the cross-encoder can answer well. Scoring "get my first 100
        customers" against them is not. Hence one rerank per sub-query.
        """
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
        dropped = 0
        for hit in hits:
            if hit.score < self._s.active_rerank_min_score:
                dropped += 1
                continue
            row = rows[hit.index]
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
        )
