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


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_secret_key: str

    openai_api_key: str
    cohere_api_key: str

    # ADR-0007. The embedding model and its dimension count are a matched pair:
    # doc_chunks.embedding is halfvec(1024), and one model must cover the whole
    # corpus, so changing either means re-embedding everything.
    embed_model: str = "text-embedding-3-large"
    embed_dimensions: int = 1024
    rerank_model: str = "rerank-v3.5"

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
    retrieval_candidates: int = 40
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

    # Batch size for embedding calls. The API accepts arrays; sending one request
    # per chunk would be both slower and more expensive in overhead.
    embed_batch_size: int = 96

    request_timeout_s: int = 60

    tags: dict[str, str] = field(default_factory=dict)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Load and cache settings. Raises ConfigError if anything required is missing."""
    load_local_env()
    return Settings(
        supabase_url=_require("SUPABASE_URL"),
        supabase_secret_key=_require("SUPABASE_SECRET_KEY"),
        openai_api_key=_require("OPENAI_API_KEY"),
        cohere_api_key=_require("COHERE_API_KEY"),
        embed_model=os.environ.get("EMBED_MODEL", "text-embedding-3-large"),
        embed_dimensions=_int("EMBED_DIMENSIONS", 1024),
        rerank_model=os.environ.get("RERANK_MODEL", "rerank-v3.5"),
        generation_model=os.environ.get("GENERATION_MODEL", "gpt-5.4"),
        generation_model_fast=os.environ.get("GENERATION_MODEL_FAST", "gpt-5.4-mini"),
        generation_model_cheap=os.environ.get("GENERATION_MODEL_CHEAP", "gpt-5.4-nano"),
        generation_max_tokens=_int("GENERATION_MAX_TOKENS", 900),
        retrieval_candidates=_int("RETRIEVAL_CANDIDATES", 40),
        rerank_top_n=_int("RERANK_TOP_N", 8),
        embed_batch_size=_int("EMBED_BATCH_SIZE", 96),
        request_timeout_s=_int("AI_REQUEST_TIMEOUT_S", 60),
    )
