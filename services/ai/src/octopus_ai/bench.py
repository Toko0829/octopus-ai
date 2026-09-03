"""Measure a planning turn's retrieval cost, so the settings are chosen rather than guessed.

    python -m octopus_ai.bench "<goal>" [--repeat 1] [--fanout 1 2 3]
        [--candidates 25 12] [--batch-size 0 8] [--no-decompose] [--out bench.json]

This exists because every latency number in `ai-orchestrator.md` was taken by
hand with a stopwatch, and one of them does not fit its own explanation: halving
`retrieval_candidates` from 25 to 12 gave 34.0s against 36.8s, far short of the
halving a compute-bound pass would show. That points at a FIXED per-pass cost
nobody has identified, and a fixed cost changes what `RERANK_FANOUT` is worth. If
most of a pass is fixed, concurrency wins; if it is all compute, dividing the
thread budget across concurrent passes buys nothing and the goal pass running
alone at divided threads makes it a loss. The arithmetic cannot settle it. This
can.

**Run it with the service stopped.** A second process holding both models beside
uvicorn is ~10 GB against an 8 GB floor:

    docker compose stop ai
    docker compose run --rm --no-deps -e TORCH_NUM_THREADS=16 ai \
        python -m octopus_ai.bench "launch my app and get me to my first 100 customers" \
        --fanout 1 2 3 --candidates 25 12 --batch-size 0 8

One `Providers` and one `Database` are shared across every configuration, so the
weights load once and every row after the first measures a warm model. The cold
first pass is measured separately as `cold_pass_ms`, before the warm-up, because
that is the number startup warming now removes from the first request.

Decomposition runs ONCE and its sub-queries are reused for every row. That is a
single cheap-tier OpenAI call for the whole benchmark, which keeps it inside the
"no paid APIs in development" constraint in cost as well as in spirit, and it
also makes the rows comparable: re-decomposing could return a different number of
sub-queries and silently change what is being timed.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import logging
import statistics
import time
from typing import Any

from .config import Settings, get_settings
from .db import Database
from .decompose import decompose
from .providers import Providers
from .retrieval import Retriever
from .runtime import configure_torch_threads

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("octopus.ai.bench")


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def _current_threads() -> int:
    """What torch is ACTUALLY set to right now, not what was asked for.

    Read back rather than recomputed, because the row has to report the number
    the pass ran on. `TORCH_NUM_THREADS` unset means torch's own default is the
    base, `thread_budget` then divides it, and integer division leaves cores idle
    at awkward ratios (16 // 3 is 5). Restating the intent here would print a
    figure nobody measured on.
    """
    try:
        import torch
    except ImportError:  # pragma: no cover - hosted providers never load torch
        return 0
    return int(torch.get_num_threads())


async def _cold_pass_ms(providers: Providers) -> int:
    """What the first rerank on a fresh process costs, model load included.

    Measured before anything warms the model, because it is the whole of what
    startup warming now moves off the first request. Reported in its own right
    rather than folded into a row: it happens once per process, and averaging it
    into a per-pass figure would libel every pass after it.
    """
    started = time.perf_counter()
    await providers.rerank("warmup", ["warmup"], 1)
    return int((time.perf_counter() - started) * 1000)


async def _run_config(
    base: Settings,
    db: Database,
    providers: Providers,
    *,
    goal: str,
    subqueries: list[str] | None,
    fanout: int,
    candidates: int,
    batch_size: int,
    repeat: int,
) -> dict[str, Any]:
    """One (fanout, candidates, batch_size) configuration, repeated and taken at the median."""
    settings = dataclasses.replace(
        base,
        rerank_fanout=fanout,
        retrieval_candidates=candidates,
        rerank_batch_size=batch_size,
    )
    # The thread budget is process-global, so it is reset for every row rather
    # than once at the top. That is also why the rows run sequentially: two
    # configurations in flight would share one thread count and neither would be
    # measuring what it claims to.
    configure_torch_threads(settings)

    # `Providers` holds its OWN reference to Settings, and `rerank_batch_size` is
    # read from that one rather than from the Retriever's. Rebuilding `Providers`
    # per row would reload the weights every time, so the row's settings are
    # pushed onto the existing one instead. Found by measuring: the first run of
    # this benchmark reported `batch_size=0` on every "local rerank pass" line
    # including the rows that asked for 8, so the batch-size columns were
    # measuring one configuration four times and agreeing with themselves.
    providers._s = settings  # noqa: SLF001
    # And the reranker was built with the PREVIOUS row's batch size and is cached
    # for the process, so the wrapper is dropped. The weights stay in the OS page
    # cache, which is what keeps re-loading it cheap.
    providers._local_reranker = None  # noqa: SLF001

    walls: list[float] = []
    base_walls: list[float] = []
    pass_walls: list[float] = []
    rerank_sums: list[float] = []
    embed_sums: list[float] = []
    search_sums: list[float] = []
    padding: list[float] = []
    passes = 0
    top_score = 0.0

    for _ in range(repeat):
        retriever = Retriever(settings, db, providers)
        result = await retriever.retrieve(goal, subqueries=subqueries)
        timings = result.timings
        passes = len(timings)
        walls.append(result.wall_ms / 1000)
        if timings:
            base_walls.append(
                (timings[0].embed_ms + timings[0].search_ms + timings[0].rerank_ms) / 1000
            )
            pass_walls.extend((t.embed_ms + t.search_ms + t.rerank_ms) / 1000 for t in timings)
        rerank_sums.append(sum(t.rerank_ms for t in timings) / 1000)
        embed_sums.append(sum(t.embed_ms for t in timings) / 1000)
        search_sums.append(sum(t.search_ms for t in timings) / 1000)
        stats = getattr(providers._local_reranker, "last_stats", {})  # noqa: SLF001
        if stats:
            padding.append(float(stats.get("padding_ratio") or 0.0))
        # The best score anything earned, which is what the batch-size comparison
        # checks for drift. Taken from `scored` rather than `chunks` so a
        # configuration that keeps nothing still reports a number.
        if result.scored:
            top_score = max(c.rerank_score for c in result.scored)

    median_wall = _median(walls)
    median_base = _median(base_walls)
    return {
        "fanout": fanout,
        "threads": _current_threads(),
        "candidates": candidates,
        "batch_size": batch_size,
        "passes": passes,
        "wall_s": round(median_wall, 1),
        "base_s": round(median_base, 1),
        "subs_wall_s": round(max(median_wall - median_base, 0.0), 1),
        "mean_pass_s": round(_median(pass_walls), 1),
        "rerank_sum_s": round(_median(rerank_sums), 1),
        "embed_sum_s": round(_median(embed_sums), 2),
        "search_sum_s": round(_median(search_sums), 2),
        "padding_ratio": round(_median(padding), 4),
        "top_score": top_score,
    }


_COLUMNS = (
    ("fanout", 6),
    ("threads", 7),
    ("candidates", 10),
    ("batch_size", 10),
    ("passes", 6),
    ("wall_s", 8),
    ("base_s", 8),
    ("subs_wall_s", 11),
    ("mean_pass_s", 11),
    ("rerank_sum_s", 12),
    ("embed_sum_s", 11),
    ("search_sum_s", 12),
    ("padding_ratio", 13),
)


def _print_table(rows: list[dict[str, Any]]) -> None:
    print()
    print("  ".join(name.rjust(width) for name, width in _COLUMNS))
    for row in rows:
        print("  ".join(str(row[name]).rjust(width) for name, width in _COLUMNS))


def _print_derived(rows: list[dict[str, Any]]) -> None:
    """The two questions the table alone does not answer.

    First: how much of a pass is fixed cost. Two candidate depths at fanout 1 give
    a line through two points, and its intercept is the part that does not scale
    with work. That is the number deciding whether concurrency can win at all, and
    the recorded 34.0-against-36.8 anomaly implies it exists without saying how
    large it is.

    Second: whether batching moved any score. It must not, beyond float noise,
    because the attention mask already excludes padding. A larger drift means the
    batching is wrong, and then no speed figure in the table is worth having.
    """
    print()
    first_batch = rows[0]["batch_size"] if rows else 0
    at_fanout_one = [r for r in rows if r["fanout"] == 1 and r["batch_size"] == first_batch]
    by_candidates = {r["candidates"]: r["mean_pass_s"] for r in at_fanout_one}
    if len(by_candidates) >= 2:
        high, low = max(by_candidates), min(by_candidates)
        per_candidate = (by_candidates[high] - by_candidates[low]) / (high - low)
        fixed = by_candidates[low] - low * per_candidate
        share = fixed / by_candidates[high] if by_candidates[high] else 0.0
        print(
            f"fixed-vs-per-candidate (fanout 1, {low} and {high} candidates): "
            f"{per_candidate:.2f}s per candidate, {fixed:.1f}s fixed "
            f"({share:.0%} of a {high}-candidate pass)"
        )
        print(
            "  A large fixed share is what makes concurrency win; a small one means "
            "dividing the thread budget across passes buys nothing."
        )
    else:
        print("fixed-vs-per-candidate: needs two --candidates values at fanout 1")

    scores = [r["top_score"] for r in rows if r["top_score"]]
    if len(scores) >= 2:
        print(
            f"max top-score drift across all rows: {max(scores) - min(scores):.2e} "
            "(batching must be float noise, ~1e-6; anything larger is a defect)"
        )
    else:
        print("score drift: needs at least two rows that retrieved something")


async def _run(args: argparse.Namespace) -> int:
    settings = get_settings()
    db = Database(settings)
    providers = Providers(settings)

    try:
        # Before any warm-up, deliberately: this is the cost startup warming now
        # takes off the first request, and it can only be measured once.
        configure_torch_threads(settings)
        cold_ms = await _cold_pass_ms(providers)
        print(f"cold_pass_ms: {cold_ms}  (model load plus one forward pass over a single pair)")

        subqueries: list[str] | None = None
        if not args.no_decompose:
            subqueries = await decompose(args.goal, providers, settings.generation_model_cheap)
            print(f"sub-queries ({len(subqueries)}): {subqueries}")

        rows: list[dict[str, Any]] = []
        for batch_size in args.batch_size:
            for candidates in args.candidates:
                for fanout in args.fanout:
                    row = await _run_config(
                        settings,
                        db,
                        providers,
                        goal=args.goal,
                        subqueries=subqueries,
                        fanout=fanout,
                        candidates=candidates,
                        batch_size=batch_size,
                        repeat=args.repeat,
                    )
                    rows.append(row)
                    print(
                        f"  done fanout={fanout} candidates={candidates} "
                        f"batch={batch_size}: {row['wall_s']}s"
                    )

        _print_table(rows)
        _print_derived(rows)

        if args.out:
            with open(args.out, "w", encoding="utf-8") as handle:
                json.dump(
                    {"goal": args.goal, "cold_pass_ms": cold_ms, "rows": rows}, handle, indent=2
                )
            print(f"\nwrote {args.out}")
        return 0
    finally:
        await db.aclose()
        await providers.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m octopus_ai.bench",
        description="Measure retrieval latency across fan-out, candidate depth and batch size.",
    )
    parser.add_argument("goal", help="the goal to plan, as a user would phrase it")
    parser.add_argument("--repeat", type=int, default=1, help="runs per configuration (median)")
    parser.add_argument("--fanout", type=int, nargs="+", default=[1])
    parser.add_argument("--candidates", type=int, nargs="+", default=[25])
    parser.add_argument("--batch-size", type=int, nargs="+", default=[0], dest="batch_size")
    parser.add_argument(
        "--no-decompose",
        action="store_true",
        help="time the goal pass alone, with no OpenAI call at all",
    )
    parser.add_argument("--out", default="", help="write the rows to this JSON file")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")
    if any(f < 1 for f in args.fanout):
        parser.error("--fanout values must be at least 1")
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
