"""Typed adapters over OpenAI and Cohere.

integrations.md requires every provider to sit behind an adapter so a swap lands
in one file. ADR-0007 makes that concrete: embeddings and generation are OpenAI,
rerank is Cohere because OpenAI has no reranking endpoint.

Deliberately plain `httpx` rather than the vendor SDKs. Two calls, two well
documented HTTP endpoints, and no extra dependency tree to keep current in a
service whose whole job is to stay swappable.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

import httpx

from .config import Settings

logger = logging.getLogger("octopus.ai.providers")

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/chat/completions"
COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank"

# Transient statuses worth retrying: rate limit and the 5xx family.
_RETRY_STATUSES = {429, 500, 502, 503, 504}
_MAX_ATTEMPTS = 3

# A 429 is not a 5xx and must not share its backoff curve. Provider rate limits
# are quoted per minute, so retrying half a second later cannot succeed: it burns
# another call against the same exhausted quota and makes the next attempt more
# likely to fail too. Observed exactly that against a Cohere trial key, where the
# 0.5s and 1.0s retries were both rejected before the caller gave up.
#
# Deliberately not a full minute. This runs inside an agent step bounded by
# Node's timeout, so waiting out the whole window would trade a fast failure for
# a slow one. 20s is long enough to clear a partially-consumed quota and short
# enough that one retry still fits the budget.
_RATE_LIMIT_BACKOFF_S = 20.0


class ProviderError(RuntimeError):
    """A provider call failed in a way the caller must handle, not ignore."""


class _RateLimiter:
    """At most `per_minute` acquisitions in any rolling 60-second window.

    A sliding window rather than a token bucket, because that is the shape of the
    quota being respected. Cohere says "10 API calls / minute" and enforces it
    over a window; a bucket refilling steadily would let a burst straddle a
    boundary and breach the very limit it was added to respect.

    This is prevention, and `_post_with_retry`'s 429 backoff is recovery. Both
    are needed: the limiter cannot know what other processes are spending against
    the same key, and CI proved that matters. A pull-request run and a
    merge-to-main run raced over one trial key, and the second one was rejected
    on its first call, before it had spent anything at all.

    Deliberately holds the lock across the wait. Waiters are serialised in
    arrival order and wake one at a time, instead of every coroutine finding the
    window clear at once and re-breaching it together.
    """

    _WINDOW_S = 60.0

    def __init__(self, per_minute: int) -> None:
        self._per_minute = per_minute
        self._calls: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        if self._per_minute <= 0:
            return

        async with self._lock:
            while True:
                now = time.monotonic()
                while self._calls and now - self._calls[0] >= self._WINDOW_S:
                    self._calls.popleft()

                if len(self._calls) < self._per_minute:
                    self._calls.append(now)
                    return

                wait = self._WINDOW_S - (now - self._calls[0])
                logger.info(
                    "rerank rate limit reached (%d/min); holding %.1fs",
                    self._per_minute,
                    wait,
                )
                await asyncio.sleep(wait)


async def _post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    *,
    headers: dict[str, str],
    json: dict,
    what: str,
) -> dict:
    """POST with bounded exponential backoff.

    Retries only transient failures. A 400 means our request is wrong and
    retrying it just burns quota, so it fails immediately.
    """
    delay = 0.5
    last_detail = ""

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            response = await client.post(url, headers=headers, json=json)
        except httpx.RequestError as exc:
            last_detail = f"transport error: {exc}"
            if attempt == _MAX_ATTEMPTS:
                break
            await asyncio.sleep(delay)
            delay *= 2
            continue

        if response.status_code < 400:
            return response.json()

        last_detail = f"{response.status_code} {response.text[:300]}"
        if response.status_code not in _RETRY_STATUSES or attempt == _MAX_ATTEMPTS:
            break

        # Honour Retry-After when the provider sends one; it knows better than
        # our backoff curve does. Absent that, a rate limit gets its own floor
        # rather than the 5xx curve, for the reason above.
        retry_after = response.headers.get("retry-after")
        if retry_after and retry_after.isdigit():
            wait = float(retry_after)
        elif response.status_code == 429:
            wait = max(delay, _RATE_LIMIT_BACKOFF_S)
        else:
            wait = delay
        logger.warning(
            "%s attempt %d failed (%s); retrying in %.1fs", what, attempt, last_detail, wait
        )
        await asyncio.sleep(wait)
        delay *= 2

    raise ProviderError(f"{what} failed after {_MAX_ATTEMPTS} attempts: {last_detail}")


@dataclass(frozen=True)
class RerankHit:
    index: int
    score: float


class Providers:
    """Provider calls for one process. Holds a pooled client; close it on shutdown."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._s = settings
        self._client = client or httpx.AsyncClient(timeout=settings.request_timeout_s)
        # Built on first use and reused for the process lifetime: loading bge-m3
        # costs seconds and a couple of GB, so it must not happen per request.
        self._local_embedder: object | None = None
        self._local_reranker: object | None = None
        # Per-process, which is the honest scope: it governs this service's own
        # spend against the key and claims nothing about anyone else's.
        self._rerank_limiter = _RateLimiter(settings.rerank_rpm)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed texts, preserving input order.

        Dispatches on `embed_provider` (ADR-0008). Both paths return 1024 dims,
        so `doc_chunks.embedding halfvec(1024)` holds either way, but the two
        vector spaces are NOT interchangeable: a corpus must be embedded wholly
        by one or wholly by the other. The ingestion content hash covers the
        active model precisely so switching forces a re-embed instead of quietly
        mixing them.
        """
        if not texts:
            return []
        if self._s.embed_provider == "local":
            return await self._embed_local(texts)
        return await self._embed_openai(texts)

    async def _embed_local(self, texts: list[str]) -> list[list[float]]:
        """In-process BGE-M3.

        Imported here rather than at module scope so torch is only required when
        it is actually selected, and run in a worker thread because the encode is
        blocking CPU work that would otherwise stall the whole event loop.
        """
        from .local_embedder import LocalEmbedder, LocalEmbedderError

        if self._local_embedder is None:
            self._local_embedder = LocalEmbedder(
                self._s.embed_local_source,
                dimensions=self._s.embed_dimensions,
                use_fp16=self._s.embed_local_fp16,
            )

        out: list[list[float]] = []
        batch = self._s.embed_batch_size
        for start in range(0, len(texts), batch):
            window = texts[start : start + batch]
            try:
                out.extend(await asyncio.to_thread(self._local_embedder.encode, window))
            except LocalEmbedderError as exc:
                # Same failure type as a provider outage, so callers keep their
                # single error path and a broken local model cannot be mistaken
                # for "no results".
                raise ProviderError(str(exc)) from exc
        return out

    async def _embed_openai(self, texts: list[str]) -> list[list[float]]:
        """Embed via the OpenAI endpoint, preserving input order.

        Batched because the endpoint accepts arrays: one request per chunk would
        multiply latency and per-call overhead across a whole document.

        `dimensions` is sent explicitly (ADR-0007). Without it the model returns
        3072 dims and every insert would fail against halfvec(1024) — better to
        be explicit here than to debug a dimension mismatch at write time.
        """
        out: list[list[float]] = []
        batch = self._s.embed_batch_size

        for start in range(0, len(texts), batch):
            window = texts[start : start + batch]
            payload = await _post_with_retry(
                self._client,
                OPENAI_EMBEDDINGS_URL,
                headers={"Authorization": f"Bearer {self._s.openai_api_key}"},
                json={
                    "model": self._s.embed_model,
                    "input": window,
                    "dimensions": self._s.embed_dimensions,
                },
                what="openai embeddings",
            )

            data = payload.get("data") or []
            if len(data) != len(window):
                raise ProviderError(
                    f"openai embeddings returned {len(data)} vectors for {len(window)} inputs"
                )
            # The API documents index ordering, but sorting makes the guarantee
            # ours rather than borrowed: a misaligned batch would attach the
            # wrong vector to the wrong chunk, and nothing downstream could tell.
            for item in sorted(data, key=lambda d: d["index"]):
                vector = item["embedding"]
                if len(vector) != self._s.embed_dimensions:
                    raise ProviderError(
                        f"expected {self._s.embed_dimensions} dims, got {len(vector)}"
                    )
                out.append(vector)

        return out

    async def complete_json(self, *, system: str, user: str, model: str | None = None) -> str:
        """One generation call constrained to return a JSON object.

        `json_object` mode rather than a JSON schema: it is the broadly supported
        form, and the caller validates against Pydantic anyway, so a schema here
        would duplicate the contract without removing the need to check it. The
        model can still return well-formed JSON of the wrong shape, which is why
        the caller must treat validation failure as a real outcome rather than an
        impossibility.
        """
        payload = await _post_with_retry(
            self._client,
            OPENAI_RESPONSES_URL,
            headers={"Authorization": f"Bearer {self._s.openai_api_key}"},
            json={
                # Model tiering (tech-stack.md): the caller picks the tier. Query
                # decomposition is a classification-shaped task and does not need
                # the planning model.
                "model": model or self._s.generation_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "response_format": {"type": "json_object"},
                "max_completion_tokens": self._s.generation_max_tokens,
            },
            what="openai chat completion (json)",
        )

        choices = payload.get("choices") or []
        if not choices:
            raise ProviderError("openai returned no choices")
        content = (choices[0].get("message") or {}).get("content")
        if not content or not content.strip():
            raise ProviderError("openai returned an empty completion")
        return content

    async def complete(self, *, system: str, user: str) -> str:
        """One generation call. Returns the message text.

        The system prompt and the retrieved sources travel in separate messages
        so the instruction channel stays distinct from untrusted reference data
        (AGENTS.md rule 8).
        """
        payload = await _post_with_retry(
            self._client,
            OPENAI_RESPONSES_URL,
            headers={"Authorization": f"Bearer {self._s.openai_api_key}"},
            json={
                "model": self._s.generation_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.3,
                # `max_completion_tokens`, not `max_tokens`: the gpt-5 family
                # rejects the older parameter outright ("Unsupported parameter").
                # Verified against the API, not assumed.
                "max_completion_tokens": self._s.generation_max_tokens,
            },
            what="openai chat completion",
        )

        choices = payload.get("choices") or []
        if not choices:
            raise ProviderError("openai returned no choices")
        content = (choices[0].get("message") or {}).get("content")
        if not content or not content.strip():
            raise ProviderError("openai returned an empty completion")
        return content

    async def rerank(self, query: str, documents: list[str], top_n: int) -> list[RerankHit]:
        """Cross-encoder rescoring. Returns (index into `documents`, score), best first.

        Rate-limited when `rerank_rpm` is set. This is the only metered call in
        the service, and query decomposition made one goal cost up to seven of
        them, so the ceiling belongs here rather than in any one caller.
        """
        if not documents:
            return []

        if self._s.rerank_provider == "local":
            return await self._rerank_local(query, documents, top_n)

        await self._rerank_limiter.acquire()

        payload = await _post_with_retry(
            self._client,
            COHERE_RERANK_URL,
            headers={"Authorization": f"Bearer {self._s.cohere_api_key}"},
            json={
                "model": self._s.rerank_model,
                "query": query,
                "documents": documents,
                "top_n": min(top_n, len(documents)),
            },
            what="cohere rerank",
        )

        return [
            RerankHit(index=int(r["index"]), score=float(r["relevance_score"]))
            for r in payload.get("results", [])
        ]

    async def _rerank_local(self, query: str, documents: list[str], top_n: int) -> list[RerankHit]:
        """In-process cross-encoder.

        Not rate-limited: there is no quota, which is the entire point of the
        option. Run in a worker thread because scoring is blocking CPU work that
        would otherwise stall the event loop for the whole service.

        Returns the same shape as the Cohere path — index into `documents`, score,
        best first — so callers cannot tell which provider ran. The SCORES are not
        comparable across providers though, which is why the threshold applied to
        them is selected per provider (`active_rerank_min_score`).
        """
        from .local_reranker import LocalReranker

        if self._local_reranker is None:
            self._local_reranker = LocalReranker(
                self._s.rerank_local_source,
                use_fp16=self._s.rerank_local_fp16,
            )

        reranker = self._local_reranker
        scores = await asyncio.to_thread(reranker.score, query, documents)

        ranked = sorted(
            (RerankHit(index=i, score=s) for i, s in enumerate(scores)),
            key=lambda h: h.score,
            reverse=True,
        )
        return ranked[: min(top_n, len(documents))]
