"""Founder vocabulary must reach the corpus's vocabulary, and nothing else must move.

The measured failure this exists to fix, against the live corpus:

    marketing plan to get registrations  ->  refusing-v0, 25 candidates, none kept
    marketing plan to get signups        ->  grounded-plan-v1, full six-stage plan

Two halves are tested with equal weight, because a rewrite table is dangerous in
exactly the direction that looks like success. The positive half asserts the
variants land on corpus terms. The negative half asserts the guards hold, and it
is the larger half on purpose: every rule that rewrites "register" is one bad
regex away from turning "register my company in the UK" into a marketing query
the corpus will happily answer, which is the leak `neg-register-company` and
`neg-trademark` defend at the eval level and these tests defend at the unit level.
"""

import pytest

from octopus_ai.vocabulary import _SYNONYMS, normalise_query


def norm(text: str) -> str:
    return normalise_query(text)[0]


def rules(text: str) -> tuple[str, ...]:
    return normalise_query(text)[1]


# --- the measured case ------------------------------------------------------


def test_the_measured_failure():
    """The exact phrasing that returned refusing-v0 against the live corpus."""
    assert norm("marketing plan to get registrations") == "marketing plan to get signups"


def test_the_users_own_words():
    """From the report that opened this work: "register on my website"."""
    assert norm("get students to register on my website") == "get students to sign up on my website"


# --- one test per rule, positive direction ----------------------------------


@pytest.mark.parametrize(
    "before,after",
    [
        ("get more registrations", "get more signups"),
        ("improve my registration flow", "improve my signup flow"),
        ("people registering on the site", "people signing up on the site"),
        ("nobody registers for my newsletter", "nobody signs up for my newsletter"),
        ("track sign-ups from the campaign", "track signups from the campaign"),
        ("the sign-up form is too long", "the signup form is too long"),
        ("sign ups have stalled", "signups have stalled"),
        ("course enrollments are flat", "course signups are flat"),
        ("one enrolment per week", "one signup per week"),
        ("very few installs last month", "very few signups last month"),
        ("i get no enquiries from the page", "i get no leads from the page"),
        ("one inquiry all week", "one lead all week"),
        ("book more demos", "book more leads"),
        ("demo requests dried up", "leads dried up"),
        ("where do my first clients come from", "where do my first customers come from"),
        ("my best client left", "my best customer left"),
        ("turn buyers into repeat buyers", "turn customers into repeat customers"),
        ("my members keep cancelling", "my subscribers keep cancelling"),
        ("mrr has been flat", "revenue has been flat"),
        ("grow ARR this quarter", "grow revenue this quarter"),
    ],
)
def test_variants_reach_corpus_vocabulary(before: str, after: str):
    assert norm(before) == after


# --- the negative half: every guard, one test each --------------------------


@pytest.mark.parametrize(
    "text",
    [
        # Business formation. The family `neg-incorporation` and
        # `neg-register-company` defend, and the reason the verb rule needs a
        # preposition rather than firing on the bare word.
        "how do I register my company in the UK",
        "where do I register a trademark for my brand name",
        "I need to register the business first",
        "company registration takes two weeks",
        "trademark registration costs",
        "vehicle registration renewal",
        # Paperwork wearing a marketing-shaped verb.
        "do I need to register for VAT when I start selling",
        "when must I register for tax",
        # The one technical collision in a corpus that discusses deliverability.
        "some email clients strip the images",
        # Org vocabulary, not a metric.
        "what should I pay my first team members",
        "our staff members handle support",
        # The singular verb sense, deliberately unmapped.
        "install the tracking snippet",
    ],
)
def test_guarded_phrases_are_left_alone(text: str):
    assert norm(text) == text
    assert rules(text) == ()


def test_the_bare_verb_phrase_sign_up_is_not_rewritten():
    """The corpus writes "after someone signs up" in prose.

    Rewriting a verb into a noun buys nothing and costs grammar, so only the
    hyphenated forms and the unambiguous plural noun are normalised.
    """
    assert norm("what happens after someone signs up") == "what happens after someone signs up"
    assert norm("ask them to sign up") == "ask them to sign up"


def test_the_sentence_final_verb_is_a_known_miss():
    """Recorded deliberately, on risk.py's principle for its own known miss.

    A bare verb with nothing after it has no preposition to disambiguate it, and
    the shape reaches formation ("I still need to register") as often as signup.
    Matching it would trade a guarded rule for an unguarded one on the riskiest
    entry in the table.

    It degrades safely rather than to a refusal: the corpus itself now carries
    "registration" after the vocabulary weave, so the query still retrieves. If
    this ever needs closing, close it with a measurement, not with an intuition.
    """
    text = "i need to promote the site to gather students to register"
    assert norm(text) == text
    assert rules(text) == ()


