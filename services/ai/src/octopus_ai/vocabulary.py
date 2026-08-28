"""The words a founder uses, mapped to the words the corpus is written in.

Measured, not supposed. Two phrasings of one intent against the same corpus:

    marketing plan to get registrations  ->  refusing-v0, 25 candidates, none kept
    marketing plan to get signups        ->  grounded-plan-v1, full six-stage plan

The corpus says "signups" throughout and never says "registrations". At the local
reranker's threshold margin of 1.76x (`RERANK_LOCAL_MIN_SCORE = 0.0013`, see
ADR-0009) a synonym the corpus does not contain is the whole distance between a
plan and a refusal, so a person who says "register on my website" is refused
where one who says "sign up" is served, for the same request.

**The primary fix is the corpus**, and it was done alongside this: the documents
now use the words people actually use. This module is the second half, for the
variants prose cannot carry naturally without reading like a synonym list.

## Why this is a small curated table and not a dictionary

A general dictionary or a second embedding space was considered and rejected on
four grounds, each of which is a property of this pipeline rather than an opinion:

1. **Dense retrieval already is the semantic synonym layer.** bge-m3 places
   "registrations" near "signups" without help. That stage is not what fails. The
   cross-encoder score against the threshold is, and a second embedding space does
   not move a cross-encoder's score.
2. **A general dictionary has no domain.** "Registration" neighbours company
   registration, vehicle registration and event registration. Expanding toward
   those pulls business-formation vocabulary into marketing queries, which is the
   exact direction `neg-incorporation` and `neg-car-licence` exist to defend.
3. **Expansion is measured-fatal.** `MAX_REFINED_GOAL_WORDS` is 7 because a
   nine-word query refused where a five-word phrasing of the same intent grounded:
   a cross-encoder dilutes on long queries. So this REPLACES terms and never adds
   them. `test_vocabulary.py` pins that no rule grows a query by more than one
   word.
4. **No synonym reaches a document that does not exist.** Vocabulary was never the
   whole gap, which is why three documents were written in the same change.

## Where it runs, and what that covers

Called once at the top of `Retriever.retrieve`, on the goal and on every
sub-query. That single choke point covers the planner, the executor's per-step
re-retrieval, the seed probe, and both eval harnesses. It also covers the goals
that never passed through intake at all: `_passthrough` in `intake.py` returns a
goal without running `strip_particulars`, so a rule living in intake would have a
hole exactly where a specific request skips the questions.

The groundedness gate deliberately still judges the person's **original** words,
because "do these sources answer what was asked?" is a question about what they
asked, not about what we searched for.

## The division of labour with `strip_particulars`

`strip_particulars` (intake.py) REMOVES the person's own particulars: their
audience, their numbers, their domain. This module REPLACES practitioner
vocabulary with the corpus's synonym for it. The two must not overlap: ICP nouns
("students", "travelers", "patients") belong to that module and are deliberately
absent here, because mapping domain nouns is unbounded and it is already solved.
"""

from __future__ import annotations

import re

# "register" is only the signup sense when it takes a preposition. "Register my
# company", "register a trademark" are verb-plus-object and are business
# formation, which this corpus does not cover. Tax registration is excluded
# explicitly for the same reason: it is an act of formation wearing a
# marketing-shaped verb.
#
# **Known miss, recorded rather than papered over**, on the same principle as
# risk.py's determiner-less imperative. A sentence-final bare verb ("get people
# to register", "gather students to register") does not fire, because there is no
# preposition to disambiguate it. Closing it would mean matching `register` with
# nothing after it, and the phrasings that reach this shape in practice are as
# often formation ("I still need to register") as signup.
#
# The cost of the miss is small and bounded: the corpus itself now carries
# "registration" and "registrations" after the vocabulary weave, so the query
# still retrieves. This rule exists for the cases prose could not reach, and a
# miss here degrades to what the corpus can do on its own rather than to a
# refusal. `test_the_sentence_final_verb_is_a_known_miss` pins it so the next
# reader finds the reasoning rather than a bug.
_SIGNUP_VERB_CONTEXT = r"(?=\s+(?:on|at)\b|\s+for\b(?!\s+(?:vat|tax|taxes|gst|gdpr)))"

