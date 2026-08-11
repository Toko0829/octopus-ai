"""In-process BGE-M3 embeddings (ADR-0008).

Kept in its own module, and imported only when `EMBED_PROVIDER=local`, because
FlagEmbedding pulls torch and transformers: several GB that neither CI nor an
OpenAI-backed deployment should ever have to install. `providers.py` reaches in
here lazily, so the cost is paid by whoever opts in and by nobody else.

Two properties of the model matter to the rest of the system and are asserted
rather than trusted:

* **1024 dimensions.** bge-m3's `hidden_size` is 1024, which is what lets
  `doc_chunks.embedding halfvec(1024)` and the HNSW index survive the switch
  untouched. A mismatch here is a corrupt index, so it fails loudly.
* **Normalised vectors.** The index is cosine (`halfvec_cosine_ops`).
  FlagEmbedding returns L2-normalised dense vectors, and the norm is checked once
  on the first batch instead of being assumed for the life of the corpus.

**Running offline: point at a directory, not a repo id.** The bge-m3 repo carries
a complete ONNX duplicate of the weights (~2.3GB on top of `pytorch_model.bin`),
which nothing here loads. Excluding it halves the download, but FlagEmbedding
then calls `snapshot_download` *without* those exclusions, so with
`HF_HUB_OFFLINE=1` the hub client judges the cached snapshot incomplete and
refuses to load over files the model never needed. Setting `EMBED_LOCAL_MODEL` to
a filesystem path skips that check entirely, which is also what a container image
wants. Verified: repo-id + offline fails, path + offline loads.
"""

from __future__ import annotations

import logging
import math
import threading
from typing import Any

logger = logging.getLogger("octopus.ai.local_embedder")

# bge-m3 is an 8192-token model, but chunks are sized to ~512 tokens upstream
# (ingestion.TARGET_CHARS). Capping here bounds worst-case memory on a stray
# oversized input rather than letting one document decide the peak.
MAX_LENGTH = 1024


class LocalEmbedderError(RuntimeError):
    """The local embedder could not be loaded or produced an unusable result."""


class LocalEmbedder:
    """Lazily-loaded BGE-M3 encoder.

    The model is loaded once per process and guarded by a lock: loading takes
    seconds and a couple of GB, so two concurrent requests must not each build
    their own copy. Encoding itself is CPU-bound and blocking, which is why
    callers are expected to hand it to a worker thread rather than await it on
    the event loop.
    """

    def __init__(self, model_name: str, *, dimensions: int, use_fp16: bool) -> None:
        self._model_name = model_name
        self._dimensions = dimensions
        self._use_fp16 = use_fp16
        self._model: Any | None = None
        self._lock = threading.Lock()
        self._norm_checked = False

    def _load(self) -> Any:
        if self._model is not None:
            return self._model

        with self._lock:
            # Re-check inside the lock: another thread may have loaded it while
            # this one waited.
            if self._model is not None:
                return self._model

            try:
                from FlagEmbedding import BGEM3FlagModel
            except ImportError as exc:  # pragma: no cover - depends on optional extra
                raise LocalEmbedderError(
                    "EMBED_PROVIDER=local needs the 'local-embed' extra. "
                    "Install it with: uv sync --extra local-embed"
                ) from exc

            logger.info("loading local embedder %s (fp16=%s)", self._model_name, self._use_fp16)
            try:
                model = BGEM3FlagModel(self._model_name, use_fp16=self._use_fp16)
            except Exception as exc:
                # A missing local snapshot and a corrupt one look identical to the
                # caller otherwise, and both are silent-wrong-answer territory.
                raise LocalEmbedderError(
                    f"could not load {self._model_name!r}: {exc}. "
                    "If this mentions an incomplete snapshot while offline, the cache is "
                    "missing the unused onnx/ duplicate rather than anything the model "
                    "needs: set EMBED_LOCAL_MODEL to the snapshot directory path instead "
                    "of the repo id, which bypasses the completeness check."
                ) from exc

            self._model = model
            return model

    def encode(self, texts: list[str]) -> list[list[float]]:
        """Encode texts to dense vectors, preserving input order.

        Blocking and CPU-bound by design; see the class docstring.
        """
        if not texts:
            return []

        model = self._load()
        try:
            output = model.encode(
                texts,
                max_length=MAX_LENGTH,
                return_dense=True,
                # The sparse and ColBERT heads are deliberately off. Sparse
                # retrieval already lives in Postgres as a generated tsvector
                # fused by RRF inside `hybrid_search`; turning on m3's own sparse
                # output would mean two competing sparse implementations, which
                # is a retrieval-design decision, not a flag to flip here.
                return_sparse=False,
                return_colbert_vecs=False,
            )
        except Exception as exc:
            raise LocalEmbedderError(f"local embedding failed: {exc}") from exc

        dense = output["dense_vecs"]
        vectors = [[float(x) for x in row] for row in dense]

        if len(vectors) != len(texts):
            raise LocalEmbedderError(
                f"local embedder returned {len(vectors)} vectors for {len(texts)} inputs"
            )
        for vector in vectors:
            if len(vector) != self._dimensions:
                raise LocalEmbedderError(
                    f"expected {self._dimensions} dims, got {len(vector)}. "
                    "doc_chunks.embedding is halfvec(1024); a mismatch corrupts the index."
                )

        self._check_normalised(vectors[0])
        return vectors

    def _check_normalised(self, vector: list[float]) -> None:
        """Confirm once that vectors are unit length.

        The HNSW index is cosine. Unnormalised vectors would still insert and
        still return results, just subtly worse ones, so this is checked rather
        than assumed, and checked only once because it is a property of the model
        rather than of any particular batch.
        """
        if self._norm_checked:
            return
        norm = math.sqrt(sum(x * x for x in vector))
        if not math.isclose(norm, 1.0, abs_tol=1e-2):
            raise LocalEmbedderError(
                f"local embedder returned a vector of norm {norm:.4f}, expected ~1.0. "
                "The cosine index assumes normalised vectors."
            )
        self._norm_checked = True
