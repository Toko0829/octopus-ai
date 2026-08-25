"""Which kind of deliverable a step is asking for.

The property under test is that **a step asking for copy stops getting an essay
about copy**. The executor had one prompt for every step, so "write three
headline variations" and "define our positioning" produced the same shape of
output, and a person who approved a plan got prose they still had to act on.

The interesting cases are the ambiguous ones, and each assertion below pins a
trade that was made deliberately rather than falling out of pattern order.
"""

import pytest

from octopus_ai.deliverable import classify, instruction_for


@pytest.mark.parametrize(
    "title,detail,expected",
    [
        # The plain readings, one per kind.
        ("Draft ad copy for cold traffic", "Five variants for the top of funnel.", "copy"),
        ("Write the landing page", "Hero through final CTA.", "landing"),
        ("Build the welcome email sequence", "Four emails over ten days.", "sequence"),
        ("Creative direction for the launch", "Art direction and shot list.", "brief"),
        ("Sharpen the positioning", "Against the two incumbents.", "analysis"),
    ],
)
def test_the_plain_readings(title, detail, expected):
    assert classify(title, detail) == expected


def test_landing_beats_copy_because_a_page_is_not_a_set_of_variants():
    """'Landing page copy' is a page. Five ad variants would be the wrong shape."""
    assert classify("Landing page copy", "Write the conversion page.") == "landing"


def test_sequence_beats_copy_because_an_email_sequence_is_copy():
    """Both patterns match. The sequence prompt is the one that produces emails."""
    assert classify("Email sequence copy", "Nurture flow for new signups.") == "sequence"


def test_the_detail_decides_when_the_title_is_only_a_label():
    """A title is a label; the detail says which problem the plan identified.

    'Creative' alone is a funnel stage name, and reading it without the detail
    would classify every creative-stage step the same way regardless of what it
    actually asks for.
    """
    assert classify("Creative", "Write the ad headlines and primary text.") == "copy"
    assert classify("Creative", "Concepts and art direction for the hero image.") == "brief"


def test_a_word_boundary_keeps_positioning_out_of_copy():
    """`posts?` must not fire on 'positioning', which is the most common word here."""
    assert classify("Positioning workshop", "Define the positioning statement.") == "analysis"


def test_analysis_is_the_default_and_is_not_a_failure():
    """Research and measurement steps genuinely are prose.

    Forcing them into a variant table would be the same defect in the opposite
    direction, so the default is the behaviour that already shipped.
    """
    assert classify("Competitor teardown", "How the two incumbents position.") == "analysis"
    assert classify("Set up measurement", "Decide which source of truth counts.") == "analysis"


def test_every_kind_has_an_instruction():
    """A kind with no prompt would fall through to a KeyError at execute time."""
    for title, detail, kind in [
        ("ad copy", "", "copy"),
        ("landing page", "", "landing"),
        ("email sequence", "", "sequence"),
        ("creative brief", "", "brief"),
        ("positioning", "", "analysis"),
    ]:
        assert classify(title, detail) == kind
        assert instruction_for(kind).strip()


def test_instructions_ask_for_structure_rather_than_quality():
    """A disposition is agreed with and ignored; a structure is checkable.

    This project has measured that twice, in decomposition and in the
    groundedness gate, so the prompts must not drift back toward "write good
    copy". Each asks for a named, countable shape instead.
    """
    assert "FIVE variants" in instruction_for("copy")
    assert "FOUR emails" in instruction_for("sequence")
    assert "## Hero" in instruction_for("landing")


def test_the_brief_says_plainly_that_images_are_not_generated():
    """Claiming a capability we do not have is worse than naming the gap."""
    assert "cannot generate images" in instruction_for("brief")


def test_no_instruction_uses_an_em_dash():
    """Rule 22. These reach a person through the artifact body."""
    for kind in ("copy", "landing", "sequence", "brief", "analysis"):
        assert "—" not in instruction_for(kind)
