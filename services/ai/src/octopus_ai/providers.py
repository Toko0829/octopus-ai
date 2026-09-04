"""Typed adapters over the generation providers, plus embeddings and rerank.

integrations.md requires every provider to sit behind an adapter so a swap lands
in one file. ADR-0007 made that concrete for embeddings (OpenAI) and rerank
(Cohere, because OpenAI has no reranking endpoint); ADR-0032 turns generation
into the thing that actually swaps, per request, per workspace.

Deliberately plain `httpx` rather than the vendor SDKs. Four wire shapes, four
documented HTTP endpoints, and no vendor dependency tree to keep current in a
service whose whole job is to stay swappable. Each dialect is pinned by an
`httpx.MockTransport` test rather than by a library's own release notes.

**Retrieval is untouched by all of this.** Embedding and rerank stay in-process
(ADR-0008, ADR-0009) whatever a workspace connects, so no corpus text leaves the
process because somebody chose a different reasoning model.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings
from .fake_vendor import fake_completion
from .schemas import GenerationTarget

logger = logging.getLogger("octopus.ai.providers")

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"
OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENAI_CHAT_URL = f"{OPENAI_BASE_URL}/chat/completions"
COHERE_RERANK_URL = "https://api.cohere.com/v2/rerank"

# Verified against the vendor reference on 2026-09-04 (rule 21), not recalled.
#
# Anthropic: `anthropic-version` is a required header and `max_tokens` a required
# body field. `x-api-key` is documented as the legacy fallback for
# `Authorization: Bearer` and is still supported; it is used here because a
# customer pastes an API key and nothing on this path mints a short-lived token.
ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"

# Google: the Interactions API is generally available and the documented default
# interface as of June 2026; `models/{model}:generateContent` is legacy but still
# supported. The reference documents the endpoint under `/v1beta` and says a
# stable `/v1` also exists, so this is one constant to move when it does.
GOOGLE_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"

# Which provider the server's own key belongs to. The house default is an OpenAI
# key (ADR-0007 as amended by ADR-0032), and this is the string that reaches the
# ledger and the message chip when no route was set.
HOUSE_PROVIDER = "openai"

# Adaptive thinking is on by default on the strong Claude models and its tokens
# count against `max_tokens`, so a caller's 4000-token budget for a six-stage plan
# would be spent thinking and the JSON would arrive truncated. That failure is not
# hypothetical here: `generation_max_tokens_long` is 4000 precisely because 900
# truncated every plan card into prose, silently, for weeks (config.py says so at
# length). Headroom is added rather than the budget replaced, so the caller keeps
# owning how much OUTPUT it asked for.
# Extra `max_tokens` for the thinking phase, which Anthropic spends out of the
# same budget as the answer. **Measured, not guessed, and 4000 was too small.**
#
# On a 16-chunk sources block, Claude Sonnet 5 was observed thinking 3217, 3246,
# 3445, 3528 and then 7191 tokens for the same prompt. The plan itself needs
# about 2000 to 2600. At 7191 the 8000-token cap left 809 for the answer, the
# reply was cut off mid-JSON, and the caller saw a `ProviderError`, retried once,
# and fell back to prose. The eval recorded that as the model failing to produce
# a card, which is how a budget arithmetic error comes to look like a verdict on
# a model.
#
# The variance is the point: thinking length is adaptive and cannot be predicted
# from the prompt, so the headroom has to cover the tail rather than the median.
# 12000 sits well above the worst observed run.
#
# **Raising it costs nothing when it is not used.** `max_tokens` is a ceiling,
# not a reservation, and providers bill the tokens actually produced, so a fast
# answer is billed and returned exactly as before. What it does spend is time,
# which is why it landed together with the 240s `request_timeout_s`: a cap the
# client hangs up before reaching is not a cap, it is three abandoned
# completions.
_ANTHROPIC_THINKING_HEADROOM = 12000

# Anthropic and Google have a JSON schema mode; neither has OpenAI's cheap
# `json_object`. Schema mode is named-not-built (it needs a per-caller schema and
# each vendor restricts what the schema may contain), so JSON is asked for in the
# instruction channel and the answer is unwrapped by `_extract_json_object`. Every
# caller validates with pydantic afterwards and treats failure as a real outcome,
# which is the check that actually holds either way.
_JSON_ONLY_SUFFIX = "\n\nReply with one JSON object and nothing else."

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


def _extract_json_object(text: str) -> str:
    """Return the one JSON object inside a model's reply, or raise.

    Needed because only the OpenAI dialect has a cheap `json_object` mode. On the
    other two, "reply with one JSON object" is an instruction, and a model obeying
    an instruction sometimes wraps the object in a code fence or prefaces it with a
    sentence. Both are the model complying imperfectly rather than failing, and
    throwing the answer away over a fence would turn a usable plan into a refusal.

    Deliberately dumb: first `{` to last `}`. A smarter parser would be guessing at
    which of several objects was meant, and there is only ever supposed to be one.
    Raises `ValueError` when there is no object at all, which every caller already
    handles: `parse_plan`, the executor and the campaign drafter all treat a
    malformed answer as a real outcome rather than an impossibility.

    A no-op on well-formed output, including everything OpenAI returns in JSON
    mode, so it runs on every JSON path rather than only on the ones that need it.
    """
    stripped = text.strip()
    if stripped.startswith("```"):
        # ```json\n{...}\n``` and ```\n{...}\n``` alike: drop the opening fence
        # line and anything after the closing one.
        stripped = stripped.split("\n", 1)[-1] if "\n" in stripped else ""
        end = stripped.rfind("```")
        if end != -1:
            stripped = stripped[:end]

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object in the model's reply")
    return stripped[start : end + 1]


def attribution(target: GenerationTarget | None, providers: Providers) -> tuple[str, str]:
    """Who answered: the target's provider and model, or the house default's.

    One function rather than the same two-line conditional in the planner and the
    ungrounded tier, because this pair is what gets stamped onto a message and
    written into the gap ledger. Two copies of it would be two places for
    "no route means the house model" to drift, and the surface it drifts on is an
    audit trail.
    """
    if target is not None:
        return target.provider, target.model
    return HOUSE_PROVIDER, providers.house_model


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
            # **A read timeout is not retried, and the distinction is money.**
            # Reaching here through `ReadTimeout` means the provider accepted the
            # request and was generating when we hung up: the completion is
            # produced and billed whatever we do next, and asking again buys a
            # second full completion for the same reason the first one "failed".
            # Measured: three abandoned Sonnet 5 plans per eval case, all paid
            # for, the run reported as the model failing to produce a card.
            #
            # A connect failure is the opposite and still retries: nothing was
            # generated, so another attempt costs nothing and is often the right
            # answer to a dropped socket.
            if isinstance(exc, (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout)):
                last_detail = (
                    f"timed out after {client.timeout.read}s; not retried, because the "
                    "provider was generating and a retry would bill a second completion"
                )
                break
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
        # Guards CONSTRUCTION of the reranker, not scoring. `LocalReranker` has
        # its own internal lock around loading the weights, but the object itself
        # was built on an unguarded `is None` check, so two coroutines arriving
        # together each built one and each loaded a ~1 GB model. With the
        # sequential sub-query loop that race needed two concurrent requests to
        # show up; `RERANK_FANOUT` makes concurrent passes the normal case, so it
        # is closed before the fan-out can find it.
        self._local_reranker_lock = asyncio.Lock()
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

    @property
    def house_model(self) -> str:
        """The model this process uses when a call carries no target.

        Exposed because attribution needs it and not every caller holds
        `Settings`: the ungrounded tier is handed providers and a goal, and it
        still has to be able to say which model answered.
        """
        return self._s.generation_model

    async def complete_json(
        self,
        *,
        system: str,
        user: str,
        model: str | None = None,
        max_tokens: int | None = None,
        target: GenerationTarget | None = None,
    ) -> str:
        """One generation call constrained to return a JSON object.

        `json_object` mode rather than a JSON schema on the OpenAI path: it is the
        broadly supported form, and the caller validates against Pydantic anyway,
        so a schema here would duplicate the contract without removing the need to
        check it. The model can still return well-formed JSON of the wrong shape,
        which is why the caller must treat validation failure as a real outcome
        rather than an impossibility.

        `target` is one workspace's connector for this one request (ADR-0032).
        With no target this is byte-for-byte the call it has always been, on the
        server's own key, which is what "Auto" means on the settings surface.
        `model` still selects the house TIER and is ignored when a target is
        given, because a target already names the model it wants.
        """
        if target is not None:
            return _extract_json_object(
                await self._complete_via_target(
                    system=system,
                    user=user,
                    target=target,
                    max_tokens=max_tokens or self._s.generation_max_tokens,
                    temperature=0,
                    json_mode=True,
                )
            )

        payload = await _post_with_retry(
            self._client,
            OPENAI_CHAT_URL,
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
                # Sent explicitly, because omitting it means the API default of
                # 1.0. Every caller of this method is doing classification or
                # routing (query decomposition today), where sampling variety is
                # not a feature: the same goal should decompose the same way
                # twice. It was measurably not doing so. Across five runs of one
                # unchanged commit the golden set returned coverage 0.97-1.00 and
                # MRR 0.83-0.95, entirely because the sub-queries differed each
                # time, which makes a real regression hard to distinguish from
                # resampling.
                #
                # Not a determinism guarantee: providers stay free to vary at
                # temperature 0. It removes the deliberate variance, not all of it.
                "temperature": 0,
                "max_completion_tokens": max_tokens or self._s.generation_max_tokens,
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

    async def complete(
        self,
        *,
        system: str,
        user: str,
        max_tokens: int | None = None,
        target: GenerationTarget | None = None,
    ) -> str:
        """One generation call. Returns the message text.

        The system prompt and the retrieved sources travel in separate messages
        so the instruction channel stays distinct from untrusted reference data
        (AGENTS.md rule 8). That separation survives every dialect: Anthropic and
        Google both carry the system prompt in their own top-level field rather
        than concatenated into the user turn.

        Same target rule as `complete_json`, and the same default: no target is
        the house key on today's exact request.
        """
        if target is not None:
            return await self._complete_via_target(
                system=system,
                user=user,
                target=target,
                max_tokens=max_tokens or self._s.generation_max_tokens,
                temperature=0.3,
                json_mode=False,
            )

        payload = await _post_with_retry(
            self._client,
            OPENAI_CHAT_URL,
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
                "max_completion_tokens": max_tokens or self._s.generation_max_tokens,
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

    # ------------------------------------------------------------- dialects ----
    #
    # One method per wire shape, dispatched on `target.vendor`. Nothing above this
    # line changes when a vendor is added, and nothing below it knows what a plan
    # or a deliverable is.
    #
    # SECURITY: `target.api_key` is unwrapped exactly where the header is built and
    # nowhere else. It never reaches a log line, a `what=` string (which
    # `_post_with_retry` prints on failure) or an exception message.

    async def _complete_via_target(
        self,
        *,
        system: str,
        user: str,
        target: GenerationTarget,
        max_tokens: int,
        temperature: float,
        json_mode: bool,
    ) -> str:
        logger.info(
            "generation on a workspace target",
            extra={
                "vendor": target.vendor,
                "provider": target.provider,
                "model": target.model,
                "json_mode": json_mode,
            },
        )
        if target.vendor == "openai_compatible":
            return await self._openai_compatible(
                system=system,
                user=user,
                target=target,
                max_tokens=max_tokens,
                temperature=temperature,
                json_mode=json_mode,
            )
        if target.vendor == "anthropic":
            return await self._anthropic_messages(
                system=system,
                user=user,
                target=target,
                max_tokens=max_tokens,
                json_mode=json_mode,
            )
        if target.vendor == "google":
            return await self._google_interactions(
                system=system,
                user=user,
                target=target,
                max_tokens=max_tokens,
                temperature=temperature,
                json_mode=json_mode,
            )
        if target.vendor == "fake":
            return fake_completion(target.model, user, json_mode=json_mode)
        # Unreachable through the API, where `vendor` is a Literal. Reachable from
        # the eval harness, which builds its own target from command-line flags.
        raise ProviderError(f"unknown generation vendor {target.vendor!r}")

    async def _openai_compatible(
        self,
        *,
        system: str,
        user: str,
        target: GenerationTarget,
        max_tokens: int,
        temperature: float,
        json_mode: bool,
    ) -> str:
        """Chat completions, on OpenAI itself or on anything that speaks its shape.

        The same body the house path sends, with the caller's key and model. The
        `base_url` seam exists on the wire so a self-hosted or gateway endpoint is
        a data change rather than a code change; there is no UI for it yet.
        """
        base = (target.base_url or OPENAI_BASE_URL).rstrip("/")
        body: dict[str, Any] = {
            "model": target.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_completion_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}

        payload = await _post_with_retry(
            self._client,
            f"{base}/chat/completions",
            headers={"Authorization": f"Bearer {target.api_key.get_secret_value()}"},
            json=body,
            what=f"{target.provider} chat completion",
        )

        choices = payload.get("choices") or []
        if not choices:
            raise ProviderError(f"{target.provider} returned no choices")
        content = (choices[0].get("message") or {}).get("content")
        if not content or not content.strip():
            raise ProviderError(f"{target.provider} returned an empty completion")
        return content

    async def _anthropic_messages(
        self,
        *,
        system: str,
        user: str,
        target: GenerationTarget,
        max_tokens: int,
        json_mode: bool,
    ) -> str:
        """The Messages API.

        Three differences from the OpenAI shape, each verified against the vendor
        reference on 2026-09-04 rather than assumed (rule 21):

        **No `temperature`, ever.** Models after Claude Opus 4.6 reject any value
        but 1.0 with a 400, and that includes both strong models a workspace is
        likely to connect. Sending the house path's 0 or 0.3 would fail every call
        on exactly the models this dialect exists to reach, so the parameter is not
        sent at all and the vendor's own default stands. This is why JSON mode here
        cannot be "the same call at temperature 0".

        **`max_tokens` is required, and adaptive thinking spends it**, which is what
        the headroom is for. Running out is reported rather than returned: a
        truncated plan is invalid JSON, and `ProviderError` is what makes the
        planner's corrective retry and its prose fallback run, instead of a
        half-written card reaching somebody.

        **The system prompt is a top-level field**, which suits rule 8 better than a
        system message does: the instruction channel is structurally separate from
        the turn carrying untrusted sources rather than merely first in a list.
        """
        body: dict[str, Any] = {
            "model": target.model,
            "system": f"{system}{_JSON_ONLY_SUFFIX}" if json_mode else system,
            "messages": [{"role": "user", "content": user}],
            "max_tokens": max_tokens + _ANTHROPIC_THINKING_HEADROOM,
        }

        payload = await _post_with_retry(
            self._client,
            ANTHROPIC_MESSAGES_URL,
            headers={
                "x-api-key": target.api_key.get_secret_value(),
                "anthropic-version": ANTHROPIC_VERSION,
            },
            json=body,
            what=f"{target.provider} messages",
        )

        stop = payload.get("stop_reason")
        if stop == "max_tokens":
            raise ProviderError(f"{target.provider} truncated the reply at max_tokens")
        if stop == "refusal":
            raise ProviderError(f"{target.provider} declined to answer")

        # Several blocks are normal (thinking, then text). Only the text ones are
        # the answer, and joining them is what makes a multi-block reply whole
        # rather than arbitrarily the first paragraph of it.
        text = "".join(
            block.get("text") or ""
            for block in payload.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if not text.strip():
            raise ProviderError(f"{target.provider} returned an empty completion")
        return text

    async def _google_interactions(
        self,
        *,
        system: str,
        user: str,
        target: GenerationTarget,
        max_tokens: int,
        temperature: float,
        json_mode: bool,
    ) -> str:
        """The Interactions API, which is Gemini's current interface.

        Generally available and recommended for new projects since June 2026, with
        `models/{model}:generateContent` kept as supported legacy, so this is the
        one to build on. The OpenAI-compatibility layer is deliberately not used:
        it is beta and **silently ignores parameters it does not support**, which
        would make a token cap or a JSON request look applied when it was not, and
        a silently ignored cap is exactly the class of defect this file's
        `temperature` comment was written about.
        """
        body: dict[str, Any] = {
            "model": target.model,
            "input": user,
            "system_instruction": f"{system}{_JSON_ONLY_SUFFIX}" if json_mode else system,
            "generation_config": {
                "temperature": temperature,
                "max_output_tokens": max_tokens,
            },
        }

        payload = await _post_with_retry(
            self._client,
            GOOGLE_INTERACTIONS_URL,
            headers={"x-goog-api-key": target.api_key.get_secret_value()},
            json=body,
            what=f"{target.provider} interaction",
        )

        text = "".join(
            block.get("text") or ""
            for step in payload.get("steps") or []
            if isinstance(step, dict)
            for block in step.get("content") or []
            if isinstance(block, dict) and block.get("type") == "text"
        )
        if not text.strip():
            # The documented convenience field, read only when walking the steps
            # found nothing. The steps are the reference's own response shape;
            # `output_text` is a helper whose presence in the raw JSON is not
            # promised, so it is the fallback rather than the first read.
            helper = payload.get("output_text")
            text = helper if isinstance(helper, str) else ""
        if not text.strip():
            raise ProviderError(f"{target.provider} returned an empty completion")
        return text

    async def rerank(self, query: str, documents: list[str], top_n: int) -> list[RerankHit]:
        """Cross-encoder rescoring. Returns (index into `documents`, score), best first.

        Rate-limited when `rerank_rpm` is set. This is the only metered call in
        the service, and query decomposition made one goal cost up to seven of
        them, so the ceiling belongs here rather than in any one caller.

        `RERANK_FANOUT` above 1 lets several callers arrive here at once. On the
        Cohere path that buys nothing and breaks nothing: `_RateLimiter` holds its
        lock across the wait, so concurrent callers are still serialised in
        arrival order and the rolling window is still respected. The fan-out is a
        lever on the local path, where the cost is CPU rather than quota.
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
        reranker = await self._get_local_reranker()
        scores = await asyncio.to_thread(reranker.score, query, documents)

        ranked = sorted(
            (RerankHit(index=i, score=s) for i, s in enumerate(scores)),
            key=lambda h: h.score,
            reverse=True,
        )
        return ranked[: min(top_n, len(documents))]

    async def _get_local_reranker(self) -> Any:
        """The one cross-encoder for this process, built at most once.

        The unlocked fast path is deliberate and load-bearing beyond speed: tests
        inject a fake by assigning `p._local_reranker` directly, and that
        injection has to win without their needing to know a lock exists.

        Double-checked under the lock, because between the fast path failing and
        the lock being acquired another coroutine may have finished building one.
        """
        if self._local_reranker is not None:
            return self._local_reranker

        from .local_reranker import LocalReranker

        async with self._local_reranker_lock:
            if self._local_reranker is None:
                self._local_reranker = LocalReranker(
                    self._s.rerank_local_source,
                    use_fp16=self._s.rerank_local_fp16,
                    batch_size=self._s.rerank_batch_size,
                )
            return self._local_reranker

    async def warm_reranker(self) -> None:
        """Load the cross-encoder and run one real forward pass, before serving.

        The embedder has been warmed at startup since ADR-0008 and the reranker
        never was, so the first plan on every fresh process paid the model load
        INSIDE the request, on top of a pass that is already the dominant cost of
        the turn. Measured on a warm page cache, a cold first rerank is **18.4s**
        against roughly 2s warm. That is the defect ADR-0008 fixed for the
        embedder, surviving in the other model.

        A real `score` rather than a bare load, because the first forward pass
        initialises kernels that loading does not touch. Warming with a load alone
        would move part of the cost and leave the rest where it was.

        No-op unless the local path is selected, so a Cohere deployment never
        imports torch to warm something it will not use. Failures surface as
        `ProviderError` exactly as `_embed_local` does, which is what makes a
        missing or corrupt model a named startup failure rather than a 500 on
        somebody's first question.
        """
        if self._s.rerank_provider != "local":
            return

        from .local_reranker import LocalRerankerError

        reranker = await self._get_local_reranker()
        try:
            await asyncio.to_thread(reranker.score, "warmup", ["warmup"])
        except LocalRerankerError as exc:
            raise ProviderError(str(exc)) from exc
