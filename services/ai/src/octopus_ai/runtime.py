"""Process-level setup that every entry point needs, not just the HTTP service.

This module exists because `configure_torch_threads` lived in `main.py` and was
therefore called from exactly one place: the FastAPI lifespan. Everything else
that runs the local models, which is the eval harness, `octopus_ai.seed` and
`tools/rag-lens/probe.py`, ran torch on its own default and ignored
`TORCH_NUM_THREADS` entirely.

That is the same defect the service already had and already fixed, surviving in
the entry points nobody thought of as a deployment. It matters most in the eval,
which is the single most CPU-bound thing in the repository: reranking is N forward
passes per query, an eval run is dozens of queries, and `infra-devops.md` records
CI shard timeouts being raised to 40 minutes because of it. The CI job runs
`python -m octopus_ai.evaluation` directly rather than the container, so the
budget `docker-compose.yml` sets never reached the gate at all.

It is a separate module rather than staying in `main.py` because importing it from
the eval would drag FastAPI and the whole application graph into a CLI that needs
neither.
"""

from __future__ import annotations

import logging
import os

from .config import Settings

logger = logging.getLogger("octopus.ai.runtime")


def thread_budget(torch_num_threads: int, fanout: int, torch_default: int) -> int:
    """How many threads ONE rerank pass may use, given how many run at once.

    Pure and separated from the torch call so it can be tested without importing
    torch, which CI's `ai` job cannot do: it installs the `dev` extra only.

    `torch_num_threads <= 0` means "the caller did not choose", so torch's own
    default stands in as the base. It is passed in rather than read here for the
    same reason: this function must not import torch. Dividing torch's default
    rather than skipping matters, because otherwise `TORCH_NUM_THREADS` unset plus
    `RERANK_FANOUT=3` would run three passes each claiming the whole default and
    oversubscribe the box, which is slower than either setting alone.

    Never returns 0: `16 // 24` is 0 and a pass with no threads is not a pass.
    Integer division also leaves cores idle at awkward ratios (`16 // 3 == 5`
    wastes one), which is a real cost of an odd fan-out and is why the bench
    prints the per-row thread count rather than only the fan-out.
    """
    base = torch_num_threads if torch_num_threads > 0 else torch_default
    return max(1, base // max(1, fanout))


def configure_torch_threads(settings: Settings) -> None:
    """Give torch the whole box when a local model is doing the work, divided by fan-out.

    Imported lazily and skipped entirely when neither provider is local, because
    `local_embedder` and `local_reranker` are kept out of the import graph on
    purpose so a deployment using hosted providers never pays for torch.

    Torch defaults to the physical core count, while a container is normally
    given the logical one, so the service was using half the machine on a number
    nobody had chosen. Reranking is the dominant cost in a planning turn and it is
    pure CPU, so that halving showed up directly in what a person waits for.

    **The budget is divided at configure time rather than per pass**, because
    `torch.set_num_threads` is PROCESS-global while an OpenMP team is per calling
    thread: K passes handed to `asyncio.to_thread` each spin up their own team at
    the configured count, so K teams at `budget // K` sum back to the budget.
    There is no per-pass knob to set instead, which is what makes this the only
    place the division can happen.

    `set_num_interop_threads` is deliberately NOT called. It raises once the
    interop pool has started, and this function is called repeatedly across entry
    points (the service lifespan, the eval, the seeder, the probe, the bench), so
    calling it would turn a second call in one process into a crash. The intra-op
    count is the one that governs a forward pass anyway.

    Safe to call more than once and safe to call from a CLI: with
    `TORCH_NUM_THREADS` unset and no fan-out configured the budget is 0, which
    means "leave torch alone", so nothing changes for a caller that has not opted
    in.
    """
    if settings.embed_provider != "local" and settings.rerank_provider != "local":
        return
    # A fan-out with no explicit budget still has to divide something, or the
    # concurrent passes oversubscribe. That is the one case where this function
    # touches torch without `TORCH_NUM_THREADS` being set.
    if settings.torch_num_threads <= 0 and settings.rerank_fanout <= 1:
        return

    import torch

    budget = thread_budget(
        settings.torch_num_threads, settings.rerank_fanout, torch.get_num_threads()
    )
    torch.set_num_threads(budget)
    logger.info(
        "torch thread budget set",
        extra={
            "threads": torch.get_num_threads(),
            "budget": budget,
            "fanout": settings.rerank_fanout,
            "cpu_count": os.cpu_count(),
        },
    )
