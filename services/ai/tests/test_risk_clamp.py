"""The clamp that decides whether a plan step may run unattended.

The router refuses to auto-run a `high_risk` task whatever the plan said its owner
was, so this function is the producer of the only input that rule has. Its two
properties are asserted separately because they fail differently: **it raises**
where the step commits to an act (a miss here lets the AI spend somebody's money
unwatched), and **it never lowers** (a lower tier is an authorisation the model
talked itself into).

No network, no model. The whole point is that this decision is arithmetic.
"""

import pytest

from octopus_ai.risk import clamp_risk_tier, high_risk_match, normalise_criteria
from octopus_ai.schemas import RISK_TIERS

# Phrasings a planner actually produces for the acts in marketing-growth-engine.md's
# tool table and full-funnel-creator.md steps 5 and 11.
COMMITTING_STEPS = [
    ("Launch the prospecting campaign", "Turn the campaign on once creative is approved."),
    ("Set the daily budget", "Set the budget to the band the founder gave at intake."),
    ("Connect the Meta ad account", "Connect the account so campaigns can be created."),
    ("Publish the launch post", "Publish to the founder's channels on the agreed date."),
    ("Send the welcome sequence", "Send the email sequence to the list."),
    ("Pay the creative node", "Pay on approval of the delivered edit."),
    ("Sign the agreement", "Sign the contract with the selected influencer."),
    ("Raise the budget on the winning ad set", "Increase the budget where ROAS clears target."),
]

# Ordinary drafting work. The AI produces something we hold and can throw away,
# which is exactly what `reversible` means.
DRAFTING_STEPS = [
    ("Draft the launch ads", "Write three ad variants for the prospecting campaign."),
    ("Build the campaign structure", "Create the campaign, ad set and ad as drafts. Not live."),
    ("Research competitor positioning", "Review how three comparable products position."),
    ("Write the landing page copy", "Draft headline, subhead and CTA for the conversion page."),
    ("Define the ICP", "Write the positioning statement and the audience it addresses."),
]


@pytest.mark.parametrize(("title", "detail"), COMMITTING_STEPS)
def test_a_step_that_commits_is_raised_however_the_model_labelled_it(title: str, detail: str):
    """The case this exists for: the planner marks a spending step reversible."""
    assert clamp_risk_tier("reversible", title, detail) == "high_risk"


@pytest.mark.parametrize(("title", "detail"), DRAFTING_STEPS)
def test_ordinary_drafting_work_is_left_alone(title: str, detail: str):
    """Over-refusal is safe but not free: every false positive is a user touch.

    `vision.md` counts those as a guardrail to drive down, so the clamp has to
    leave the common case alone or the plan card becomes a wall of approvals that
    people learn to click through.
    """
    assert clamp_risk_tier("reversible", title, detail) == "reversible"


@pytest.mark.parametrize("tier", RISK_TIERS)
def test_the_clamp_never_lowers_a_tier(tier: str):
    """One direction only, over every tier and both kinds of step."""
    for title, detail in COMMITTING_STEPS + DRAFTING_STEPS:
        result = clamp_risk_tier(tier, title, detail)
        assert RISK_TIERS.index(result) >= RISK_TIERS.index(tier)


def test_high_risk_survives_a_step_the_patterns_do_not_recognise():
    """The model saw something the pattern list does not. Believe the stricter one."""
    tier = clamp_risk_tier("high_risk", "Hand over the domain", "Transfer ownership.")
    assert tier == "high_risk"


def test_word_boundaries_hold_on_the_words_most_likely_to_misfire():
    """`positioning` is not `post`, and `forbidden` is not `bid`.

    Marketing prose is full of these, so a substring match would clamp most of the
    strategy stage and quietly train people to approve everything.
    """
    assert high_risk_match("Positioning workshop", "Define positioning and messaging.") is None
    assert high_risk_match("Audit forbidden claims", "List claims we cannot make.") is None


def test_launch_fires_as_a_verb_and_not_as_a_noun_modifier():
    """"Launch the campaign" is the act. "The launch ads" is drafting.

    `launch` is the most common word in a marketing plan, and matching it bare
    clamped every drafting step in the creative stage. A card whose every step
    demands approval teaches people to approve without reading.
    """
    assert high_risk_match("Launch the campaign", "Go on Monday.") == "launch"
    assert high_risk_match("Draft the launch ads", "Three variants.") is None
    assert high_risk_match("Launch week checklist", "Prepare the assets.") is None


def test_the_determiner_less_imperative_is_a_known_miss():
    """Recorded rather than hidden, so the next reader knows it was a decision.

    "Launch ads on Meta" reaches the act without a determiner and the pattern does
    not see it. The phrasings that get there in practice are caught by `go_live`
    and `publish`; a noun deny-list would be brittle in the direction that matters.
    """
    assert high_risk_match("Launch ads on Meta", "Set them running.") is None
    assert high_risk_match("Launch ads on Meta", "Take the campaign live.") == "go_live"


def test_the_rule_that_fired_is_reported_not_just_that_one_did():
    """A clamp that cannot say why it fired is one nobody trusts enough to keep."""
    assert high_risk_match("Ship it", "Go live on Monday.") == "go_live"


def test_criteria_are_trimmed_deduplicated_of_blanks_and_capped():
    assert normalise_criteria(["  names three gaps  ", "", "   "]) == ["names three gaps"]
    assert len(normalise_criteria([f"criterion {i}" for i in range(9)])) == 3


def test_an_over_long_criterion_is_truncated_rather_than_rejected():
    """A cosmetic fault must not degrade a working card to prose."""
    out = normalise_criteria(["x" * 500])
    assert len(out) == 1
    assert len(out[0]) == 140
