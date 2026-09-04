"""Unwrapping the one JSON object out of a model's reply.

Only the OpenAI dialect has a cheap `json_object` mode. On the other two, "reply
with one JSON object" is an instruction, and the ways a model complies
imperfectly are few and predictable: a code fence, a sentence in front, both.
Throwing a usable plan away over a fence would turn compliance into a refusal.

The failure that matters in the other direction is silence: a reply with no
object must raise, so the caller's existing "the draft came back unusable" path
runs instead of something downstream receiving an empty string.
"""

import json

import pytest

from octopus_ai.providers import _extract_json_object


def test_a_bare_object_is_returned_unchanged():
    """The OpenAI path runs through this too, so it must be a no-op there."""
    assert _extract_json_object('{"a": 1}') == '{"a": 1}'


@pytest.mark.parametrize(
    "raw",
    [
        '```json\n{"a": 1}\n```',
        '```\n{"a": 1}\n```',
        'Here is the plan:\n\n{"a": 1}',
        '{"a": 1}\n\nLet me know if you want it narrower.',
        '```json\n{"a": 1}\n```\n\nHope that helps.',
    ],
)
def test_the_object_survives_every_way_a_model_wraps_it(raw):
    assert json.loads(_extract_json_object(raw)) == {"a": 1}


def test_nested_braces_are_not_truncated():
    """First `{` to last `}`, so a nested object cannot end the match early."""
    raw = '{"stages": [{"stage": "strategy", "steps": [{"id": "a"}]}]}'
    assert json.loads(_extract_json_object(f"prose\n```json\n{raw}\n```")) == json.loads(raw)


def test_a_brace_inside_a_string_is_tolerated():
    raw = '{"detail": "use the {audience} placeholder"}'
    assert json.loads(_extract_json_object(raw))["detail"] == "use the {audience} placeholder"


@pytest.mark.parametrize("raw", ["", "   ", "I cannot do that.", "```\nnot json\n```", "}{"])
def test_no_object_raises_rather_than_returning_nothing(raw):
    """`ValueError` is what every caller already treats as a real outcome."""
    with pytest.raises(ValueError):
        _extract_json_object(raw)
