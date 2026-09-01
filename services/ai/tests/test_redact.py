"""What `redact.scrub` removes, and the larger half: what it must leave alone.

Both directions matter and they fail differently. A rule that misses an
identifier puts a person's address in a table (rule 8). A rule that over-matches
turns the refusal ledger into a column of "how do I get more [redacted] for my
[redacted]", which records that something was refused and nothing about what,
and the ledger's only purpose is the what.

The module is deliberately biased toward removing, so the negative tests here pin
the specific things that bias must not eat: prices, counts, timeframes,
abbreviations and ordinary sentences.
"""

import pytest

from octopus_ai.redact import scrub

# --- identifiers must go ----------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "get more signups for bluelly.com from students",
        "traffic for Bluelly.com please",
        "MYSITE.COM needs traffic",
        "check https://example.com/pricing?ref=1 for me",
        "www.example.co.uk is the site",
        "our shop at store.example.org/collections/new",
    ],
)
def test_domains_and_urls_go(text):
    assert "[url]" in scrub(text)
    assert "example" not in scrub(text)
    assert "bluelly" not in scrub(text).lower()


def test_url_goes_whole_including_its_path():
    """A path left behind is still a fragment of somebody's site."""
    assert scrub("see bluelly.com/pricing today") == "see [url] today"


@pytest.mark.parametrize(
    "text",
    [
        "email me at ana@shop.co.uk about this",
        "reach founder+ads@my-store.io",
        "contact: a.b@x.dev",
    ],
)
def test_emails_go(text):
    scrubbed = scrub(text)
    assert "[email]" in scrubbed
    assert "@" not in scrubbed


def test_email_is_taken_before_its_domain():
    """Order matters: domains first would leave a dangling local part.

    `ana@shop.com` scrubbed domain-first becomes `ana@[url]`, and no later rule
    matches the `ana@` that is left.
    """
    assert scrub("ana@shop.com") == "[email]"


@pytest.mark.parametrize(
    "text",
    [
        "call me on +995 599 12 34 56",
        "call 555-123-4567 to confirm",
        "my number is (415) 555 0199",
    ],
)
def test_phone_numbers_go(text):
    assert "[phone]" in scrub(text)


def test_long_digit_runs_go():
    assert scrub("order 123456 was wrong") == "order [number] was wrong"


# --- and the substance must stay --------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # The three things a founder says while describing a marketing goal, all
        # of which have the shape of a number and none of which identify anyone.
        "my budget is 1000 - 2000 a month",
        "I want 5000 signups in 90 days",
        "we have 2500 followers and want 10x",
        "get to 100 customers by Q3 2026",
    ],
)
def test_prices_counts_and_timeframes_stay(text):
    assert scrub(text) == text


def test_the_phone_floor_is_what_protects_a_budget_range():
    """`1000 - 2000` matches the phone SHAPE exactly and survives on digit count.

    Eight digits, and the floor is nine. This is the single case that decides
    whether the ledger can still see what someone was willing to spend.
    """
    assert scrub("budget 1000 - 2000") == "budget 1000 - 2000"
    assert scrub("budget 1000 - 20000") == "budget [phone]"


@pytest.mark.parametrize(
    "text",
    [
        "e.g. i.e. U.S. buyers",
        "version 3.5 of the app",
        "get signups.Then we scale to paid",
    ],
)
def test_abbreviations_versions_and_sentence_breaks_stay(text):
    """The domain rule must not eat prose that happens to contain a full stop."""
    assert scrub(text) == text


def test_the_subject_of_the_question_always_survives():
    """The whole reason the ledger is readable."""
    goal = "how do I build a webinar funnel that converts for bluelly.com"
    scrubbed = scrub(goal)
    assert "webinar funnel that converts" in scrubbed
    assert "bluelly" not in scrubbed


# --- properties the call path depends on -------------------------------------


def test_it_is_idempotent():
    """Called on a path that may be retried, so a second pass must be a no-op.

    True because every marker is bracket text with no digit, no `@` and no dot.
    """
    goal = "email ana@shop.com about bluelly.com, or call +995 599 12 34 56"
    once = scrub(goal)
    assert scrub(once) == once


def test_empty_stays_empty():
    assert scrub("") == ""


def test_whitespace_is_collapsed():
    """A goal somebody pasted over four lines is harder to scan than it needs to be."""
    assert scrub("get   more\n\nsignups\tplease") == "get more signups please"
