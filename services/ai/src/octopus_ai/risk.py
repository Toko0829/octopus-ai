"""What a plan step would do to the outside world, decided in code.

The planner proposes a `risk_tier` per step. This raises it, and can never lower
it. That split is not a style preference, it is the third time this project has
met the same failure: a prompt asking a model for a **disposition** is agreed
with and then quietly ignored. Decomposition was told "most goals need one or two
stages" and took the north-star case from coverage 1.00 to 0.33. The groundedness
gate was told "when unsure, answer false" and refused 0.36 of legitimate goals.
A model answers "what would this step change?" well; it should not be the last
word on "may this run unattended?", because rules 7 and 11 put that in code.

**The asymmetry decides every close call.** A false positive here costs one user
touch, which vision.md counts as a guardrail to drive down. A false negative lets
the AI spend somebody's money with nobody watching. So a match raises the tier
even where the phrasing is arguably innocent, and the tests below pin the cases
where that trade was made deliberately rather than by accident.

The vocabulary comes from the tool table in `marketing-growth-engine.md` and the
escalation map in `full-funnel-creator.md` (steps 5 and 11 to the user) rather
than being invented here, so a tool that is high-risk and a step that proposes
that tool cannot drift apart.
"""

import re

from .schemas import RiskTier

# Each pattern names an act with an outside-world consequence. Grouped by what the
# consequence is, because that is what has to stay in step with the tool table.
#
# Word boundaries throughout: "post" must not fire on "positioning", "bid" must
# not fire on "forbidden", "pay" must not fire on "paypal" mentioned in passing.
_HIGH_RISK_PATTERNS: tuple[tuple[str, str], ...] = (
    # Money leaves, or a ceiling that lets it leave is set.
    ("spend", r"\bspend(s|ing)?\b"),
    ("budget", r"\b(set|adjust|raise|increase|allocate|reallocate)\w*\s+(the\s+|a\s+)?budget\b"),
    ("bid", r"\bbid(s|ding)?\b"),
    ("pay", r"\bpay(s|ing|ment|ments|out|outs)?\b"),
    ("invoice", r"\binvoice[sd]?\b"),
    # Something becomes visible to an audience under the person's name.
    ("publish", r"\bpublish(es|ing|ed)?\b"),
    # `launch` is the one ambiguous word here and it is the most common word in a
    # marketing plan. "Launch the campaign" is the act; "the launch ads", "launch
    # week", "launch copy" are a noun modifier on ordinary drafting work. Matching
    # the bare word clamped "Draft the launch ads", and a card where the drafting
    # steps all demand approval teaches people to approve without reading, which
    # costs more safety than it buys. So it fires only in verb position.
    #
    # The known miss is a determiner-less imperative: "Launch ads on Meta". Left
    # rather than papered over, because the phrasings that reach the act without a
    # determiner ("go live", "turn it on", "publish") are caught below, and adding
    # a noun deny-list here would be brittle in the direction that matters.
    ("launch", r"\blaunch(es|ing|ed)?\s+(the|a|an|this|these|those|your|our|their|its|it|all)\b"),
    (
        "go_live",
        r"\bgo(es|ing)?\s+live\b|\btak(e|es|ing)\s+(\w+\s+){0,3}live\b"
        r"|\bturn(s|ing|ed)?\s+(\w+\s+){0,3}on\b",
    ),
    ("send_email", r"\bsend(s|ing)?\s+(the\s+|a\s+|an\s+)?(email|newsletter|sequence|campaign)"),
    ("schedule_post", r"\b(schedule|post)(s|ing|ed)?\s+(the\s+|a\s+)?(post|content|ad|ads)\b"),
    # An account, a credential, or a permission changes hands.
    ("connect", r"\bconnect(s|ing|ed)?\b"),
    ("authorise", r"\bauthoris|\bauthoriz|\boauth\b|\bgrant\s+access\b"),
    ("credentials", r"\b(api\s+key|access\s+token|credential[s]?)\b"),
    # The person is committed to somebody.
    ("sign", r"\bsign(s|ing|ed)?\s+(the\s+|a\s+|an\s+)?(contract|agreement|lease|deal)"),
    ("hire", r"\bhire[sd]?\b|\bhiring\b"),
    ("contract_verb", r"\bcontract(s|ing|ed)\s+with\b"),
)

_COMPILED = tuple(
    (name, re.compile(pattern, re.IGNORECASE)) for name, pattern in _HIGH_RISK_PATTERNS
)


def high_risk_match(title: str, detail: str) -> str | None:
    """Return the name of the first rule that fires, or None.

    Returned rather than a bare bool so a caller can log *which* act it saw. A
    clamp that cannot say why it fired is a clamp nobody trusts enough to keep.
    """
    text = f"{title}\n{detail}"
    for name, pattern in _COMPILED:
        if pattern.search(text):
            return name
    return None


def clamp_risk_tier(proposed: RiskTier, title: str, detail: str) -> RiskTier:
    """Raise `proposed` to `high_risk` when the step's own words commit to an act.

    One direction only. There is no path here that returns something weaker than
    what was passed in, and `test_risk_clamp.py` asserts that over every tier.
    """
    if proposed == "high_risk":
        return proposed
    if high_risk_match(title, detail) is not None:
        return "high_risk"
    return proposed


_CRITERION_MAX = 140


def normalise_criteria(criteria: list[str]) -> list[str]:
    """Trim, drop empties, cap length and count.

    Truncating rather than rejecting is deliberate: an over-long criterion is a
    cosmetic fault, and failing the whole plan over one would degrade a working
    card to prose for no safety gain. A missing `risk_tier` gets the same
    treatment via its schema default, for the same reason.
    """
    out: list[str] = []
    for raw in criteria:
        text = " ".join(raw.split())
        if not text:
            continue
        out.append(text[:_CRITERION_MAX])
        if len(out) == 3:
            break
    return out
