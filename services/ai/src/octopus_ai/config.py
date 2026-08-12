"""Service configuration, validated once at import.

Mirrors the Node side's fail-loudly-at-boot behaviour (AGENTS.md rule 16): a
missing key surfaces as a named variable at startup, not as a confusing 500 on
the first retrieval.

Nothing here is optional-with-a-silent-default. Where a default exists it is a
tuning value, never a credential.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


class ConfigError(RuntimeError):
    """Raised when required configuration is absent or unusable."""


_REPO_ROOT = Path(__file__).resolve().parents[4]
# Local development only. In production the platform injects the environment and
# none of these files exist. `apps/api/.env` is included because the provider and
# Supabase keys already live there and duplicating secrets across files is how
# they drift and how one of them ends up committed.
_ENV_CANDIDATES = (
    _REPO_ROOT / "services" / "ai" / ".env",
    _REPO_ROOT / "apps" / "api" / ".env",
)


def load_local_env() -> None:
    """Populate os.environ from a local .env, without overriding real env vars.

    Real environment always wins, so a deployed process is never silently
    reconfigured by a file that happened to ship in the image.
    """
    for path in _ENV_CANDIDATES:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is required. See .env.example and DEVELOPMENT.md; "
            "the AI service cannot embed or rerank without it."
        )
    return value


def _choice(name: str, default: str, allowed: set[str]) -> str:
    """Read an enum-ish setting, failing loudly on anything unrecognised.

    A typo'd EMBED_PROVIDER must not quietly fall back to the default: that is how
    a corpus ends up embedded by a model nobody selected.
    """
    value = (os.environ.get(name) or default).strip()
    if value not in allowed:
        raise ConfigError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    normalised = raw.strip().lower()
    if normalised in {"1", "true", "yes", "on"}:
        return True
    if normalised in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be a boolean, got {raw!r}")


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str

    openai_api_key: str
    cohere_api_key: str

    # ADR-0007, amended by ADR-0008. The embedding model and its dimension count
    # are a matched pair: doc_chunks.embedding is halfvec(1024), and one model
    # must cover the whole corpus, so changing either means re-embedding
    # everything.
    #
    # `local` runs BAAI/bge-m3 in-process instead of calling OpenAI. It emits 1024
    # dims natively (verified against the model config, not assumed), so halfvec
    # (1024) and the HNSW index are unchanged either way. Default stays `openai`
    # so neither CI nor a plain `uv sync` has to carry torch; opting in is an env
    # var, and the two are never mixed within one corpus.
    embed_provider: str = "openai"
    embed_model: str = "text-embedding-3-large"
    # The model's IDENTITY: stamped on every doc_chunks row and folded into the
    # ingestion hash. Deliberately separate from where the weights happen to sit,
    # so moving this machine's cache, or deploying to a server with a different
    # layout, does not rewrite every row's provenance or force a spurious
    # re-embed of an identical model.
    embed_local_model: str = "BAAI/bge-m3"
    # Optional LOCATION override: a filesystem path to load from. Empty means
    # resolve `embed_local_model` through the HF cache as a repo id. Required for
    # HF_HUB_OFFLINE, where a repo id fails on the unused onnx/ files.
    embed_local_path: str = ""
    embed_dimensions: int = 1024
    # fp16 halves the resident model and speeds inference. Meaningless on CPU-only
    # hosts, where the local embedder falls back to fp32 rather than failing.
    embed_local_fp16: bool = True
    rerank_model: str = "rerank-v3.5"

    # Rerank provider: `local` (default) for in-process BAAI/bge-reranker-v2-m3,
    # or `cohere` to go back to the hosted cross-encoder. ADR-0009 amends
    # ADR-0007's rerank pin; Cohere is kept as a working fallback rather than
    # deleted, since the adapter costs nothing to retain.
    #
    # Same identity/location split as the embedder: the MODEL is what gets
    # recorded and reasoned about, the PATH is where this host keeps the weights.
    #
    # Unlike the embedder, switching this does NOT require re-ingesting: reranking
    # happens at query time over rows the embedder already placed. What it DOES
    # require is a different threshold, which is why that is per-provider below.
    rerank_provider: str = "local"
    rerank_local_model: str = "BAAI/bge-reranker-v2-m3"
    rerank_local_path: str = ""
    rerank_local_fp16: bool = True

    # Model tiering (tech-stack.md): strong for planning and critique, fast for
    # executor steps, cheap for classification and routing. Only the strong tier
    # is used today; the others exist so the split is configured rather than
    # hardcoded when executor steps arrive.
    #
    # IDs verified against the account's /v1/models listing, never recalled from
    # memory (AGENTS.md rule 21). Override per environment rather than editing.
    generation_model: str = "gpt-5.4"
    generation_model_fast: str = "gpt-5.4-mini"
    generation_model_cheap: str = "gpt-5.4-nano"
    generation_max_tokens: int = 900

    # Retrieval shape, from rag.md: fuse to 40 candidates, rerank down to 6-8.
    # Query decomposition (rag.md retrieval step 1). Splits a goal into
    # per-stage sub-queries so one broad ask does not retrieve one stage's
    # documents and leave the rest of the funnel unplanned.
    #
    # It costs ONE RERANK PER SUB-QUERY, up to MAX_SUBQUERIES + 1 for a single
    # goal. That is the whole point rather than an oversight: the cheap design
    # (search every sub-query, rerank once against the original goal) was built,
    # measured and found to change nothing, because candidate breadth was never
    # the bottleneck. The rerank is. See retrieval.py's `retrieve`.
    #
    # So decomposition multiplies rerank traffic, and a rate-limited key feels it
    # directly. `rerank_rpm` below is what keeps that survivable.
    query_decomposition: bool = True

    # How many RRF survivors reach the reranker. This is a MEASURED setting tied
    # to corpus size, not a constant.
    #
    # rag.md specifies "top-40 -> top 6-8", written for a corpus of meaningful
    # size. The corpus is currently **43 in-force chunks**, so 40 candidates sent
    # 93% of everything to the cross-encoder on every query: the reranker was
    # doing retrieval's job rather than refining it. Measured on the golden set,
    # RRF already places the expected document at **rank 1-3** before any
    # reranking, so the depth was buying nothing and costing a linear amount of
    # cross-encoder time.
    #
    # 25 keeps ~8x headroom over the worst observed RRF rank. RAISE THIS AS THE
    # CORPUS GROWS: RRF precision falls as the corpus does, and the golden set is
    # where that should be caught.
    retrieval_candidates: int = 25
    rerank_top_n: int = 8
    # Below this the cross-encoder is telling us the chunk is not relevant.
    # rag.md is explicit that weak chunks are DROPPED, not used to pad context.
    #
    # Calibrated against the seed corpus over five probes, not guessed. Observed
    # rerank-v3.5 score bands:
    #   clearly relevant chunks   0.063 - 0.667
    #   related-but-wrong doc     up to 0.068
    #   an off-topic query        never above 0.015
    # 0.05 separates them: every off-topic chunk is dropped and every clearly
    # relevant one survives, and a question the corpus cannot answer returns
    # nothing at all, which is what makes the groundedness gate meaningful.
    #
    # Cohere scores are corpus-dependent. RE-CALIBRATE when the corpus grows
    # substantially; the golden set is where that should be enforced.
    rerank_min_score: float = 0.05

    # The same threshold for the LOCAL cross-encoder, and it is a separate number
    # rather than a shared one on purpose.
    #
    # Cohere and bge-reranker do not share a scale. bge returns raw logits, which
    # this codebase sigmoid-squashes into 0-1 so a threshold is expressible at
    # all, but a squashed logit near 0 lands at ~0.5 where a Cohere score for the
    # same irrelevant chunk is ~0.01. Reusing 0.05 here would admit essentially
    # every candidate, and admitting irrelevant chunks is not a quality
    # regression, it is the groundedness gate failing open: the agent would cite
    # sources that do not support what it says.
    #
    # CALIBRATED FROM MEASURED BANDS, like its Cohere counterpart, not guessed.
    # On the golden set: the broadest legitimate goal ("launch my app and get me
    # to my first 100 customers") tops out at 0.001772, and the strongest
    # negative ("run payroll and withhold taxes") reaches 0.001007. 0.0013 sits
    # between them and yields recall 1.00, coverage 1.00, zero leaks.
    #
    # **That is a 1.76x margin, against roughly 9x on Cohere.** It is the
    # narrowest safety margin in the retrieval path, and a leak is the failure
    # this system least tolerates (rule 10: uncited or unsupported claims must
    # never gate action). Treat any corpus change as a reason to re-measure, and
    # grow the golden set's NEGATIVE half rather than only its positive half,
    # because the negatives are what defend this margin.
    rerank_local_min_score: float = 0.0013

    # Client-side ceiling on rerank calls per minute. 0 means unlimited.
    #
    # Lives here, next to the call it governs, rather than in the eval harness
    # where pacing used to be. The harness paced CASES on the belief that one
    # case was one rerank call; decomposition made that one-to-many, the harness
    # could not see the difference, and CI failed. A limiter cannot be wrong
    # about a number it counts itself.
    #
    # Default 0 so production is never throttled by a development constraint. A
    # Cohere TRIAL key allows 10/minute, which the golden set exceeds many times
    # over, so CI sets this explicitly. The real fix is a production key.
    rerank_rpm: int = 0

    # Batch size for embedding calls. The API accepts arrays; sending one request
    # per chunk would be both slower and more expensive in overhead.
    embed_batch_size: int = 96

    request_timeout_s: int = 60

    tags: dict[str, str] = field(default_factory=dict)

    @property
    def active_embed_model(self) -> str:
        """The embedding model actually in use, whichever provider is selected.

        This is the identity that gets stamped on every `doc_chunks.embed_model`
        row and folded into the ingestion content hash, so a provider switch is
        both traceable after the fact and self-invalidating before it.
        """
        return self.embed_local_model if self.embed_provider == "local" else self.embed_model

    @property
    def active_rerank_model(self) -> str:
        """The reranker actually in use, whichever provider is selected."""
        return self.rerank_local_model if self.rerank_provider == "local" else self.rerank_model

    @property
    def active_rerank_min_score(self) -> float:
        """The threshold matching the active reranker's score distribution.

        Selecting this by provider rather than sharing one number is what stops a
        provider switch from silently changing what counts as "relevant enough to
        cite".
        """
        return (
            self.rerank_local_min_score
            if self.rerank_provider == "local"
            else self.rerank_min_score
        )

    @property
    def rerank_local_source(self) -> str:
        """Where to load the local reranker from: an explicit path, else the repo id."""
        return self.rerank_local_path or self.rerank_local_model

    @property
    def embed_local_source(self) -> str:
        """Where to load the local weights from: an explicit path, else the repo id.

        Kept apart from `active_embed_model` on purpose. This one may be a
        machine-specific path and must never reach the database or the hash.
        """
        return self.embed_local_path or self.embed_local_model


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load and cache settings. Raises ConfigError if anything required is missing."""
    load_local_env()

    # Required only when the hosted reranker is actually selected. A deployment
    # that has gone fully local (ADR-0009) must not be unable to boot for want of
    # a credential it will never use, and demanding one would quietly push people
    # into keeping a live key around with nothing checking that it still works.
    rerank_provider = _choice("RERANK_PROVIDER", "local", {"cohere", "local"})
    cohere_api_key = (
        _require("COHERE_API_KEY")
        if rerank_provider == "cohere"
        else os.environ.get("COHERE_API_KEY", "")
    )

    return Settings(
        supabase_url=_require("SUPABASE_URL"),
        supabase_secret_key=_require("SUPABASE_SECRET_KEY"),
        openai_api_key=_require("OPENAI_API_KEY"),
        cohere_api_key=cohere_api_key,
        embed_provider=_choice("EMBED_PROVIDER", "openai", {"openai", "local"}),
        embed_model=os.environ.get("EMBED_MODEL", "text-embedding-3-large"),
        embed_local_model=os.environ.get("EMBED_LOCAL_MODEL", "BAAI/bge-m3"),
        embed_local_path=os.environ.get("EMBED_LOCAL_PATH", ""),
        embed_dimensions=_int("EMBED_DIMENSIONS", 1024),
        embed_local_fp16=_bool("EMBED_LOCAL_FP16", True),
        rerank_model=os.environ.get("RERANK_MODEL", "rerank-v3.5"),
        rerank_provider=rerank_provider,
        rerank_local_model=os.environ.get("RERANK_LOCAL_MODEL", "BAAI/bge-reranker-v2-m3"),
        rerank_local_path=os.environ.get("RERANK_LOCAL_PATH", ""),
        rerank_local_fp16=_bool("RERANK_LOCAL_FP16", True),
        rerank_local_min_score=_float("RERANK_LOCAL_MIN_SCORE", 0.0013),
        generation_model=os.environ.get("GENERATION_MODEL", "gpt-5.4"),
        generation_model_fast=os.environ.get("GENERATION_MODEL_FAST", "gpt-5.4-mini"),
        generation_model_cheap=os.environ.get("GENERATION_MODEL_CHEAP", "gpt-5.4-nano"),
        generation_max_tokens=_int("GENERATION_MAX_TOKENS", 900),
        query_decomposition=_bool("QUERY_DECOMPOSITION", True),
        retrieval_candidates=_int("RETRIEVAL_CANDIDATES", 25),
        rerank_top_n=_int("RERANK_TOP_N", 8),
        rerank_rpm=_int("COHERE_RERANK_RPM", 0),
        embed_batch_size=_int("EMBED_BATCH_SIZE", 96),
        request_timeout_s=_int("AI_REQUEST_TIMEOUT_S", 60),
    )
