"""The person's own particulars must not reach the retrieval query.

Measured on the live corpus, not supposed. Intake produced "get student sign-ups
via website promotion" for a real goal and it returned `refusing-v0`: 25
candidates, none above the threshold. The same corpus, the same pipeline, with
one word removed:

    get student sign-ups via website promotion  ->  refusing-v0
    get sign-ups via website promotion          ->  grounded-plan-v1
    get signups from paid acquisition           ->  grounded-plan-v1

`INTAKE_SYSTEM_PROMPT` already asks for this and gives `travelers` as the worked
example. The model complied on the example and not on `students`, which is the
third time this project has watched a prompt-level disposition be agreed with and
ignored. So the rule lives in code, and these tests are what keep it there.
"""

from octopus_ai.intake import strip_particulars
from octopus_ai.schemas import IntakeSlot


def slot(key: str, value: str) -> IntakeSlot:
    return IntakeSlot(key=key, value=value, source="stated")


def test_the_measured_failure():
    """The exact goal and slots that returned refusing-v0 against the live corpus."""
    out = strip_particulars(
        "get student sign-ups via website promotion",
        [slot("icp", "students in the USA aged 18-25"), slot("budget_band", "$2000 per month")],
    )
    assert "student" not in out.lower()
    assert out == "get sign-ups via website promotion"


def test_the_offer_slot_is_not_collateral():
    """The regression the first version of this shipped, caught by running it.

    Drawing particulars from `offer` as well as `icp` meant "Website bluelly.com
    sign-ups" contributed `sign`, `ups` and `website`. Stripping then removed the
    audience AND the metric, left two content words, tripped the minimum below,
    and returned the polluted original: the guard against gutting the query was
    what preserved the pollution. The measurement had already ruled this out,
    since "get sign-ups via website promotion" retrieved perfectly well.
    """
    out = strip_particulars(
        "get student sign-ups from paid acquisition",
        [
            slot("icp", "Students (18-25) in the USA"),
            slot("offer", "Website bluelly.com sign-ups"),
            slot("target_metric", "Student sign-ups"),
            slot("budget_band", "$2000/month"),
        ],
    )
    assert out == "get sign-ups from paid acquisition"


def test_a_domain_never_reaches_the_query():
    """A corpus of marketing principles holds no company names."""
    out = strip_particulars("promote bluelly.com with organic social", [])
    assert "bluelly" not in out


def test_a_plural_in_the_slot_removes_the_singular_in_the_goal():
    """Prefix matching, because a model restates rather than copies."""
    out = strip_particulars(
        "get signups from travelers via paid acquisition",
        [slot("icp", "travelers")],
    )
    assert "traveler" not in out.lower()


def test_numbers_never_survive():
    """Budgets, ages and counts are not search terms in a corpus of principles."""
    out = strip_particulars(
        "grow to 1000 customers with 5000 monthly spend",
        [slot("budget_band", "$5000 a month")],
    )
    assert "1000" not in out and "5000" not in out


def test_the_target_metric_is_deliberately_kept():
    """'signups' and 'customers' are practitioner vocabulary the corpus uses.

    Stripping them would gut the query rather than clean it, which is why
    target_metric is excluded from the particulars set.
    """
    out = strip_particulars(
        "get more signups from organic social",
        [slot("target_metric", "signups"), slot("icp", "designers")],
    )
    assert "signups" in out


def test_a_goal_that_would_be_gutted_is_left_alone():
    """A polluted query retrieves badly; an empty one retrieves nothing.

    The first is recoverable, so when stripping would leave too little to search
    with, the original is kept deliberately.
    """
    original = "help students"
    assert strip_particulars(original, [slot("icp", "students")]) == original


def test_no_slots_means_no_change():
    original = "lower cpa on paid social"
    assert strip_particulars(original, []) == original


def test_ordinary_marketing_words_are_not_collateral():
    """The prefix match must not eat the vocabulary the corpus is written in."""
    out = strip_particulars(
        "improve conversion on the landing page",
        [slot("icp", "consultants"), slot("offer", "a course")],
    )
    assert "conversion" in out and "landing" in out


def test_a_long_query_is_shortened_because_length_decided_the_measurement():
    """Nine words retrieved nothing; five returned a full plan, same corpus.

    Function words go first, since they carry no signal at a cross-encoder, so
    the query gets shorter without losing anything it was searching for.
    """
    out = strip_particulars("get sign-ups for a new website via paid acquisition", [])
    assert len(out.split()) <= 7
    # The words that carry the intent survive; only the function words go.
    assert "paid" in out and "acquisition" in out and "website" in out


def test_a_short_query_is_left_exactly_as_it_is():
    """Shortening must not fire on something already in range."""
    original = "get signups from paid acquisition"
    assert strip_particulars(original, []) == original


def test_a_short_particular_is_removed_too():
    """The gap that produced a real refusal, on a goal the corpus answers.

    `USA` was extracted as a particular and then never compared against
    anything, because the prefix rule required four characters on both sides.
    "marketing plan to get USA signups" therefore reached the groundedness gate,
    which read the person's own geography as a topic the sources were obliged to
    cover, and refused.
    """
    out = strip_particulars(
        "marketing plan to get USA signups",
        [slot("icp", "students from the USA"), slot("offer", "bluelly.com registration")],
    )
    assert "USA" not in out
    assert "signups" in out, "the metric is practitioner vocabulary and must survive"


def test_other_short_qualifiers_too():
    """`UK` needed the extraction floor lowered as well as the match relaxed.

    `USA` was collected and never compared; `UK`, at two characters, was never
    collected at all. Both halves of the same leak.

    The goals here are deliberately long enough to survive stripping. A shorter
    one trips the minimum-content guard and comes back unchanged, which is that
    guard working rather than this rule failing.
    """
    for icp, word in [("UK-based freelancers", "UK"), ("B2B SaaS teams", "B2B")]:
        out = strip_particulars(
            f"lower cost per acquisition on paid social for {word} buyers",
            [slot("icp", icp)],
        )
        assert word not in out, f"{word} leaked into the query"
        assert "acquisition" in out, "the practitioner vocabulary must survive"


def test_a_short_particular_does_not_match_a_longer_word():
    """Exact for short ones, so `ads` cannot eat `adspend` or `adjust`."""
    out = strip_particulars("adjust the ad spend upward", [slot("icp", "ads managers")])
    assert "adjust" in out
