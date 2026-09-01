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


def configure_torch_threads(settings: Settings) -> None:
    """Give torch the whole box when a local model is doing the work.

    Imported lazily and skipped entirely when neither provider is local, because
    `local_embedder` and `local_reranker` are kept out of the import graph on
    purpose so a deployment using hosted providers never pays for torch.

    Torch defaults to the physical core count, while a container is normally
    given the logical one, so the service was using half the machine on a number
    nobody had chosen. Reranking is the dominant cost in a planning turn and it is
    pure CPU, so that halving showed up directly in what a person waits for.

    Safe to call more than once and safe to call from a CLI: with
    `TORCH_NUM_THREADS` unset the budget is 0, which means "leave torch alone",
    so nothing changes for a caller that has not opted in.
    """
    if settings.embed_provider != "local" and settings.rerank_provider != "local":
        return
    if settings.torch_num_threads <= 0:
        return

    import torch

    torch.set_num_threads(settings.torch_num_threads)
    logger.info(
        "torch thread budget set",
        extra={"threads": torch.get_num_threads(), "cpu_count": os.cpu_count()},
    )
