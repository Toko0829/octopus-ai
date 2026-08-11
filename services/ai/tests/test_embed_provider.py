"""Embedding-provider selection (ADR-0008).

No network and no torch: these assert the wiring around the embedder, which is
where the damaging mistakes live. Whether bge-m3 retrieves *well* is an eval-gate
question, not a unit-test one. What is tested here is that the wrong model can
never be selected silently, and that a corpus cannot end up holding two vector
spaces at once.
"""

import pytest

from octopus_ai.config import ConfigError, Settings, _choice


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": "sk-test",
        "cohere_api_key": "co-test",
    }
    base.update(overrides)
    return Settings(**base)


def test_defaults_to_openai_so_ci_never_needs_torch():
    """The heavy path must be opt-in.

    If `local` were the default, every CI run and every plain `uv sync` would
    have to install several GB of torch to start the service at all.
    """
    assert _settings().embed_provider == "openai"
    assert _settings().active_embed_model == "text-embedding-3-large"


def test_local_provider_reports_the_local_model_identity():
    """`active_embed_model` is what gets stamped on rows and folded into the hash."""
    settings = _settings(embed_provider="local")
    assert settings.active_embed_model == "BAAI/bge-m3"


def test_local_model_is_overridable_without_touching_code():
    settings = _settings(embed_provider="local", embed_local_model="BAAI/bge-m3-custom")
    assert settings.active_embed_model == "BAAI/bge-m3-custom"


def test_model_identity_is_separate_from_where_weights_live():
    """A load path must never become the recorded model identity.

    `embed_local_path` is machine-specific: a HuggingFace cache directory here, a
    mounted volume on a server. If it leaked into `active_embed_model` it would
    be written to every doc_chunks row as provenance and folded into the content
    hash, so deploying the *same* model from a different directory would rewrite
    every row and force a full, pointless re-embed.
    """
    settings = _settings(
        embed_provider="local",
        embed_local_path="C:/some/machine/specific/snapshot/dir",
    )

    assert settings.active_embed_model == "BAAI/bge-m3"
    assert settings.embed_local_source == "C:/some/machine/specific/snapshot/dir"


def test_load_source_falls_back_to_the_repo_id():
    """With no path set, the repo id is resolved through the HF cache."""
    settings = _settings(embed_provider="local")
    assert settings.embed_local_source == "BAAI/bge-m3"


def test_dimensions_are_1024_for_either_provider():
    """The shared constraint that lets halfvec(1024) survive the switch.

    bge-m3's hidden_size is 1024 and OpenAI is requested at dimensions=1024, so
    doc_chunks.embedding and the HNSW index are unchanged by the choice.
    """
    assert _settings().embed_dimensions == 1024
    assert _settings(embed_provider="local").embed_dimensions == 1024


def test_unknown_provider_is_rejected_not_defaulted(monkeypatch):
    """A typo must fail loudly.

    Falling back to the default would embed a corpus with a model nobody chose,
    and the only symptom would be worse answers.
    """
    monkeypatch.setenv("EMBED_PROVIDER", "openal")
    with pytest.raises(ConfigError) as exc:
        _choice("EMBED_PROVIDER", "openai", {"openai", "local"})
    assert "EMBED_PROVIDER" in str(exc.value)


def test_known_providers_are_accepted(monkeypatch):
    for value in ("openai", "local"):
        monkeypatch.setenv("EMBED_PROVIDER", value)
        assert _choice("EMBED_PROVIDER", "openai", {"openai", "local"}) == value


def test_local_embedder_is_not_imported_unless_selected():
    """torch must stay off the import path for the default configuration.

    providers.py imports the local embedder inside the function body precisely so
    that `import octopus_ai.providers` stays cheap and dependency-free.
    """
    import octopus_ai.providers as providers

    source = __import__("inspect").getsource(providers)
    assert "from .local_embedder import" in source
    # Module scope must stay clean; the import belongs inside _embed_local.
    header = source.split("class Providers")[0]
    assert "local_embedder" not in header
