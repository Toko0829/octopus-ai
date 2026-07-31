"""Ingest the seed corpus, then optionally probe retrieval.

    uv run --directory services/ai python -m octopus_ai.seed
    uv run --directory services/ai python -m octopus_ai.seed "how do I lower CPA"

Re-running is cheap and safe: documents whose content hash is unchanged are
skipped without re-embedding.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from .config import get_settings
from .corpus import load_corpus
from .db import Database
from .ingestion import Ingestor
from .providers import Providers
from .retrieval import Retriever

logging.basicConfig(level=logging.INFO, format="%(message)s")


async def _run(probe: str | None) -> int:
    settings = get_settings()
    db = Database(settings)
    providers = Providers(settings)

    try:
        documents = load_corpus()
        if not documents:
            print("no corpus documents found")
            return 1

        print(f"ingesting {len(documents)} documents")
        results = await Ingestor(settings, db, providers).ingest_many(
            [d.as_ingest_kwargs() for d in documents]
        )

        written = sum(r.chunks_written for r in results)
        skipped = sum(1 for r in results if r.skipped_unchanged)
        print(f"  {written} chunks written, {skipped} documents unchanged")

        if not probe:
            return 0

        print(f"\nretrieving: {probe!r}")
        result = await Retriever(settings, db, providers).retrieve(probe)
        print(
            f"  {result.candidates_considered} candidates -> "
            f"{len(result.chunks)} kept, {result.dropped_below_threshold} below threshold"
        )
        for i, chunk in enumerate(result.chunks, 1):
            preview = " ".join(chunk.text.split())[:110]
            print(f"  {i}. [{chunk.rerank_score:.3f}] {chunk.title}")
            print(f"     {preview}...")
        return 0
    finally:
        await db.aclose()
        await providers.aclose()


def main() -> None:
    probe = sys.argv[1] if len(sys.argv) > 1 else None
    raise SystemExit(asyncio.run(_run(probe)))


if __name__ == "__main__":
    main()
