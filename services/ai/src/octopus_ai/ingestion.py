"""Ingestion: chunk, contextualise, embed, index.

The steps rag.md specifies, minus the crawlers (which arrive with real sources).
Two choices worth stating outright:

**Structure-first chunking.** Splitting on headings and paragraph boundaries
before falling back to size keeps a chunk about one thing. Fixed-width splitting
is faster to write and reliably cuts a rule in half, which is the failure that
produces a confident half-answer.

**Contextualised embedding** (Anthropic's technique). Each chunk is embedded
together with a short blurb situating it in its document, so a chunk that says
"this must be disclosed" still retrieves for "FTC disclosure rules" instead of
being stranded without its subject. The raw chunk is kept separately for display.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass

from .config import Settings
from .db import Database, to_pgvector
from .providers import Providers

logger = logging.getLogger("octopus.ai.ingestion")

# Chunk sizing in characters. rag.md targets ~512 tokens; at roughly 4 characters
# per token that is ~2000 characters. A heuristic is used rather than a tokeniser
# to keep the service dependency-light and CI hermetic (no BPE download at test
# time). tiktoken is the precise upgrade if chunk boundaries ever start mattering
# more than ingestion simplicity.
TARGET_CHARS = 2000
MIN_CHARS = 320
OVERLAP_CHARS = 180

_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+\S", re.MULTILINE)


# Bump when chunking behaviour changes. Change detection otherwise compares only
# the source text, so a document whose bytes are identical would keep its chunks
# from the previous algorithm forever: the index silently drifts from the code
# that built it. Folding this into the hash makes a chunker change force a
# re-ingest, which is the honest outcome.
CHUNKER_VERSION = "2"


def content_hash(text: str, embed_model: str = "") -> str:
    """Stable hash for change detection, so unchanged documents are never re-embedded.

    Covers the chunking pipeline and **the embedding model**, not just the text.

    The embedding model belongs here for the same reason CHUNKER_VERSION does,
    and the consequence of omitting it is worse. Switching embedder leaves the
    source bytes identical, so every document would be skipped as unchanged: the
    corpus keeps vectors from the old model while new rows claim the new one, and
    query vectors from the new model then get compared against old ones inside
    the same HNSW index. Nothing errors. Retrieval just quietly degrades, which
    on a system whose whole promise is grounded, cited answers is the worst
    available failure. rag.md is explicit that one model must cover the whole
    corpus; this is what makes that enforceable rather than aspirational.
    """
    payload = f"{CHUNKER_VERSION}\x00{embed_model}\x00{text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _split_sections(text: str) -> list[str]:
    """Split on markdown headings, keeping each heading with its body."""
    starts = [m.start() for m in _HEADING.finditer(text)]
    if not starts:
        # Strip here too. Without it a whitespace-only document survives as a
        # truthy section and gets indexed as an empty chunk.
        return [text.strip()]
    if starts[0] != 0:
        starts.insert(0, 0)
    bounds = starts + [len(text)]
    return [text[bounds[i] : bounds[i + 1]].strip() for i in range(len(bounds) - 1)]


def _split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def chunk_document(text: str) -> list[str]:
    """Structure-first chunking with a small overlap between adjacent chunks.

    The overlap exists so a sentence spanning a boundary is still wholly present
    in one of the two chunks.
    """
    chunks: list[str] = []

    for section in _split_sections(text):
        if len(section) <= TARGET_CHARS:
            if section:
                chunks.append(section)
            continue

        buffer = ""
        for para in _split_paragraphs(section):
            # A single oversized paragraph still has to be cut somewhere; do it
            # on sentence boundaries rather than mid-word.
            if len(para) > TARGET_CHARS:
                if buffer:
                    chunks.append(buffer.strip())
                    buffer = ""
                for sentence in re.split(r"(?<=[.!?])\s+", para):
                    if len(buffer) + len(sentence) + 1 > TARGET_CHARS and buffer:
                        chunks.append(buffer.strip())
                        buffer = buffer[-OVERLAP_CHARS:] if len(buffer) > OVERLAP_CHARS else ""
                    buffer += (" " if buffer else "") + sentence
                continue

            if len(buffer) + len(para) + 2 > TARGET_CHARS and buffer:
                chunks.append(buffer.strip())
                buffer = buffer[-OVERLAP_CHARS:] if len(buffer) > OVERLAP_CHARS else ""
            buffer += ("\n\n" if buffer else "") + para

        if buffer.strip():
            chunks.append(buffer.strip())

    # Fold stub fragments into a neighbour rather than indexing something that
    # will never be the best match for anything. A bare heading left behind by a
    # paragraph split is the common case.
    #
    # Folds backward by default, but a short FIRST chunk has no predecessor and
    # must fold forward instead, or it survives as a two-word chunk.
    merged: list[str] = []
    for chunk in chunks:
        if not chunk:
            continue
        if merged and len(chunk) < MIN_CHARS:
            merged[-1] = f"{merged[-1]}\n\n{chunk}"
        else:
            merged.append(chunk)

    while len(merged) > 1 and len(merged[0]) < MIN_CHARS:
        merged[1] = f"{merged[0]}\n\n{merged[1]}"
        merged.pop(0)

    return merged


def deterministic_context(title: str, market: str | None, doc_type: str | None) -> str:
    """Situating prefix built from metadata, with no model call.

    Used when contextualisation is disabled. Weaker than a generated blurb but
    free, deterministic, and enough to keep a chunk attached to its subject.
    """
    parts = [f"From: {title}"]
    if market:
        parts.append(f"Market: {market}")
    if doc_type:
        parts.append(f"Type: {doc_type}")
    return " · ".join(parts)


@dataclass(frozen=True)
class IngestResult:
    document_id: str
    chunks_written: int
    skipped_unchanged: bool
    # Whether this closed an earlier version of the same titled document. Default
    # False so the seed path and its tests are unchanged by the addition.
    superseded: bool = False


class Ingestor:
    def __init__(self, settings: Settings, db: Database, providers: Providers) -> None:
        self._s = settings
        self._db = db
        self._providers = providers

    async def ingest(
        self,
        *,
        text: str,
        title: str,
        source_label: str,
        authority: str = "vendor",
        source_url: str | None = None,
        market: str | None = None,
        business_type: str | None = None,
        doc_type: str | None = None,
        effective_date: str | None = None,
        lang: str = "english",
        owner_room_id: str | None = None,
    ) -> IngestResult:
        source_id = await self._db.upsert_source(
            label=source_label, authority=authority, url=source_url
        )

        digest = content_hash(text, self._s.active_embed_model)
        current = await self._db.find_current_version(source_id, title)

        if current and current["content_hash"] == digest:
            # Same bytes, same chunker, and same embedding model as last time:
            # re-embedding would cost money and change nothing.
            logger.info("document unchanged, skipping", extra={"title": title})
            return IngestResult(
                document_id=current["id"], chunks_written=0, skipped_unchanged=True
            )

        version = 1
        superseded = False
        if current:
            superseded = True
            # Changed. Close the old version's validity window BEFORE inserting
            # the new one. Skipping this is how a corpus ends up serving two
            # copies of the same document and reranking them against each other.
            await self._db.supersede_document(current["id"])
            version = int(current["version"]) + 1
            logger.info("superseding document", extra={"title": title, "new_version": version})

        document_id = await self._db.insert_document(
            {
                "source_id": source_id,
                "title": title,
                "market": market,
                "business_type": business_type,
                "doc_type": doc_type,
                "lang": lang,
                "effective_date": effective_date,
                "content_hash": digest,
                "version": version,
                # Which workspace this belongs to, or None for the shared corpus.
                # The chunk rows below deliberately do NOT carry it: the
                # `doc_chunks_owner_sync` trigger copies it down, so a chunk can
                # never disagree with its document about who owns it.
                "owner_room_id": owner_room_id,
            }
        )

        pieces = chunk_document(text)
        if not pieces:
            return IngestResult(
                document_id=document_id,
                chunks_written=0,
                skipped_unchanged=False,
                superseded=superseded,
            )

        prefix = deterministic_context(title, market, doc_type)

        # Embed the contextualised text; store the raw chunk for display.
        vectors = await self._providers.embed([f"{prefix}\n\n{piece}" for piece in pieces])

        rows = [
            {
                "document_id": document_id,
                "chunk_index": i,
                "chunk_text": piece,
                "context_prefix": prefix,
                "embedding": to_pgvector(vector),
                "embed_model": self._s.active_embed_model,
                "embedded_at": "now()",
                "lang": lang,
            }
            for i, (piece, vector) in enumerate(zip(pieces, vectors, strict=True))
        ]

        written = await self._db.replace_chunks(document_id, rows)
        logger.info("ingested", extra={"title": title, "chunks": written})
        return IngestResult(
            document_id=document_id,
            chunks_written=written,
            skipped_unchanged=False,
            superseded=superseded,
        )

    async def ingest_many(self, documents: list[dict]) -> list[IngestResult]:
        """Ingest sequentially.

        Deliberately not parallel: embedding is the rate-limited call, and firing
        every document at once is the fastest way to a 429 storm. Concurrency
        belongs at the job scheduler, where it can be tuned against real limits.
        """
        results = []
        for doc in documents:
            results.append(await self.ingest(**doc))
            await asyncio.sleep(0)
        return results
