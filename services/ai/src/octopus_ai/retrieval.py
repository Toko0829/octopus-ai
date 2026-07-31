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
    ) -> RetrievalResult:
        [query_vector] = await self._providers.embed([query])

        rows = await self._db.hybrid_search(
            embedding=query_vector,
            query=query,
            market=market,
            business_type=business_type,
            candidates=self._s.retrieval_candidates,
            limit=self._s.retrieval_candidates,
            project_id=project_id,
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
            if hit.score < self._s.rerank_min_score:
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