# (name, pattern, replacement). Applied in order, so phrase rules precede the
# single words they contain. Word boundaries throughout, on risk.py's rule: a
# pattern that fires inside a longer word is a pattern nobody can predict.
#
# Canonical targets are the terms the corpus is densest in after the vocabulary
# weave: signups, customers, leads, subscribers, revenue.
_SYNONYMS: tuple[tuple[str, str, str], ...] = (
    # --- the measured failure -------------------------------------------------
    # Plural is unambiguous. Nobody pluralises company registration this way when
    # stating a growth goal, so this one needs no guard.
    ("registrations", r"\bregistrations\b", "signups"),
    # Singular is the trap. Every guard below names a real collision with
    # business formation or with paperwork, which is a family the golden
    # negatives defend rather than a family the corpus covers.
    (
        "registration",
        r"(?<!company )(?<!business )(?<!llc )(?<!domain )(?<!trademark )"
        r"(?<!voter )(?<!vehicle )(?<!car )\bregistration\b",
        "signup",
    ),
    # The verb, in the three forms a person actually writes. Split into rows so
    # the replacement stays grammatical: one row with a fixed replacement would
    # turn "registering" into "sign up" and read as broken English to a
    # cross-encoder that was trained on prose.
    ("register_verb_ing", r"\bregistering\b" + _SIGNUP_VERB_CONTEXT, "signing up"),
    ("register_verb_s", r"\bregisters\b" + _SIGNUP_VERB_CONTEXT, "signs up"),
    ("register_verb", r"\bregister\b" + _SIGNUP_VERB_CONTEXT, "sign up"),
    # --- orthography only -----------------------------------------------------
    # The corpus writes both "signup" and "sign-ups"; collapsing the query side
    # stabilises the sparse (tsvector) half of hybrid search, where "sign-ups"
    # and "signups" are simply different tokens.
    #
    # The bare two-word verb phrase "sign up" is deliberately NOT matched: the
    # corpus uses it in prose ("after someone signs up"), and rewriting a verb
    # into a noun buys nothing. Only the hyphenated forms and the unambiguous
    # plural noun are normalised.
    ("signup_plural_orthography", r"\bsign[- ]ups\b", "signups"),
    ("signup_orthography", r"\bsign-up\b", "signup"),
    # --- the same commitment event, other industries --------------------------
    # Course and cohort founders. Both spellings, both numbers. No collision:
    # nothing in business formation "enrols".
    ("enrolments_plural", r"\benroll?ments\b", "signups"),
    ("enrolments", r"\benroll?ment\b", "signup"),
    # App founders. Plural only: the singular "install" appears non-metrically,
    # as in "install the tracking snippet".
    #
    # Known and accepted collision: "installs" is also the third-person verb, so
    # "hardly anyone installs the app" becomes "hardly anyone signups the app".
    # Ungrammatical, and it still retrieves correctly because the cross-encoder
    # reads the topic words. The alternative, a subject-detecting guard, is
    # brittle in the direction that matters, and dropping the rule loses app
    # vocabulary entirely.
    ("installs", r"\binstalls\b", "signups"),
    # --- pre-sale contact -----------------------------------------------------
    # Service businesses say enquiries. Both spellings. The verb ("nobody
    # enquires") is deliberately absent: "nobody leads" is not English, and a
    # rule whose output is nonsense is worse than a missing rule.
    ("enquiries", r"\b[ei]nquiries\b", "leads"),
    ("enquiry", r"\b[ei]nquiry\b", "lead"),
    # B2B founders say "book more demos". Phrase forms first, so "demo calls"
    # does not survive as "leads calls".
    ("demo_phrase", r"\bdemo\s+(?:calls|requests|bookings)\b", "leads"),
    ("demos", r"\bdemos\b", "leads"),
    # --- the paying relationship ----------------------------------------------
    # Freelancers and agencies say clients. "Email clients" is the one technical
    # collision in a corpus that discusses deliverability, and it is guarded.
    ("clients", r"(?<!email )\bclients\b", "customers"),
    ("client", r"(?<!email )\bclient\b", "customer"),
    ("buyers", r"\b(?:buyers|purchasers)\b", "customers"),
    # Community and membership products. Guarded against the org senses, which
    # are not a metric and which `neg-team-pay` pins.
    ("members", r"(?<!team )(?<!staff )(?<!board )(?<!family )\bmembers\b", "subscribers"),
    # Founders name the metric by acronym; the corpus speaks in revenue.
    ("recurring_revenue", r"\b(?:mrr|arr)\b", "revenue"),
)

# Deliberately NOT mapped, recorded here so the next reader does not add them
# back without knowing what was weighed:
#
#   register (verb + object)  business formation, the collision the guards exist
#                             for. Only the preposition sense maps.
#   subscribers, trials,      already corpus vocabulary. Mapping a corpus term to
#   customers, conversions,   itself is noise; mapping it to something else is
#   sales, followers          damage.
#   bookings                  covered corpus-side by the weave. If a golden case
#                             for it ever fails, add a row here rather than
#                             editing the corpus a second time.
#   waitlist                  a mechanism, not a metric. Any noun replacement
#                             makes the sentence ungrammatical.
#   downloads                 ambiguous between an app install and a lead magnet,
#                             which are different funnel stages.
#   churn, retention,         became corpus vocabulary with the measurement
#   attribution               document. No mapping needed.
#   students, travelers,      particulars. `strip_particulars` owns those, and
#   patients, and every       the two modules must not both claim a word.
#   other ICP noun

_COMPILED: tuple[tuple[str, re.Pattern[str], str], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE), replacement)
    for name, pattern, replacement in _SYNONYMS
)


def normalise_query(query: str) -> tuple[str, tuple[str, ...]]:
    """Rewrite founder vocabulary into corpus vocabulary.

    Returns the rewritten query and the names of the rules that fired. The names
    are returned rather than discarded for the reason `high_risk_match` returns
    one: a rewrite nobody can attribute is a rewrite nobody can debug, and this
    one sits upstream of every retrieval the system does.

    Whitespace is normalised on the way out, because a replacement that shortens
    a phrase ("demo calls" to "leads") otherwise leaves a double space that the
    sparse tokeniser does not care about and a reader of the logs does.
    """
    if not query:
        return query, ()

    text = query
    fired: list[str] = []
    for name, pattern, replacement in _COMPILED:
        text, count = pattern.subn(replacement, text)
        if count:
            fired.append(name)

    return " ".join(text.split()), tuple(fired)
