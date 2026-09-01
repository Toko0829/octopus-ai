"""Run the real retrieval pipeline over some queries and write a trace file.

    uv run --directory services/ai python ../../tools/rag-lens/probe.py \
        --out ../../rag-trace.json "how do I lower my CPA on facebook"

    uv run --directory services/ai python ../../tools/rag-lens/probe.py \
        --out ../../rag-trace.json --from-golden scope --gate

The other two `rag-lens` views read files that already exist. This one cannot:
a score against a threshold only exists once something has actually been embedded
and reranked, so this needs the AI service's environment, the model weights and a
database. Run it from `services/ai` and hand the output to `rag_lens.py --trace`.

**It runs the production path and nothing else.** No re-implementation of
retrieval lives here: it calls `Retriever.retrieve`, the same decomposer the
service uses, and `build_sources_block` for the gate, because a picture of a
pipeline nobody runs is worse than no picture. That is a mistake this repo's eval
has made before and the reason it is written down.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from octopus_ai.config import get_settings
from octopus_ai.db import Database
from octopus_ai.decompose import decompose
from octopus_ai.providers import Providers
from octopus_ai.retrieval import Retriever
from octopus_ai.runtime import configure_torch_threads

GOLDEN = Path(__file__).resolve().parents[2] / "services" / "ai" / "eval" / "golden.json"


def _golden_queries(which: str) -> list[str]:
    raw = json.loads(GOLDEN.read_text(encoding="utf-8"))
    positives = [c["query"] for c in raw.get("cases", []) if c.get("expect_docs")]
    negatives = [c["query"] for c in raw.get("cases", []) if not c.get("expect_docs")]
    scope = [c["query"] for c in raw.get("scope_negatives", [])]
    return {
        "positives": positives,
        "negatives": negatives,
        "scope": scope,
        "all": positives + negatives + scope,
    }[which]


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    # Runs the production path, which includes the production thread budget.
    configure_torch_threads(settings)
    db = Database(settings)
    providers = Providers(settings)

    queries = list(args.queries)
    if args.from_golden:
        queries += _golden_queries(args.from_golden)
    if not queries:
        print("nothing to probe: pass a query or --from-golden", file=sys.stderr)
        return 2

    retriever = Retriever(settings, db, providers)
    probes = []

    try:
        for i, query in enumerate(queries, 1):
            subqueries: list[str] = []
            if settings.query_decomposition:
                subqueries = await decompose(query, providers)

            result = await retriever.retrieve(query, subqueries=subqueries or None)

            gate = None
            if args.gate and result.chunks:
                from octopus_ai.groundedness import assess
                from octopus_ai.planner import build_sources_block

                verdict = await assess(
                    query,
                    build_sources_block(result),
                    providers,
                    settings.active_groundedness_model,
                )
                gate = {"outcome": verdict.outcome, "reason": verdict.reason}

            probes.append(
                {
                    "query": query,
                    "subqueries": subqueries,
                    "threshold": settings.active_rerank_min_score,
                    "kept": len(result.chunks),
                    "dropped": result.dropped_below_threshold,
                    "gate": gate,
                    "scored": [
                        {
                            "query": c.query,
                            "chunk_id": c.chunk_id,
                            "title": c.title,
                            "rerank_score": c.rerank_score,
                            "rrf_score": c.rrf_score,
                            "kept": c.kept,
                        }
                        for c in result.scored
                    ],
                }
            )
            top = max((c.rerank_score for c in result.scored), default=0.0)
            ratio = top / settings.active_rerank_min_score if settings.active_rerank_min_score else 0
            print(
                f"[{i}/{len(queries)}] {query[:58]:58} "
                f"{len(result.chunks):2} kept  top {top:.4g} ({ratio:.2f}x)"
            )
    finally:
        await db.aclose()
        await providers.aclose()

    payload = {
        "settings": {
            "embed_model": settings.active_embed_model,
            "rerank_model": settings.active_rerank_model,
            "rerank_min_score": settings.active_rerank_min_score,
            "decomposition": settings.query_decomposition,
            "candidates": settings.retrieval_candidates,
        },
        "probes": probes,
    }
    out = Path(args.out)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"\nwrote {out} ({len(probes)} probes)")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="rag-lens probe", description=__doc__)
    parser.add_argument("queries", nargs="*", help="queries to probe")
    parser.add_argument("--out", default="rag-trace.json", help="output JSON path")
    parser.add_argument(
        "--from-golden",
        choices=["positives", "negatives", "scope", "all"],
        help="also probe queries from the golden set. `scope` is the sharpest set for "
        "margins: in-vocabulary questions the corpus does not cover.",
    )
    parser.add_argument(
        "--gate",
        action="store_true",
        help="also run the groundedness gate on each probe. Costs a model call per "
        "probe and needs credentials, so it is off by default.",
    )
    raise SystemExit(asyncio.run(_run(parser.parse_args())))


if __name__ == "__main__":
    main()
