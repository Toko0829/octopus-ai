"""Batch planning for the local cross-encoder.

No torch and no model: `plan_batches`, `restore_order` and `padding_stats` are
module-scope helpers precisely so they can be tested where torch is absent, which
is CI's `ai` job (it installs the `dev` extra only). What they must get right is
not arithmetic but bookkeeping, and the failure mode is silent: a scatter that
returns the right COUNT of scores in the wrong ORDER attaches every score to the
wrong chunk, the threshold filters them happily, and nothing downstream can tell.
"""

import pytest

from octopus_ai.local_reranker import (
    LocalRerankerError,
    padding_stats,
    plan_batches,
    restore_order,
)


def test_every_pair_appears_exactly_once():
    """The property the scatter depends on. A dropped index is an unscored chunk."""
    lengths = [10, 900, 55, 55, 3, 601, 120]
    plan = plan_batches(lengths, 3)

    flat = [i for batch in plan for i in batch]
    assert sorted(flat) == list(range(len(lengths)))
    assert len(flat) == len(set(flat))


def test_pairs_are_ordered_longest_first():
    """Longest first is what confines padding to the pairs that are genuinely long.

    It also puts peak memory in the FIRST batch, so an out-of-memory failure
    happens at the start of a request rather than three-quarters of the way
    through one.
    """
    lengths = [10, 900, 55, 601, 3]
    plan = plan_batches(lengths, 2)

    flat = [lengths[i] for batch in plan for i in batch]
    assert flat == sorted(flat, reverse=True)
    assert lengths[plan[0][0]] == 900


def test_batches_are_bounded_by_the_batch_size():
    plan = plan_batches([1] * 10, 4)
    assert [len(b) for b in plan] == [4, 4, 2]


def test_zero_batch_size_is_one_batch_which_is_the_old_behaviour():
    """The default must be byte-identical to the single forward pass it replaced.

    Sorted inside the batch, which costs nothing: one batch pads to the global
    maximum whatever the order, and `restore_order` undoes the permutation.
    """
    lengths = [10, 900, 55]
    plan = plan_batches(lengths, 0)

    assert len(plan) == 1
    assert sorted(plan[0]) == [0, 1, 2]
    assert padding_stats(lengths, plan) == padding_stats(lengths, [[0, 1, 2]])


def test_no_pairs_plans_nothing():
    assert plan_batches([], 8) == []
    assert plan_batches([], 0) == []


def test_scores_come_back_in_input_order():
    """The round trip. A permuted plan must be undone exactly."""
    plan = [[3, 0], [1, 2]]
    batched = [[0.3, 0.0], [0.1, 0.2]]

    assert restore_order(plan, batched, 4) == [0.0, 0.1, 0.2, 0.3]


def test_a_batch_that_returns_the_wrong_number_of_scores_raises():
    """Silent misalignment is the failure this guard exists for."""
    with pytest.raises(LocalRerankerError, match="2 scores for 3 pairs"):
        restore_order([[0, 1, 2]], [[0.1, 0.2]], 3)


def test_a_missing_batch_raises():
    with pytest.raises(LocalRerankerError, match="1 batches for 2 planned"):
        restore_order([[0], [1]], [[0.1]], 2)


def test_an_unscored_document_raises_rather_than_returning_none():
    """A plan that does not cover every index would otherwise yield a null score.

    Nothing downstream compares a score against a threshold expecting `None`, so
    this has to fail where it happens rather than three frames later.
    """
    with pytest.raises(LocalRerankerError, match="left 1 of 2 documents unscored"):
        restore_order([[0]], [[0.1]], 2)


def test_equal_lengths_waste_nothing():
    lengths = [600, 600, 600, 600]
    stats = padding_stats(lengths, plan_batches(lengths, 2))

    assert stats["padding_ratio"] == 0.0
    assert stats["total_tokens"] == stats["padded_tokens"] == 2400
    assert stats["pairs"] == 4
    assert stats["batches"] == 2
    assert stats["max_tokens"] == 600


def test_a_spread_of_lengths_wastes_something_and_batching_reduces_it():
    """The measurement the setting exists for, on the shape a real corpus has.

    One long chunk among short ones is what makes a single batch expensive: with
    one batch every pair is padded to the longest, so the outlier's length is paid
    for once per pair. At the production depth of 25 candidates that is 24 extra
    times; here it is four, and the shape is the same.
    """
    lengths = [900] + [100] * 4

    one_batch = padding_stats(lengths, plan_batches(lengths, 0))
    batched = padding_stats(lengths, plan_batches(lengths, 2))

    assert one_batch["padded_tokens"] == 4500
    assert one_batch["padding_ratio"] > 0.7
    # The outlier now shares a batch with one short pair instead of four:
    # 2x900 + 2x100 + 1x100 against 5x900.
    assert batched["padded_tokens"] == 2100
    assert batched["padding_ratio"] < one_batch["padding_ratio"]
    # Batching changes what is COMPUTED, never what was tokenised.
    assert batched["total_tokens"] == one_batch["total_tokens"] == 1300


def test_stats_on_no_pairs_are_zero_rather_than_a_division_error():
    assert padding_stats([], [])["padding_ratio"] == 0.0
    assert padding_stats([], [])["pairs"] == 0
