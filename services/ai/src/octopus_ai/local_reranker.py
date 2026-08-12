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


class LocalReranker:
    """Lazily-loaded BGE cross-encoder.

    Loaded once per process behind a lock, for the same reason as the embedder:
    two concurrent requests must not each build their own multi-GB copy. Scoring
    is blocking CPU work, so callers hand it to a worker thread rather than await
    it on the event loop.
    """

    def __init__(self, model_name: str, *, use_fp16: bool, normalize: bool = True) -> None:
        self._model_name = model_name
        self._use_fp16 = use_fp16
        # Sigmoid-squashed to 0-1. Not because that makes it comparable to Cohere
        # (it does not), but because a bounded score is something a threshold can
        # be reasoned about and logged against at all.
        self._normalize = normalize
        self._model: Any | None = None
        self._lock = threading.Lock()

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
            with torch.no_grad():
                inputs = tokenizer(
                    pairs,
                    padding=True,
                    truncation=True,
                    max_length=MAX_LENGTH,
                    return_tensors="pt",
                )
                logits = model(**inputs, return_dict=True).logits.view(-1).float()
                # The head emits a single unbounded relevance logit. Squash it so
                # a threshold is expressible at all; see the module docstring on
                # why this still does not make it comparable to Cohere's scale.
                raw = torch.sigmoid(logits) if self._normalize else logits
                scores = [float(x) for x in raw.tolist()]
        except Exception as exc:
            raise LocalRerankerError(f"local rerank failed: {exc}") from exc

        if len(scores) != len(documents):
            raise LocalRerankerError(
                f"local reranker returned {len(scores)} scores for {len(documents)} documents"
            )
        return scores
