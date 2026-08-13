"""Sharding the eval must not weaken the gate.

Splitting a gate across runners is a wall-clock optimisation with one dangerous
failure mode: a shard that never reports. Nothing errors, the merge sees fewer
cases, the denominator shrinks, and a green check is returned over a set nobody
measured in full. These tests exist for that, not for the arithmetic.

The two invariants:
  1. The split is a **partition** — every case in exactly one shard.
  2. The merge **refuses** anything but exact coverage of the golden set.
"""

import json

import pytest

from octopus_ai.evaluation import (
    MAX_NEGATIVE_LEAKS,
    MIN_POSITIVE_RECALL,
    CaseResult,
    EvalReport,
    GoldenCase,
    IncompleteShardsError,
    load_golden,
    merge_shards,
    result_to_dict,
    split_cases,
)


def _case(i: int, negative: bool = False) -> GoldenCase:
    return GoldenCase(id=f"c{i}", query=f"q{i}", expect_docs=[] if negative else [f"Doc {i}"])


def _result(case: GoldenCase, hit: bool) -> CaseResult:
    titles = list(case.expect_docs) if hit else []
    return CaseResult(
        case=case,
        retrieved_titles=titles,
        top_score=0.5 if titles else None,
        candidates=25,
        dropped=0,
    )


@pytest.mark.parametrize("shards", [1, 2, 3, 4, 5, 7])
def test_the_split_is_a_partition(shards):
    """Every case exactly once, across any shard count the set might use."""
    cases = [_case(i, negative=i % 4 == 0) for i in range(15)]
    seen = []
    for s in range(1, shards + 1):
        seen.extend(c.id for c in split_cases(cases, s, shards))

    assert sorted(seen) == sorted(c.id for c in cases)
    assert len(seen) == len(set(seen)), "a case landed in more than one shard"


def test_shards_are_round_robin_so_none_is_all_negatives():
    """A shard with no positives cannot fail for the reason the gate exists.

    Contiguous slicing would hand one shard only the negatives, which sit
    together at the end of the golden set.
    """
    cases = load_golden()
    for s in range(1, 4):
        subset = split_cases(cases, s, 3)
        assert any(not c.is_negative for c in subset), f"shard {s}/3 has no positive cases"


def test_out_of_range_shards_are_rejected():
    cases = [_case(i) for i in range(4)]
    for bad in [(0, 3), (4, 3), (1, 0), (-1, 2)]:
        with pytest.raises(ValueError):
            split_cases(cases, *bad)


def _write(tmp_path, name, results):
    p = tmp_path / name
    p.write_text(json.dumps({"results": [result_to_dict(r) for r in results]}), encoding="utf-8")
    return p


def test_merge_rebuilds_the_whole_report(tmp_path):
    cases = [_case(i, negative=i % 4 == 0) for i in range(8)]
    shards = [split_cases(cases, s, 3) for s in (1, 2, 3)]
    paths = [
        _write(tmp_path, f"s{i}.json", [_result(c, hit=True) for c in sh])
        for i, sh in enumerate(shards)
    ]

    report = merge_shards(paths, cases=cases)

    assert len(report.results) == len(cases)
    assert [r.case.id for r in report.results] == [c.id for c in cases], "golden order not restored"
    assert report.positive_recall == 1.0
    assert report.passed


def test_a_missing_shard_refuses_rather_than_reporting_green(tmp_path):
    """The failure this file exists for.

    A crashed or skipped shard must not simply shrink the denominator. Without
    this check the remaining shards could pass and the gate would report success
    over a set it never fully ran.
    """
    cases = [_case(i, negative=i % 4 == 0) for i in range(8)]
    shards = [split_cases(cases, s, 3) for s in (1, 2, 3)]
    # Shard 3 never reported.
    paths = [
        _write(tmp_path, f"s{i}.json", [_result(c, hit=True) for c in sh])
        for i, sh in enumerate(shards[:2])
    ]

    with pytest.raises(IncompleteShardsError) as exc:
        merge_shards(paths, cases=cases)
    assert "missing" in str(exc.value)


def test_a_duplicated_case_is_refused(tmp_path):
    cases = [_case(i) for i in range(4)]
    dup = [_result(cases[0], hit=True)]
    paths = [
        _write(tmp_path, "a.json", [_result(c, hit=True) for c in cases]),
        _write(tmp_path, "b.json", dup),
    ]

    with pytest.raises(IncompleteShardsError):
        merge_shards(paths, cases=cases)


def test_an_unexpected_case_is_refused(tmp_path):
    """A stale artifact from an older golden set must not be silently accepted."""
    cases = [_case(i) for i in range(4)]
    stale = _result(_case(99), hit=True)
    paths = [_write(tmp_path, "a.json", [_result(c, hit=True) for c in cases] + [stale])]

    with pytest.raises(IncompleteShardsError) as exc:
        merge_shards(paths, cases=cases)
    assert "unexpected" in str(exc.value)


def test_the_merged_verdict_matches_an_unsharded_run(tmp_path):
    """Sharding must be invisible to the outcome, including when it fails."""
    cases = [_case(i, negative=i % 4 == 0) for i in range(12)]
    # Two positives miss: recall 8/9 = 0.889, still above the floor.
    results = [_result(c, hit=c.id not in {"c1", "c2"}) for c in cases]
    direct = EvalReport(results=results)

    by_shard = {s: [] for s in (1, 2, 3)}
    for s in (1, 2, 3):
        ids = {c.id for c in split_cases(cases, s, 3)}
        by_shard[s] = [r for r in results if r.case.id in ids]
    paths = [_write(tmp_path, f"s{s}.json", by_shard[s]) for s in (1, 2, 3)]

    merged = merge_shards(paths, cases=cases)

    assert merged.positive_recall == direct.positive_recall
    assert merged.mrr == direct.mrr
    assert merged.mean_coverage == direct.mean_coverage
    assert merged.passed == direct.passed


def test_a_leak_in_any_single_shard_fails_the_merged_gate(tmp_path):
    """Negatives have zero tolerance, and sharding must not dilute that."""
    cases = [_case(i, negative=i % 4 == 0) for i in range(12)]
    leaking = _case(0, negative=True)
    results = []
    for c in cases:
        if c.id == leaking.id:
            results.append(
                CaseResult(
                    case=c, retrieved_titles=["Some doc"], top_score=0.9, candidates=25, dropped=0
                )
            )
        else:
            results.append(_result(c, hit=True))

    by_shard = {}
    for s in (1, 2, 3):
        ids = {c.id for c in split_cases(cases, s, 3)}
        by_shard[s] = [r for r in results if r.case.id in ids]
    paths = [_write(tmp_path, f"s{s}.json", by_shard[s]) for s in (1, 2, 3)]

    merged = merge_shards(paths, cases=cases)

    assert len(merged.leaks) == 1
    assert not merged.passed, f"a leak survived the merge (max allowed {MAX_NEGATIVE_LEAKS})"


def test_thresholds_are_unchanged_by_this_work():
    """Guards against the gate being loosened while making it faster."""
    assert MIN_POSITIVE_RECALL == 0.8
    assert MAX_NEGATIVE_LEAKS == 0
