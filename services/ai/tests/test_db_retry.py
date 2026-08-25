"""Retry behaviour for PostgREST calls.

This client had no retry at all while `providers.py` had a carefully tuned one,
and the asymmetry cost a CI run. One eval shard hit
`401 PGRST303 "JWT issued at future"`, died on the first response, and because
`--merge` refuses to report unless every golden case is present, one lost shard
took the whole retrieval gate red. The other four shards passed on the same
static credential in the same second, which is what identifies the cause: the
token's `iat` cannot vary, so the clock is what varied, across Supabase's
PostgREST nodes.

The two properties asserted here fail in opposite directions. **A transient must
be retried**, or one unlucky response kills a gate. **A real 401 must not be**,
or a wrong key costs three attempts and reports a confusing timeout instead of
"your credential is wrong".

Sleeps are captured rather than performed, so the suite asserts the schedule
rather than waiting for it.
"""

import httpx
import pytest

from octopus_ai.config import Settings
from octopus_ai.db import _MAX_ATTEMPTS, Database, DatabaseError

# PostgREST's real shape for the failure that prompted this.
CLOCK_SKEW_BODY = '{"code":"PGRST303","details":null,"hint":null,"message":"JWT issued at future"}'


def _db(handler) -> Database:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="sb_secret_test",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
    )
    return Database(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.fixture
def captured_sleeps(monkeypatch):
    """Record every backoff without waiting for it."""
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr("octopus_ai.db.asyncio.sleep", fake_sleep)
    return waits


async def test_a_skewed_clock_is_retried_and_succeeds(captured_sleeps):
    """The exact CI failure: one node answers 401 PGRST303, the next does not."""
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(401, text=CLOCK_SKEW_BODY)
        return httpx.Response(200, json=[{"id": "chunk-1"}])

    rows = await _db(handler)._request("POST", "/rest/v1/rpc/hybrid_search", json={})

    assert rows == [{"id": "chunk-1"}]
    assert calls["n"] == 2
    assert captured_sleeps == [0.5]


async def test_an_ordinary_401_fails_immediately(captured_sleeps):
    """A wrong key is not a transient, and pretending otherwise hides it.

    Retrying would spend three attempts to arrive at a slower, vaguer version of
    "your credential is wrong". Only PGRST303 is exempt, and only because its
    cause is a clock rather than the credential.
    """
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, text='{"message":"Invalid API key"}')

    with pytest.raises(DatabaseError, match="Invalid API key"):
        await _db(handler)._request("GET", "/rest/v1/documents")

    assert calls["n"] == 1
    assert captured_sleeps == []


async def test_a_5xx_is_retried_with_growing_backoff(captured_sleeps):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream unavailable")

    with pytest.raises(DatabaseError, match="503"):
        await _db(handler)._request("GET", "/rest/v1/documents")

    assert captured_sleeps == [0.5, 1.0]


async def test_a_transport_error_is_retried_then_reported(captured_sleeps):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(DatabaseError, match="transport error"):
        await _db(handler)._request("GET", "/rest/v1/documents")

    assert len(captured_sleeps) == _MAX_ATTEMPTS - 1


async def test_a_400_is_not_retried():
    """Our request is malformed. Sending it again cannot make it correct."""
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, text="invalid input syntax")

    with pytest.raises(DatabaseError, match="400"):
        await _db(handler)._request("POST", "/rest/v1/rpc/hybrid_search", json={})

    assert calls["n"] == 1


async def test_an_empty_body_still_returns_none_after_the_retry_rewrite():
    """A 204 is a normal outcome for a write, and the loop must not lose it."""
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    assert await _db(handler)._request("POST", "/rest/v1/events", json={}) is None