def test_icp_nouns_belong_to_strip_particulars():
    """The two modules must not both claim a word.

    `strip_particulars` removes the person's audience. If this module also had an
    opinion about "students", a change to either would move retrieval and neither
    docstring would explain why.
    """
    text = "get students and travelers to my page"
    assert norm(text) == text


def test_ordinary_marketing_words_are_not_collateral():
    """A rewrite table that touches ordinary prose is one nobody can predict."""
    text = "improve the landing page headline and test three creative angles"
    assert norm(text) == text
    assert rules(text) == ()


# --- properties -------------------------------------------------------------


def test_no_rule_grows_a_query_by_more_than_one_word():
    """Expansion is measured-fatal, so replacements are bounded.

    `MAX_REFINED_GOAL_WORDS` is 7 because a nine-word query refused where a
    five-word phrasing of the same intent grounded. A rewrite that lengthens a
    query is spending the exact budget that measurement bought.
    """
    for name, _pattern, replacement in _SYNONYMS:
        # The longest thing any rule can consume is its replacement's own word
        # count minus one; a single-word variant may become at most two words.
        assert len(replacement.split()) <= 2, name


def test_a_query_with_nothing_to_rewrite_is_returned_unchanged():
    text = "how do I lower my cost per acquisition on paid social"
    assert norm(text) == text
    assert rules(text) == ()


def test_fired_rule_names_are_reported():
    """Returned rather than discarded, on risk.py's rule: an unattributable
    rewrite is one nobody can debug."""
    assert "registrations" in rules("get registrations")
    assert "recurring_revenue" in rules("mrr is flat")


def test_whitespace_is_normalised_on_the_way_out():
    """A shortening replacement otherwise leaves a double space in the logs."""
    assert norm("we need demo requests  badly") == "we need leads badly"


def test_empty_input_is_safe():
    assert normalise_query("") == ("", ())


# --- the call site ----------------------------------------------------------


@pytest.mark.asyncio
async def test_retriever_searches_the_normalised_text():
    """The rewrite has to reach the embedder, the sparse query and the reranker.

    All three read the same string inside `_retrieve_one`, so asserting the
    embedder saw it is enough to pin that the rewrite happened before the split.
    """
    from octopus_ai.providers import RerankHit
    from octopus_ai.retrieval import Retriever
    from test_retrieval import StubDb, StubProviders, make_settings, row

    class RecordingProviders(StubProviders):
        def __init__(self, hits):
            super().__init__(hits)
            self.embedded: list[str] = []
            self.reranked: list[str] = []

        async def embed(self, texts):
            self.embedded.extend(texts)
            return await super().embed(texts)

        async def rerank(self, query, documents, top_n):
            self.reranked.append(query)
            return await super().rerank(query, documents, top_n)

    providers = RecordingProviders([RerankHit(index=0, score=0.9)])
    db = StubDb([row("a", "Landing pages")])
    retriever = Retriever(make_settings(), db, providers)

    await retriever.retrieve("marketing plan to get registrations")

    assert providers.embedded == ["marketing plan to get signups"]
    assert providers.reranked == ["marketing plan to get signups"]
    assert db.last_kwargs["query"] == "marketing plan to get signups"


@pytest.mark.asyncio
async def test_subqueries_are_normalised_too():
    """A sub-query is written by a model that read the person's wording, so it
    inherits the person's vocabulary along with it."""
    from octopus_ai.providers import RerankHit
    from octopus_ai.retrieval import Retriever
    from test_retrieval import StubDb, StubProviders, make_settings, row

    class RecordingProviders(StubProviders):
        def __init__(self, hits):
            super().__init__(hits)
            self.embedded: list[str] = []

        async def embed(self, texts):
            self.embedded.extend(texts)
            return await super().embed(texts)

    providers = RecordingProviders([RerankHit(index=0, score=0.9)])
    db = StubDb([row("a", "Landing pages")])
    retriever = Retriever(make_settings(), db, providers)

    await retriever.retrieve(
        "get registrations",
        subqueries=["get registrations", "how do enrollments convert"],
    )

    assert providers.embedded == ["get signups", "how do signups convert"]
