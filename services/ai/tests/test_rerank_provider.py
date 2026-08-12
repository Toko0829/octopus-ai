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

from octopus_ai.config import ConfigError, Settings, _choice
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
    """
    threshold = _settings(rerank_provider="local").active_rerank_min_score
    assert 0.001007 < threshold < 0.001772


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
