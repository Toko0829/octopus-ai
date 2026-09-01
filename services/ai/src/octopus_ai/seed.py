"""Ingest the seed corpus, then optionally probe retrieval.

    uv run --directory services/ai python -m octopus_ai.seed
    uv run --directory services/ai python -m octopus_ai.seed "how do I lower CPA"

Re-running is cheap and safe: documents whose content hash is unchanged are
skipped without re-embedding.

Two directories, one pass. `corpus/` is the internal playbook set; `eval/external/`
is the checked-in snapshots of crawled pages, which are seeded here so a laptop
and a CI runner hold the same corpus the golden set was scored against. In
production those documents arrive from the crawl sweep instead, and the ingestion
path is identical either way, which is what makes seeding them here honest rather
than a fixture that flatters the eval.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from .config import get_settings
from .corpus import EXTERNAL_DIR, load_corpus
from .db import Database
from .ingestion import Ingestor
from .providers import Providers
from .retrieval import Retriever
from .runtime import configure_torch_threads

logging.basicConfig(level=logging.INFO, format="%(message)s")


async def _run(probe: str | None) -> int:
    settings = get_settings()
    # Embedding the corpus is local model work, so it takes the same thread
    # budget the service does rather than torch's default.
    configure_torch_threads(settings)
    db = Database(settings)
    providers = Providers(settings)

    try:
        internal = load_corpus()
        if not internal:
            print("no corpus documents found")
            return 1

        external = load_corpus(EXTERNAL_DIR)
        documents = internal + external

        print(f"ingesting {len(documents)} documents ({len(external)} externally sourced)")
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
