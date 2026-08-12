"""Query decomposition.

The properties asserted here are the ones whose violation is silent: a
decomposition that drops the original goal narrows retrieval instead of widening
it, and one that raises turns an optimisation into an outage.
"""

import json

import pytest

from octopus_ai.decompose import MAX_SUBQUERIES, decompose, parse_subqueries


class StubProviders:
    """Stands in for the model. Returns canned JSON, or raises."""

    def __init__(self, payload: str | None = None, error: Exception | None = None):
        self.payload = payload
        self.error = error
        self.calls = 0

    async def complete_json(self, *, system: str, user: str, model: str | None = None) -> str:
        self.calls += 1
        if self.error:
            raise self.error
        return self.payload or "{}"


async def test_the_goal_is_always_first_and_always_present():
    """Decomposition must be strictly additive.

    The union of results can then only be a superset of what the bare goal would
    have found, so this can widen coverage but never lose a result that already
    worked.
    """
    providers = StubProviders(json.dumps({"queries": ["how do I price my offer"]}))
    out = await decompose("get my first 100 customers", providers)

    assert out[0] == "get my first 100 customers"
    assert "how do I price my offer" in out


async def test_a_model_failure_degrades_to_the_goal_alone():
    """An optimisation that fails must not take retrieval down with it."""
    providers = StubProviders(error=RuntimeError("model exploded"))
    out = await decompose("get my first 100 customers", providers)

    assert out == ["get my first 100 customers"]


async def test_malformed_json_degrades_rather_than_raising():
    providers = StubProviders("{not json at all")
    out = await decompose("grow my newsletter", providers)
    assert out == ["grow my newsletter"]


async def test_a_response_without_a_queries_list_degrades():
    providers = StubProviders(json.dumps({"result": "nope"}))
    out = await decompose("grow my newsletter", providers)
    assert out == ["grow my newsletter"]


async def test_duplicates_of_the_goal_are_not_searched_twice():
    """Searching the same text twice costs a round trip and adds no candidates."""
    providers = StubProviders(
        json.dumps(
            {"queries": ["Grow my newsletter", "grow   my newsletter", "email welcome flow"]}
        )
    )
    out = await decompose("grow my newsletter", providers)

    assert out.count("grow my newsletter") == 1
    assert len(out) == 2


async def test_the_query_count_is_capped():
    """Each sub-query is a search; unbounded fan-out is unbounded latency."""
    providers = StubProviders(
        json.dumps({"queries": [f"a reasonably long sub query number {i}" for i in range(20)]})
    )
    out = await decompose("grow my newsletter", providers)
    assert len(out) == MAX_SUBQUERIES


@pytest.mark.parametrize("junk", ["", "hi", "   ", "x" * 400])
def test_unusable_queries_are_discarded(junk):
    """A one-word query retrieves noise; an essay is just the goal again."""
    assert parse_subqueries(json.dumps({"queries": [junk]})) == []


def test_non_string_entries_are_ignored():
    assert parse_subqueries(json.dumps({"queries": [123, None, "a usable sub query here"]})) == [
        "a usable sub query here"
    ]


def test_whitespace_is_flattened():
    parsed = parse_subqueries(json.dumps({"queries": ["  how   do\nI  price  the offer  "]}))
    assert parsed == ["how do I price the offer"]


def test_a_missing_queries_key_raises_for_the_caller_to_handle():
    with pytest.raises(ValueError, match="queries"):
        parse_subqueries(json.dumps({"nope": []}))
