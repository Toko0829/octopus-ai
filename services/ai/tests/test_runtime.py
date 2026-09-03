"""The thread budget, and the division that lets a fan-out exist at all.

Torch is faked rather than imported. CI's `ai` job installs the `dev` extra only,
and the whole reason `thread_budget` is a separate pure function is so the
arithmetic that decides how much of the box a pass gets can be checked where the
box has no torch on it.
"""

import sys

from octopus_ai.config import Settings
from octopus_ai.runtime import configure_torch_threads, thread_budget


def _settings(**overrides) -> Settings:
    base = {
        "supabase_url": "https://example.supabase.co",
        "supabase_secret_key": "secret",
        "openai_api_key": "sk-test",
        "cohere_api_key": "co-test",
    }
    base.update(overrides)
    return Settings(**base)


class _FakeTorch:
    """Just enough torch to record what was asked of it."""

    def __init__(self, default: int = 12) -> None:
        self._threads = default
        self.set_calls: list[int] = []

    def get_num_threads(self) -> int:
        return self._threads

    def set_num_threads(self, n: int) -> None:
        self.set_calls.append(n)
        self._threads = n


def test_fanout_one_leaves_the_budget_whole():
    """The default has to be today's behaviour exactly, or nothing else is safe."""
    assert thread_budget(16, 1, 12) == 16


def test_the_budget_is_divided_by_the_fanout():
    """K concurrent passes at budget/K sum back to the budget.

    That is the entire premise: `torch.set_num_threads` is process-global and an
    OpenMP team is per calling thread, so concurrent passes each claim the
    configured count. Multiplying demand instead of dividing it is what makes a
    bare `gather` slower rather than faster.
    """
    assert thread_budget(16, 2, 12) == 8


def test_an_awkward_ratio_leaves_a_core_idle_rather_than_oversubscribing():
    """16 // 3 is 5, so one thread of sixteen goes unused at fanout 3.

    Recorded rather than rounded up: rounding up would put 18 threads of demand on
    a 16-thread box, and past saturation the threads contend and every pass gets
    slower. Waste is the cheaper error. The bench prints this number per row so
    the cost of an odd fan-out is visible in the measurement.
    """
    assert thread_budget(16, 3, 12) == 5


def test_a_pass_always_gets_at_least_one_thread():
    """`16 // 24` is 0, and a pass with no threads is not a pass."""
    assert thread_budget(1, 4, 12) == 1
    assert thread_budget(16, 24, 12) == 1


def test_an_unset_budget_divides_torchs_own_default():
    """Unset plus a fan-out must divide something, or the passes oversubscribe.

    Skipping instead would let three concurrent passes each claim torch's full
    default on a box nobody configured, which is slower than either setting alone.
    """
    assert thread_budget(0, 2, 12) == 6


def test_the_configured_budget_reaches_torch(monkeypatch):
    fake = _FakeTorch()
    monkeypatch.setitem(sys.modules, "torch", fake)

    configure_torch_threads(
        _settings(rerank_provider="local", torch_num_threads=16, rerank_fanout=2)
    )

    assert fake.set_calls == [8]


def test_hosted_providers_never_touch_torch(monkeypatch):
    """`local_embedder` and `local_reranker` stay out of the import graph on purpose.

    A deployment on hosted providers must not pay for torch, which means this
    function must not import it, which means the guard is the import boundary
    rather than a nicety.
    """
    fake = _FakeTorch()
    monkeypatch.setitem(sys.modules, "torch", fake)

    configure_torch_threads(
        _settings(
            embed_provider="openai",
            rerank_provider="cohere",
            torch_num_threads=16,
            rerank_fanout=4,
        )
    )

    assert fake.set_calls == []


def test_an_unset_budget_with_no_fanout_leaves_torch_alone(monkeypatch):
    """The opt-in property. A CLI that has chosen nothing must change nothing."""
    fake = _FakeTorch()
    monkeypatch.setitem(sys.modules, "torch", fake)

    configure_torch_threads(_settings(rerank_provider="local", torch_num_threads=0))

    assert fake.set_calls == []


def test_a_fanout_without_a_budget_still_divides(monkeypatch):
    """The case the early return used to swallow.

    Before the fan-out existed, `torch_num_threads <= 0` meant "return". Keeping
    that would have let `RERANK_FANOUT=2` with no explicit budget run two passes
    each claiming torch's whole default.
    """
    fake = _FakeTorch(default=12)
    monkeypatch.setitem(sys.modules, "torch", fake)

    configure_torch_threads(
        _settings(rerank_provider="local", torch_num_threads=0, rerank_fanout=2)
    )

    assert fake.set_calls == [6]


def test_calling_twice_is_safe(monkeypatch):
    """It is called from five entry points and some processes hit more than one.

    `set_num_interop_threads` is deliberately absent for exactly this reason: it
    raises once the interop pool has started, so a second call in one process
    would be a crash rather than a no-op.
    """
    fake = _FakeTorch()
    monkeypatch.setitem(sys.modules, "torch", fake)
    settings = _settings(rerank_provider="local", torch_num_threads=16, rerank_fanout=2)

    configure_torch_threads(settings)
    configure_torch_threads(settings)

    assert fake.set_calls == [8, 8]
