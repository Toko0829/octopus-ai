"""In-process BGE-reranker-v2-m3 cross-encoder.

The counterpart to `local_embedder.py`, and kept separate for the same reason:
FlagEmbedding pulls torch, so nothing imports this unless `RERANK_PROVIDER=local`
is actually selected. No new dependency is involved either way, because
FlagEmbedding already ships `FlagReranker` alongside the `BGEM3FlagModel` the
embedder uses.

**The scores are NOT interchangeable with Cohere's, and that is the whole risk.**
`rerank_min_score` is calibrated against Cohere's distribution (0.05 separates
relevant from off-topic there). This model returns raw logits by default: real
numbers, frequently negative, on no fixed scale. Passing `normalize=True` maps
them through a sigmoid into 0-1, which makes them *look* comparable while still
being differently distributed, since a logit near 0 becomes ~0.5 rather than
~0.0. Reusing Cohere's threshold either lets everything through or refuses
everything, and the first of those is a grounding failure rather than a quality
one: the agent would cite sources that do not support the answer.

So a provider switch REQUIRES recalibrating `rerank_min_score` against the golden
set, exactly as ADR-0008 required re-embedding the corpus. The threshold is
therefore configured per provider rather than shared.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger("octopus.ai.local_reranker")

# Query + passage share this budget. Chunks are sized to ~512 tokens upstream
# (ingestion.TARGET_CHARS) and the contextual prefix is prepended before
# reranking, so 512 would truncate the passage on longer chunks and silently
# score a fragment. The model is trained at 512 but accepts more; 1024 matches
# what the embedder already allows.
MAX_LENGTH = 1024


class LocalRerankerError(RuntimeError):
    """The local reranker could not be loaded or produced an unusable result."""


# ---------------------------------------------------------------------------
# Batching. Torch-free on purpose: this module already imports torch only inside
# `_load`, and CI's `ai` job installs the `dev` extra only, so anything a test
# needs to reach has to live above that line.
# ---------------------------------------------------------------------------


def plan_batches(lengths: list[int], batch_size: int) -> list[list[int]]:
    """Group pair indices into forward passes, longest first.

    The cost this exists for is padding. `tokenizer.pad` pads every pair in a
    batch to the LONGEST pair in that batch, and the model then computes
    attention over the padding it just added. One 900-token chunk among 25
    ~600-token ones therefore makes all 25 cost 900. Sorting by length means a
    long pair is batched with other long pairs and the short ones are computed at
    their own size.

    **Descending rather than ascending**, so the largest batch runs first. Peak
    memory is reached in the first pass either way; hitting it immediately makes
    an out-of-memory failure happen at the start of a request rather than
    three-quarters of the way through one.

    `batch_size <= 0` yields a single batch, which is the pre-existing behaviour
    with one difference that costs nothing: the pairs are in sorted order inside
    it. Padding is unchanged there, since one batch pads to the global maximum
    whatever the order, and `restore_order` puts the scores back regardless.
    """
    order = sorted(range(len(lengths)), key=lambda i: lengths[i], reverse=True)
    if batch_size <= 0:
        return [order] if order else []
    return [order[start : start + batch_size] for start in range(0, len(order), batch_size)]


def restore_order(
    plan: list[list[int]], batched_scores: list[list[float]], n: int
) -> list[float]:
    """Scatter batched scores back into the caller's input order.

    The caller passed documents in one order and gets scores in that same order;
    the reordering is an implementation detail of how the forward passes were
    packed. Getting this wrong would attach every score to the wrong chunk while
    still returning the right COUNT, which the threshold would happily filter and
    nothing downstream could detect, so the count mismatch is raised rather than
    tolerated.
    """
    if len(plan) != len(batched_scores):
        raise LocalRerankerError(
            f"local reranker produced {len(batched_scores)} batches for {len(plan)} planned"
        )
    scores: list[float | None] = [None] * n
    for batch, batch_scores in zip(plan, batched_scores, strict=True):
        if len(batch) != len(batch_scores):
            raise LocalRerankerError(
                f"local reranker returned {len(batch_scores)} scores for {len(batch)} pairs"
            )
        for index, score in zip(batch, batch_scores, strict=True):
            scores[index] = score
    if any(score is None for score in scores):
        raise LocalRerankerError(
            f"local reranker left {sum(s is None for s in scores)} of {n} documents unscored"
        )
    return [float(s) for s in scores]  # type: ignore[arg-type]


def padding_stats(lengths: list[int], plan: list[list[int]]) -> dict[str, Any]:
    """What the batching actually bought, in tokens.

    `padding_ratio` is the share of computed tokens that were padding. It is the
    number worth watching after a corpus change: a ratio that climbs means chunk
    lengths have spread out, and a wider spread is exactly what batching pays
    for.
    """
    if not lengths:
        return {
            "pairs": 0,
            "batches": 0,
            "max_tokens": 0,
            "total_tokens": 0,
            "padded_tokens": 0,
            "padding_ratio": 0.0,
        }
    padded = sum(len(batch) * max(lengths[i] for i in batch) for batch in plan if batch)
    total = sum(lengths)
    return {
        "pairs": len(lengths),
        "batches": len([b for b in plan if b]),
        "max_tokens": max(lengths),
        "total_tokens": total,
        "padded_tokens": padded,
        "padding_ratio": round((padded - total) / padded, 4) if padded else 0.0,
    }


class LocalReranker:
    """Lazily-loaded BGE cross-encoder.

    Loaded once per process behind a lock, for the same reason as the embedder:
    two concurrent requests must not each build their own multi-GB copy. Scoring
    is blocking CPU work, so callers hand it to a worker thread rather than await
    it on the event loop.
    """

    def __init__(
        self,
        model_name: str,
        *,
        use_fp16: bool,
        normalize: bool = True,
        batch_size: int = 0,
    ) -> None:
        self._model_name = model_name
        self._use_fp16 = use_fp16
        # Sigmoid-squashed to 0-1. Not because that makes it comparable to Cohere
        # (it does not), but because a bounded score is something a threshold can
        # be reasoned about and logged against at all.
        self._normalize = normalize
        # 0 means one forward pass over every pair, which is what this class did
        # before batching existed. See `plan_batches`.
        self._batch_size = batch_size
        self._model: Any | None = None
        self._lock = threading.Lock()
        # What the last pass cost. Written for the log line and read by
        # `octopus_ai.bench`; nothing in the request path depends on it, and it is
        # deliberately last-write-wins rather than accumulated, because a running
        # total across concurrent passes would describe no pass that happened.
        self.last_stats: dict[str, Any] = {}

    def _load(self) -> tuple[Any, Any, Any]:
        if self._model is not None:
            return self._model

        with self._lock:
            if self._model is not None:
                return self._model

            try:
                import torch
                from transformers import AutoModelForSequenceClassification, AutoTokenizer
            except ImportError as exc:  # pragma: no cover - depends on optional extra
                raise LocalRerankerError(
                    "RERANK_PROVIDER=local needs the 'local-embed' extra. "
                    "Install it with: uv sync --extra local-embed"
                ) from exc

            logger.info("loading local reranker %s (fp16=%s)", self._model_name, self._use_fp16)
            try:
                tokenizer = AutoTokenizer.from_pretrained(self._model_name)
                model = AutoModelForSequenceClassification.from_pretrained(self._model_name)
                model.eval()
                if self._use_fp16 and torch.cuda.is_available():
                    # fp16 on CPU is slower than fp32, not faster: there is no
                    # half-precision path in most CPU kernels, so it degrades to
                    # fp32 with conversion overhead on every op.
                    model = model.half()
            except Exception as exc:
                raise LocalRerankerError(
                    f"could not load {self._model_name!r}: {exc}. "
                    "As with the embedder, prefer a snapshot directory path over a repo id "
                    "when running offline."
                ) from exc

            self._model = (tokenizer, model, torch)
            return self._model

    def score(self, query: str, documents: list[str]) -> list[float]:
        """Score every document against the query, in input order.

        Blocking and CPU-bound by design; see the class docstring.

        Uses `transformers` directly rather than FlagEmbedding's `FlagReranker`,
        which is what the model card documents anyway. Not a stylistic choice:
        `FlagReranker` calls `tokenizer.prepare_for_model`, a transformers v4 API
        that **v5 removed** when it collapsed the slow/fast tokenizer split, so it
        raises `XLMRobertaTokenizer has no attribute prepare_for_model` against
        the transformers 5.x this project already runs. The embedder path is
        unaffected, which is why the incompatibility does not show up until
        reranking is attempted.
        """
        if not documents:
            return []

        tokenizer, model, torch = self._load()
        pairs = [(query, doc) for doc in documents]

        try:
            started = time.perf_counter()
            # Tokenised ONCE, without padding, so the true per-pair lengths are
            # known before anything is padded to anything. Padding is applied per
            # batch below, where the batch's own maximum is the only length that
            # has to be paid for.
            encoded = tokenizer(pairs, truncation=True, max_length=MAX_LENGTH)
            lengths = [len(ids) for ids in encoded["input_ids"]]
            plan = plan_batches(lengths, self._batch_size)
            keys = list(encoded.keys())
            tokenize_ms = int((time.perf_counter() - started) * 1000)

            started = time.perf_counter()
            batched: list[list[float]] = []
            with torch.no_grad():
                for batch in plan:
                    inputs = tokenizer.pad(
                        [{key: encoded[key][i] for key in keys} for i in batch],
                        return_tensors="pt",
                    )
                    logits = model(**inputs, return_dict=True).logits.view(-1).float()
                    # The head emits a single unbounded relevance logit. Squash it
                    # so a threshold is expressible at all; see the module
                    # docstring on why this still does not make it comparable to
                    # Cohere's scale.
                    raw = torch.sigmoid(logits) if self._normalize else logits
                    batched.append([float(x) for x in raw.tolist()])
            forward_ms = int((time.perf_counter() - started) * 1000)
        except LocalRerankerError:
            raise
        except Exception as exc:
            raise LocalRerankerError(f"local rerank failed: {exc}") from exc

        scores = restore_order(plan, batched, len(documents))

        self.last_stats = {
            **padding_stats(lengths, plan),
            "batch_size": self._batch_size,
            "tokenize_ms": tokenize_ms,
            "forward_ms": forward_ms,
        }
        # `octopus.ai.local_reranker` inherits the `_ExtraFormatter` main.py
        # installs, so these render as fields rather than being dropped.
        logger.info("local rerank pass", extra=self.last_stats)
        return scores
