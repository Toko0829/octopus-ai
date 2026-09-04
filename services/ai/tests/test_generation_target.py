"""What each dialect actually puts on the wire.

The same argument as `test_generation_call_shape.py`, one vendor wider. A wrong
request parameter here does not raise: the call succeeds, the reply looks fine,
and something is quietly not applied. Google's OpenAI-compatibility layer is not
used for exactly that reason, and `temperature` on the house path was already
this project's own worked example of the failure.

Three of these assert an ABSENCE, which is the class that rots first:

- Anthropic must never receive `temperature`, because the models a workspace is
  most likely to connect reject every value but 1.0 with a 400.
- Nothing may receive the server's own key once a target is present, or a
  customer would be billed for us or, worse, we for them.
- `response_format` belongs only to the OpenAI dialect in JSON mode; the other
  two ask for JSON in the instruction channel and unwrap the answer.
"""

import json

import httpx
import pytest

from octopus_ai.config import Settings
from octopus_ai.providers import (
    ANTHROPIC_VERSION,
    ProviderError,
    Providers,
)
from octopus_ai.schemas import GenerationTarget

HOUSE_KEY = "sk-house-must-not-leak"
CUSTOMER_KEY = "sk-customer-abc123"


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": HOUSE_KEY,
        "cohere_api_key": "co-test",
    }
    base.update(overrides)
    return Settings(**base)


def _target(vendor: str, **overrides) -> GenerationTarget:
    base = {
        "vendor": vendor,
        "provider": {"openai_compatible": "openai"}.get(vendor, vendor),
        "model": f"{vendor}-test-model",
        "api_key": CUSTOMER_KEY,
    }
    base.update(overrides)
    return GenerationTarget(**base)


