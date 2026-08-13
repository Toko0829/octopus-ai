"""What actually goes on the wire for a generation call.

These assert request parameters rather than behaviour, because the damage from
getting them wrong is invisible: the call succeeds, the response looks fine, and
only an aggregate measured over many runs shows anything is off.

That is not hypothetical. `complete_json` omitted `temperature` entirely, so it
inherited the API default of 1.0. Its only caller is query decomposition, a
classification-shaped task, and the resulting variance showed up as a golden set
that returned coverage 0.97-1.00 and MRR 0.83-0.95 across five runs of one
unchanged commit. A real regression would have been indistinguishable from
resampling.
"""

import httpx
import pytest

from octopus_ai.config import Settings
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


def _capture():
    """A transport that records the request body and returns a valid completion."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.append(_json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"stages": []}'}}]})

    return seen, httpx.MockTransport(handler)


async def test_json_completions_pin_temperature_to_zero():
    """Decomposition must not resample. Omitting this means the API default, 1.0."""
    seen, transport = _capture()
    p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
    await p.complete_json(system="s", user="u")
    await p.aclose()

    assert "temperature" in seen[0], (
        "temperature was omitted, so the provider default (1.0) applies and the "
        "same goal decomposes differently on every call"
    )
    assert seen[0]["temperature"] == 0


async def test_json_completions_request_a_json_object():
    seen, transport = _capture()
    p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
    await p.complete_json(system="s", user="u")
    await p.aclose()

    assert seen[0]["response_format"] == {"type": "json_object"}


async def test_the_caller_chooses_the_model_tier():
    """Decomposition is classification and must not silently use the planner tier."""
    seen, transport = _capture()
    s = _settings()
    p = Providers(s, client=httpx.AsyncClient(transport=transport))
    await p.complete_json(system="s", user="u", model=s.generation_model_cheap)
    await p.complete_json(system="s", user="u")
    await p.aclose()

    assert seen[0]["model"] == s.generation_model_cheap
    assert seen[1]["model"] == s.generation_model, "the default tier should be the planner's"


async def test_prose_generation_keeps_its_own_temperature():
    """`complete` is not classification, and pinning it to 0 is not implied here.

    Kept explicit so a future change to one method is not assumed to apply to
    both: they are different tasks with different tolerances for variety.
    """
    seen, transport = _capture()

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.append(_json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "text"}}]})

    p = Providers(_settings(), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    await p.complete(system="s", user="u")
    await p.aclose()

    assert seen[-1]["temperature"] == 0.3


@pytest.mark.parametrize("field", ["max_completion_tokens"])
async def test_the_gpt5_token_parameter_is_used(field):
    """`max_tokens` is rejected outright by this model family."""
    seen, transport = _capture()
    p = Providers(_settings(), client=httpx.AsyncClient(transport=transport))
    await p.complete_json(system="s", user="u")
    await p.aclose()

    assert field in seen[0]
    assert "max_tokens" not in seen[0]
