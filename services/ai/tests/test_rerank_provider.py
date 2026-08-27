"""Rerank-provider selection (ADR-0009).

No network and no torch: these assert the wiring, which is where the damaging
mistakes live. Whether bge-reranker-v2-m3 retrieves *well* is an eval-gate
question, not a unit-test one.

The load-bearing test here is that the THRESHOLD follows the provider. That is
not hypothetical: during development the local reranker was wired in while
`retrieval.py` still applied Cohere's 0.05 to bge's scores, and the golden set
came back at recall 0.45 with the banner cheerfully printing the wrong number.
Two providers whose scores are not on the same scale sharing one threshold is a
silent grounding failure, so it is pinned here.
"""

import httpx
import pytest

from octopus_ai.config import (
    RERANK_LOCAL_MIN_SCORE_DEFAULT,
    ConfigError,
    Settings,
    _choice,
    get_settings,
)
from octopus_ai.providers import Providers


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": "sk-test",
        "cohere_api_key": "co-test",
    }
    base.update(overrides)
    return Settings(**base)


def test_defaults_to_local():
    """ADR-0009 amends ADR-0007: the in-process cross-encoder is the default.

    Note what this costs, so it is not rediscovered in production: unlike the
    embedder, whose default stays `openai` precisely so a plain `uv sync` never
    needs torch, the reranker default DOES require the `local-embed` extra and
    the weights. A deployment that skips them fails at the first rerank.
    """
    s = _settings()
    assert s.rerank_provider == "local"
    assert s.active_rerank_model == "BAAI/bge-reranker-v2-m3"


def test_cohere_remains_available_as_a_fallback():
    """Kept working rather than deleted; the adapter costs nothing to retain."""
    s = _settings(rerank_provider="cohere")
    assert s.active_rerank_model == "rerank-v3.5"
    assert s.active_rerank_min_score == s.rerank_min_score


def test_threshold_follows_the_provider():
    """The bug this file exists for.

    Cohere scores relevant chunks 0.127-0.637 and off-topic ones under 0.05.
    bge returns sigmoid-squashed logits where the same separation lives three
    orders of magnitude lower (0.0013 separates them). One shared threshold
    cannot serve both.
    """
    cohere = _settings(rerank_provider="cohere")
    local = _settings(rerank_provider="local")

    assert cohere.active_rerank_min_score == cohere.rerank_min_score
    assert local.active_rerank_min_score == local.rerank_local_min_score
    assert local.active_rerank_min_score != cohere.active_rerank_min_score, (
        "the two providers share a threshold, which means one of them is being "
        "filtered against a scale that is not its own"
    )


def test_an_unknown_provider_is_rejected_rather_than_defaulted(monkeypatch):
    """A typo must fail loudly, not quietly fall back to a different model."""
    monkeypatch.setenv("RERANK_PROVIDER", "coher")
    with pytest.raises(ConfigError):
        _choice("RERANK_PROVIDER", "cohere", {"cohere", "local"})


def test_the_local_threshold_keeps_its_measured_margin():
    """A guard on the narrowest safety margin in the retrieval path.

    0.0013 sits between the broadest legitimate goal (0.001772) and the
    strongest negative (0.001007) on the golden set. Both bounds are tight, and
    the consequence of crossing the lower one is a LEAK: cited sources that do
    not support the answer. Anyone retuning this should have to change a test
    that says so.

    Raising it was tried when crawled sources grew the corpus and a car-licence
    negative began scoring 0.008. It was reverted: the positive and negative
    bands are 2.75x apart on a signal that moves 3x between identical runs, so a
    threshold cannot separate them and raising it refuses legitimate goals at
    random instead. Scope is the groundedness gate's job, which is why that leak
    now lives in `scope_negatives`.
    """
    threshold = _settings(rerank_provider="local").active_rerank_min_score
    assert 0.001007 < threshold < 0.001772


def test_the_configured_threshold_is_the_one_production_uses(monkeypatch):
    """The guard above must describe the running system, not a second copy of it.

    Every setting in `config.py` writes its default twice, on the dataclass field
    and again in `get_settings()`. For a model name that is survivable. For this
    it was not, and it was learned by doing it: the threshold was re-measured, the
    field was updated, the test above went green, and the eval kept running the
    old number because the factory still carried it. The run reported a leak that
    had already been fixed everywhere except where it counted.

    So the two are now one constant, and this asserts they cannot drift apart
    again. It reads `get_settings()`, which is the path the service actually
    takes, rather than constructing a Settings directly as the rest of this file
    does.
    """
    for key in ("RERANK_PROVIDER", "RERANK_LOCAL_MIN_SCORE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_test")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    get_settings.cache_clear()
    try:
        assert get_settings().active_rerank_min_score == RERANK_LOCAL_MIN_SCORE_DEFAULT
    finally:
        get_settings.cache_clear()


def test_local_path_is_separate_from_local_identity():
    """Same split as the embedder: identity travels, location does not."""
    s = _settings(rerank_provider="local", rerank_local_path="/models/bge")
    assert s.active_rerank_model == "BAAI/bge-reranker-v2-m3"
    assert s.rerank_local_source == "/models/bge"
    assert _settings(rerank_provider="local").rerank_local_source == "BAAI/bge-reranker-v2-m3"


async def test_local_rerank_makes_no_http_call_and_is_not_rate_limited(monkeypatch):
    """No quota exists locally, so the ceiling must not apply to it.

    Rate-limiting the local path would import a constraint that only the metered
    provider has, and at ~30s a call it would be a costly one.
    """
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not run
        calls.append(request)
        return httpx.Response(200, json={"results": []})

    # rerank_rpm is set deliberately: if the local path consulted the limiter it
    # would be held, and holding is what this asserts does not happen.
    s = _settings(rerank_provider="local", rerank_rpm=1)
    p = Providers(s, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    scored = []

    class _FakeReranker:
        def score(self, query, documents):
            scored.append((query, documents))
            # Deliberately unsorted, to prove the caller does the ordering.
            return [0.1, 0.9, 0.5]

    p._local_reranker = _FakeReranker()

    hits = await p.rerank("q", ["a", "b", "c"], top_n=2)
    await p.aclose()

    assert calls == [], "the local path made an HTTP request"
    assert scored == [("q", ["a", "b", "c"])]
    assert [h.index for h in hits] == [1, 2], "hits must come back best-first"
    assert [h.score for h in hits] == [0.9, 0.5]


async def test_local_rerank_respects_top_n_and_empty_input():
    s = _settings(rerank_provider="local")
    p = Providers(s, client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: None)))

    class _FakeReranker:
        def score(self, query, documents):
            return [float(i) for i in range(len(documents))]

    p._local_reranker = _FakeReranker()

    assert await p.rerank("q", [], top_n=5) == []
    hits = await p.rerank("q", ["a", "b", "c", "d"], top_n=2)
    await p.aclose()
    assert len(hits) == 2
    assert [h.index for h in hits] == [3, 2]