def _capture(response: dict):
    """A transport that records every request and answers with `response`."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=response)

    return seen, httpx.MockTransport(handler)


def _providers(response: dict, settings: Settings | None = None):
    seen, transport = _capture(response)
    p = Providers(settings or _settings(), client=httpx.AsyncClient(transport=transport))
    return seen, p


OPENAI_REPLY = {"choices": [{"message": {"content": '{"ok": true}'}}]}
ANTHROPIC_REPLY = {"stop_reason": "end_turn", "content": [{"type": "text", "text": '{"ok": true}'}]}
GOOGLE_REPLY = {
    "steps": [{"type": "model_output", "content": [{"type": "text", "text": '{"ok": true}'}]}]
}


def _body(request: httpx.Request) -> dict:
    return json.loads(request.content)


# ------------------------------------------------------------ openai ----


async def test_openai_compatible_posts_chat_completions_with_the_customer_key():
    seen, p = _providers(OPENAI_REPLY)
    await p.complete_json(system="s", user="u", target=_target("openai_compatible"))
    await p.aclose()

    assert str(seen[0].url) == "https://api.openai.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == f"Bearer {CUSTOMER_KEY}"
    body = _body(seen[0])
    assert body["model"] == "openai_compatible-test-model"
    assert body["response_format"] == {"type": "json_object"}
    assert body["temperature"] == 0
    assert "max_completion_tokens" in body and "max_tokens" not in body


async def test_a_base_url_moves_the_endpoint_and_nothing_else():
    """The seam a self-hosted or gateway endpoint arrives through."""
    seen, p = _providers(OPENAI_REPLY)
    await p.complete_json(
        system="s",
        user="u",
        target=_target("openai_compatible", base_url="https://gateway.internal/v1/"),
    )
    await p.aclose()

    assert str(seen[0].url) == "https://gateway.internal/v1/chat/completions"


async def test_prose_mode_asks_for_no_json_object():
    """`response_format` is the one parameter that must not survive into prose."""
    seen, p = _providers({"choices": [{"message": {"content": "a paragraph"}}]})
    await p.complete(system="s", user="u", target=_target("openai_compatible"))
    await p.aclose()

    body = _body(seen[0])
    assert "response_format" not in body
    assert body["temperature"] == 0.3


# --------------------------------------------------------- anthropic ----


async def test_anthropic_never_sends_temperature():
    """Models after Opus 4.6 reject every value but 1.0 with a 400.

    So the house path's 0 and 0.3 would both fail on exactly the models this
    dialect exists to reach. Not sending the parameter is the fix, and it is
    invisible in a passing response, which is why it is asserted here.
    """
    seen, p = _providers(ANTHROPIC_REPLY)
    await p.complete_json(system="s", user="u", target=_target("anthropic"))
    await p.complete(system="s", user="u", target=_target("anthropic"))
    await p.aclose()

    assert "temperature" not in _body(seen[0])
    assert "temperature" not in _body(seen[1])


async def test_anthropic_headers_and_top_level_system():
    seen, p = _providers(ANTHROPIC_REPLY)
    await p.complete_json(system="the instructions", user="u", target=_target("anthropic"))
    await p.aclose()

    assert str(seen[0].url) == "https://api.anthropic.com/v1/messages"
    assert seen[0].headers["x-api-key"] == CUSTOMER_KEY
    assert seen[0].headers["anthropic-version"] == ANTHROPIC_VERSION
    body = _body(seen[0])
    # Rule 8: the instruction channel is structurally separate from the turn
    # carrying untrusted sources, rather than merely first in a list.
    assert body["system"].startswith("the instructions")
    assert body["messages"] == [{"role": "user", "content": "u"}]


async def test_anthropic_gets_headroom_for_thinking_on_top_of_the_budget():
    """Adaptive thinking spends `max_tokens`, so the caller's budget is not the cap.

    Without this a 4000-token plan budget is spent thinking and the JSON arrives
    truncated, which is the exact failure `generation_max_tokens_long` exists to
    prevent on the house path.

    **The headroom is 12000 because 4000 was measured too small**, not because a
    round number was wanted. Sonnet 5 was seen thinking 7191 tokens on a 16-chunk
    prompt, which left 809 of the old 8000 cap for a plan that needs about 2500;
    the reply truncated and the eval read it as the model failing to make a card.
    Asserted as the sum rather than as the constant so the arithmetic the caller
    depends on is what breaks if somebody changes either half.
    """
    seen, p = _providers(ANTHROPIC_REPLY)
    await p.complete_json(system="s", user="u", max_tokens=4000, target=_target("anthropic"))
    await p.aclose()

    assert _body(seen[0])["max_tokens"] == 4000 + 12000


async def test_a_truncated_anthropic_reply_is_an_error_and_not_an_answer():
    """`ProviderError` is what makes the planner retry and then fall to prose."""
    reply = {"stop_reason": "max_tokens", "content": [{"type": "text", "text": '{"partial'}]}
    _, p = _providers(reply)
    with pytest.raises(ProviderError, match="truncated"):
        await p.complete_json(system="s", user="u", target=_target("anthropic"))
    await p.aclose()


async def test_a_refusal_is_an_error_rather_than_an_empty_plan():
    reply = {"stop_reason": "refusal", "content": []}
    _, p = _providers(reply)
    with pytest.raises(ProviderError):
        await p.complete(system="s", user="u", target=_target("anthropic"))
    await p.aclose()


async def test_only_the_text_blocks_are_the_answer():
    """A thinking block beside the text must not become part of the reply."""
    reply = {
        "stop_reason": "end_turn",
        "content": [
            {"type": "thinking", "thinking": "not for the room"},
            {"type": "text", "text": "first half. "},
            {"type": "text", "text": "second half."},
        ],
    }
    _, p = _providers(reply)
    out = await p.complete(system="s", user="u", target=_target("anthropic"))
    await p.aclose()

    assert out == "first half. second half."
    assert "not for the room" not in out


# ------------------------------------------------------------ google ----


async def test_google_posts_an_interaction_with_the_key_header():
    seen, p = _providers(GOOGLE_REPLY)
    await p.complete_json(system="s", user="u", max_tokens=900, target=_target("google"))
    await p.aclose()

    assert str(seen[0].url) == "https://generativelanguage.googleapis.com/v1beta/interactions"
    assert seen[0].headers["x-goog-api-key"] == CUSTOMER_KEY
    body = _body(seen[0])
    assert body["model"] == "google-test-model"
    assert body["input"] == "u"
    assert body["system_instruction"].startswith("s")
    assert body["generation_config"] == {"temperature": 0, "max_output_tokens": 900}


async def test_google_text_is_read_out_of_the_steps():
    reply = {
        "steps": [
            {"type": "model_output", "content": [{"type": "text", "text": "hello "}]},
            {"type": "model_output", "content": [{"type": "text", "text": "world"}]},
        ]
    }
    _, p = _providers(reply)
    assert await p.complete(system="s", user="u", target=_target("google")) == "hello world"
    await p.aclose()


async def test_google_falls_back_to_the_output_text_helper():
    """Only when the steps carry nothing, since the helper is not promised."""
    _, p = _providers({"steps": [], "output_text": "from the helper"})
    assert await p.complete(system="s", user="u", target=_target("google")) == "from the helper"
    await p.aclose()


# -------------------------------------------------------------- fake ----


async def test_the_fake_vendor_never_touches_the_transport():
    seen, p = _providers(OPENAI_REPLY)
    raw = await p.complete_json(system="s", user="u", target=_target("fake"))
    prose = await p.complete(system="s", user="u", target=_target("fake"))
    await p.aclose()

    assert seen == []
    assert json.loads(raw)["title"]
    assert "fake-test-model" in prose


# ------------------------------------------------- cross-cutting ----


@pytest.mark.parametrize(
    "vendor,reply",
    [
        ("openai_compatible", OPENAI_REPLY),
        ("anthropic", ANTHROPIC_REPLY),
        ("google", GOOGLE_REPLY),
    ],
)
async def test_the_house_key_reaches_no_header_once_a_target_is_present(vendor, reply):
    """A customer must never be billed for us, nor we for them."""
    seen, p = _providers(reply)
    await p.complete_json(system="s", user="u", target=_target(vendor))
    await p.aclose()

    assert HOUSE_KEY not in json.dumps(dict(seen[0].headers))
    assert HOUSE_KEY not in seen[0].content.decode()


@pytest.mark.parametrize(
    "vendor,reply",
    [("anthropic", ANTHROPIC_REPLY), ("google", GOOGLE_REPLY)],
)
async def test_json_is_asked_for_in_the_instruction_channel_only_in_json_mode(vendor, reply):
    """Neither vendor has a cheap `json_object`, so the ask is an instruction.

    It goes on the SYSTEM prompt rather than the user turn: an instruction in the
    turn that carries retrieved sources is an instruction inside untrusted data.
    """
    seen, p = _providers(reply)
    await p.complete_json(system="s", user="u", target=_target(vendor))
    await p.complete(system="s", user="u", target=_target(vendor))
    await p.aclose()

    field = "system" if vendor == "anthropic" else "system_instruction"
    assert "one JSON object" in _body(seen[0])[field]
    assert "one JSON object" not in _body(seen[1])[field]
    assert "one JSON object" not in _body(seen[0])["input" if vendor == "google" else "messages"][0]


async def test_a_fenced_object_is_unwrapped_rather_than_thrown_away():
    """A model obeying "reply with JSON" inside a fence has complied, not failed."""
    reply = {
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": '```json\n{"stages": []}\n```'}],
    }
    _, p = _providers(reply)
    raw = await p.complete_json(system="s", user="u", target=_target("anthropic"))
    await p.aclose()

    assert json.loads(raw) == {"stages": []}


async def test_an_empty_completion_is_an_error_on_every_dialect():
    for vendor, reply in (
        ("openai_compatible", {"choices": [{"message": {"content": "  "}}]}),
        ("anthropic", {"stop_reason": "end_turn", "content": []}),
        ("google", {"steps": []}),
    ):
        _, p = _providers(reply)
        with pytest.raises(ProviderError):
            await p.complete(system="s", user="u", target=_target(vendor))
        await p.aclose()


async def test_no_target_produces_exactly_the_call_it_always_did():
    """The house default has to stay byte-identical, or "Auto" is a change.

    A workspace that connects nothing is the majority case and the one nobody
    would be watching, so this is the regression that would ship silently.
    """
    seen, p = _providers(OPENAI_REPLY)
    s = _settings()
    await p.complete_json(system="s", user="u")
    await p.complete(system="s", user="u")
    await p.aclose()

    assert str(seen[0].url) == "https://api.openai.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == f"Bearer {HOUSE_KEY}"
    assert _body(seen[0]) == {
        "model": s.generation_model,
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_completion_tokens": s.generation_max_tokens,
    }
    assert _body(seen[1]) == {
        "model": s.generation_model,
        "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
        "temperature": 0.3,
        "max_completion_tokens": s.generation_max_tokens,
    }
