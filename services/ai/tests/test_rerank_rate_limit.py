"""The client-side ceiling on rerank calls.

The property under test is that the limiter counts CALLS, not callers and not
eval cases. That distinction is the whole reason it exists: pacing used to live
in the eval harness and counted cases, which was correct until query
decomposition made one case cost up to seven rerank calls. The harness could not
see the difference and CI failed on a quota it believed it was respecting.

Time is faked rather than waited on, so these assert the schedule rather than the
wall clock, matching test_provider_backoff.py.
"""

import asyncio

import pytest

from octopus_ai.providers import _RateLimiter


@pytest.fixture
def fake_clock(monkeypatch):
    """A monotonic clock that only advances when a sleep is awaited."""
    now = {"t": 1000.0}
    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)
        now["t"] += seconds

    monkeypatch.setattr("octopus_ai.providers.time.monotonic", lambda: now["t"])
    monkeypatch.setattr("octopus_ai.providers.asyncio.sleep", fake_sleep)
    return now, waits


async def test_zero_means_unlimited(fake_clock):
    """Production must not inherit a development constraint."""
    _now, waits = fake_clock
    limiter = _RateLimiter(0)

    for _ in range(100):
        await limiter.acquire()

    assert waits == [], "an unlimited limiter must never hold a call"


async def test_calls_up_to_the_limit_do_not_wait(fake_clock):
    _now, waits = fake_clock
    limiter = _RateLimiter(8)

    for _ in range(8):
        await limiter.acquire()

    assert waits == []


async def test_the_ninth_call_waits_out_the_window(fake_clock):
    """The limit is per rolling minute, so exceeding it waits on a minute scale."""
    _now, waits = fake_clock
    limiter = _RateLimiter(8)

    for _ in range(9):
        await limiter.acquire()

    assert len(waits) == 1
    assert waits[0] == pytest.approx(60.0), (
        f"held {waits[0]}s. A per-minute quota recovers on a minute scale; a "
        "shorter hold spends another call against the same exhausted window."
    )


async def test_a_burst_from_one_goal_is_held_the_same_as_separate_calls(fake_clock):
    """The regression that broke CI, stated as a test.

    Decomposition fires the goal plus up to six sub-queries back to back with no
    pause between them. Whether those seven calls come from one retrieve() or
    from seven must make no difference: the quota counts calls.
    """
    _now, waits = fake_clock
    limiter = _RateLimiter(8)

    # Two goals, seven rerank calls each: 14 calls against a limit of 8.
    for _ in range(14):
        await limiter.acquire()

    assert waits, "14 calls against a limit of 8 must have been held at least once"
    assert sum(waits) >= 60.0


async def test_the_window_slides_rather_than_resetting(fake_clock):
    """Calls that have aged out stop counting, so throughput recovers."""
    now, waits = fake_clock
    limiter = _RateLimiter(8)

    for _ in range(8):
        await limiter.acquire()

    # Nothing acquired for over a minute: the window should be empty again.
    now["t"] += 61.0
    for _ in range(8):
        await limiter.acquire()

    assert waits == [], "a fully-aged window must not hold anything"


async def test_concurrent_callers_are_serialised(fake_clock):
    """Waiters must wake one at a time, not all at once into the same window.

    Without the lock spanning the wait, every held coroutine would re-check a
    freshly-cleared window together and breach the limit in unison.
    """
    _now, _waits = fake_clock
    limiter = _RateLimiter(4)
    order: list[int] = []

    async def caller(i: int) -> None:
        await limiter.acquire()
        order.append(i)

    await asyncio.gather(*(caller(i) for i in range(12)))

    assert order == list(range(12)), (
        "callers were not served in arrival order, so the limiter is not serialising waiters"
    )
