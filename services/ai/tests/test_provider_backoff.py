"""Retry/backoff behaviour for provider calls.

The property under test is that a **rate limit is not treated like a transient
5xx**. Provider quotas are quoted per minute, so retrying half a second later
cannot succeed: it spends another call against the same exhausted quota and makes
the following attempt likelier to fail too. That is not hypothetical, it is what
took down the first armed CI eval run against a Cohere trial key.

Sleeps are captured rather than performed, so the suite stays fast and stays
honest about what it asserts: the schedule, not the wall clock.
"""

import httpx
import pytest

from octopus_ai.providers import (
    _MAX_ATTEMPTS,
    _RATE_LIMIT_BACKOFF_S,
    ProviderError,
    _post_with_retry,
)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.fixture
def captured_sleeps(monkeypatch):
    """Record every backoff without waiting for it."""
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr("octopus_ai.providers.asyncio.sleep", fake_sleep)
    return waits


async def test_rate_limit_backs_off_on_a_minute_scale(captured_sleeps):
    """A 429 must wait long enough for a per-minute quota to actually recover."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    async with _client(handler) as client:
        with pytest.raises(ProviderError):
            await _post_with_retry(client, "https://x/y", headers={}, json={}, what="probe")

    assert captured_sleeps, "a 429 should have been retried at least once"
    assert all(w >= _RATE_LIMIT_BACKOFF_S for w in captured_sleeps), (
        f"429 backed off {captured_sleeps}, which is the 5xx curve. Retrying a "
        "per-minute quota in under a second burns another call and cannot succeed."
    )


async def test_server_errors_keep_the_fast_curve(captured_sleeps):
    """5xx is genuinely transient, so it must NOT inherit the rate-limit floor."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    async with _client(handler) as client:
        with pytest.raises(ProviderError):
            await _post_with_retry(client, "https://x/y", headers={}, json={}, what="probe")

    assert captured_sleeps
    assert captured_sleeps[0] < _RATE_LIMIT_BACKOFF_S, (
        "a 503 should retry quickly; slowing it to the rate-limit floor would turn "
        "a blip into a timeout inside the agent step"
    )


async def test_retry_after_header_wins_over_our_guess(captured_sleeps):
    """The provider knows its own window better than our constant does."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="slow down", headers={"retry-after": "3"})

    async with _client(handler) as client:
        with pytest.raises(ProviderError):
            await _post_with_retry(client, "https://x/y", headers={}, json={}, what="probe")

    assert captured_sleeps[0] == 3.0


async def test_a_client_error_is_not_retried_at_all(captured_sleeps):
    """A 400 means the request is wrong; retrying it only burns quota."""

    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="bad request")

    async with _client(handler) as client:
        with pytest.raises(ProviderError):
            await _post_with_retry(client, "https://x/y", headers={}, json={}, what="probe")

    assert calls["n"] == 1
    assert captured_sleeps == []


async def test_a_recovered_call_returns_its_payload(captured_sleeps):
    """The retry has to actually succeed, not merely stop raising."""
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(503, text="unavailable")
        return httpx.Response(200, json={"ok": True})

    async with _client(handler) as client:
        payload = await _post_with_retry(
            client, "https://x/y", headers={}, json={}, what="probe"
        )

    assert payload == {"ok": True}
    assert calls["n"] == 2


async def test_attempts_are_bounded(captured_sleeps):
    """Never unbounded: this runs inside an agent step with a deadline."""
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(500, text="boom")

    async with _client(handler) as client:
        with pytest.raises(ProviderError):
            await _post_with_retry(client, "https://x/y", headers={}, json={}, what="probe")

    assert calls["n"] == _MAX_ATTEMPTS
