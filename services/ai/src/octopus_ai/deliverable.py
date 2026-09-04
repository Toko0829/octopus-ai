"""What kind of thing a step is asking for, decided in code.

The executor had one prompt for every step. "Write three headline variations for
the cold-traffic ad set" and "define our positioning against the two incumbents"
are not the same request, and answering both with the same instruction produced
the same thing for both: an essay *about* the work rather than the work. A person
approved a plan, waited, and got prose they still had to act on.

**Classified here rather than asked of the planner.** The planner could emit a
kind per step, and that would mean a schema field, a contract field, a migration
and a card change to move one string that the step's own words already carry.
The executor re-retrieves per step instead of inheriting the plan's sources for
exactly this reason: the step is the right unit, and it is right here. If a
future kind genuinely cannot be read off the step, that is the point to make the
planner state it.

**Code rather than a model, following `risk.py`.** Same reasoning, weaker stakes:
a misclassification produces the wrong shape of deliverable, not an unattended
spend. But a pattern table is inspectable, free, and cannot drift between runs,
and the vocabulary is drawn from the tool table in `marketing-growth-engine.md`
so the tools and the deliverables they map to cannot separate.

**`analysis` is the default and it is not a failure case.** Positioning, ICP,
research and measurement steps genuinely are prose, and forcing them into a
variant table would be the same mistake in the opposite direction. The default is
the behaviour that shipped, kept deliberately.
"""

from __future__ import annotations

import re
from typing import Literal

DeliverableKind = Literal["copy", "landing", "sequence", "brief", "analysis"]

# Ordered: the first match wins, so the more specific kinds are listed first.
# `sequence` precedes `copy` because an email sequence is copy, and the sequence
# prompt is the one that produces something usable. `landing` precedes both
# because "landing page copy" is a page, not a set of ad variants.
#
# Word boundaries throughout, for the reason risk.py records: "ad" must not fire
# on "adjust", "post" must not fire on "positioning".
_PATTERNS: tuple[tuple[DeliverableKind, str], ...] = (
    (
        "landing",
        r"\b(landing\s+page|landing|lander|sales\s+page|squeeze\s+page|"
        r"conversion\s+page|hero\s+section|above\s+the\s+fold)\b",
    ),
    (
        "sequence",
        r"\b(email\s+(sequence|series|flow|drip|nurture|campaign)|welcome\s+(sequence|series)|"
        r"drip\s+(sequence|campaign)|nurture\s+(sequence|flow)|autoresponder)\b",
    ),
    # `brief` precedes `copy`, and that order was decided by a real step getting
    # it wrong. "Create a brief for 3 distinct paid hooks" matched `hooks?` under
    # `copy` and came back as five finished ad variants: not what was asked for,
    # and not even the right number, because the copy prompt fixes five. A step
    # that says the word "brief" is asking to be briefed. The word is explicit
    # where `hooks` is a topic, so the explicit one wins.
    (
        "brief",
        r"\bbriefs?\b|"
        r"\b(creative\s+(direction|concepts?)|art\s+direction|"
        r"visuals?|imagery|image[s]?|video|thumbnail|storyboard|moodboard|shot\s+list)\b",
    ),
    (
        "copy",
        r"\b(ad\s+copy|copy|headlines?|primary\s+text|captions?|taglines?|"
        r"call[-\s]to[-\s]action|ctas?|hooks?|subject\s+lines?|"
        r"ad\s+(variations?|variants?|creatives?\s+copy)|posts?)\b",
    ),
)


def classify(title: str, detail: str) -> DeliverableKind:
    """What shape of deliverable this step is asking for.

    Reads title and detail together, because a title is a label ("Creative") and
    the detail is what says which creative problem the plan identified.
    """
    haystack = f"{title} {detail}".lower()
    for kind, pattern in _PATTERNS:
        if re.search(pattern, haystack):
            return kind
    return "analysis"


# What each kind must produce. Appended to the executor's shared rules, which
# carry grounding, citations, brand voice and the untrusted-sources warning, so
# those cannot drift per kind.
#
# Each one asks for a STRUCTURE rather than a quality. "Write good copy" is a
# disposition and this project has measured twice what happens to those; "produce
# five variants, each with a named angle" is checkable, and the checker's
# `too_short` rule has something real to measure.
# The brief opens with a claim about this system's own capability, and the claim
# stopped being constant in slice 6. A workspace that has routed a Creative model
# does generate images; one that has not does not; and the brief is the surface
# where a person reads which of those they are holding.
#
# **Split rather than patched at the call site.** The alternative was a string
# replace over the first sentence, which would silently produce the wrong brief
# the first time somebody rewords it, and the wrong brief here is one that
# promises images a workspace cannot make. Two openings and one body, so the
# sections cannot drift apart between the variants.
#
# Neither opening asks the model to describe the pictures it is about to draw.
# The generator's prompt is built in code from the Concept and Art direction
# sections (ADR-0033), so the brief is written for a reader either way and the
# prompt is derived from what was approved.
_BRIEF_OPENINGS: dict[bool, str] = {
    False: """This step asks for visual creative, and **this system cannot generate images
yet**, so `body` is the brief a person or a generator would work from. Say so in
one plain sentence at the top, without apologising.
""",
    True: """This step asks for visual creative. Images will be generated from this brief,
so `body` is the brief itself: the Concept and Art direction sections below are
what the generator is given, and everything in them has to be literal enough to
draw. Do not describe the images as though they already exist, and do not say
that you cannot make them.
""",
}

_BRIEF_BODY = """
Then, using exactly these sections:

  ## Concept
  One paragraph: the single idea the visual carries.
  ## Shot list
  Three concepts, each a sentence describing what is literally in frame.
  ## Art direction
  Palette, type, mood, and what to avoid.
  ## Specs
  Formats and ratios for the channels this plan names. If the sources do not
  carry current platform specs, say so rather than quoting numbers from memory:
  they go stale between crawls and rag.md forbids it."""


_INSTRUCTIONS: dict[DeliverableKind, str] = {
    "copy": """This step asks for copy, so `body` is the copy itself, ready to paste.

Produce FIVE variants. Each one is:

  ## Variant N, <the angle in three words or fewer>
  Headline: <under 40 characters>
  Primary text: <under 125 characters>
  CTA: <2 to 4 words>

The five angles must genuinely differ, not reword each other: lead with the
problem, the outcome, the objection, the proof, and the audience in turn. If the
sources support one angle and not another, write the ones they support and say at
the end which you left out and why.

No commentary above the variants and no explanation of what copywriting is.""",
    "landing": """This step asks for a landing page, so `body` is the page, section by section,
ready to hand to whoever builds it.

Use exactly these sections, in order, each with the real words rather than a
description of them:

  ## Hero
  Headline, subhead, primary CTA.
  ## Problem
  ## What it does
  ## Proof
  If the sources carry no proof material, write "No proof material in sources"
  rather than inventing a testimonial or a number.
  ## Objections
  Two or three, each answered in a sentence.
  ## Final CTA

No wireframe notes, no CSS, no "consider adding".""",
    "sequence": """This step asks for an email sequence, so `body` is the emails themselves.

Produce FOUR emails. Each one is:

  ## Email N, day <n>, <its job in three words or fewer>
  Subject: <under 50 characters>
  Preview: <under 90 characters>
  Body: <120 to 200 words, written to be sent>

Each email does one job and ends with one ask. Do not write the same email four
times with different subject lines.""",
    "brief": _BRIEF_OPENINGS[False] + _BRIEF_BODY,
    "analysis": """This step asks for thinking rather than an asset, so `body` is the conclusion
and the reasoning that supports it.

Lead with the answer in the first two sentences. Then the reasoning. Then, if the
sources leave part of the step uncovered, what is missing.

Write the decision, not a description of how one would decide.""",
}


# Steps say how many they want ("three headline variations", "a brief for 3
# distinct paid hooks"), and the prompts state a default count. When the step is
# explicit, the step wins: the plan is what the person approved, and returning
# five where they approved three is the executor overruling them on the one
# detail they were specific about.
#
# Only 2 to 9, spelled or numeric. Bigger numbers in a step are far more likely
# to be a budget, an age range or a deadline than a count of deliverables.
_COUNT_WORDS = {
    "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9,
}
_COUNT_RE = re.compile(
    r"\b(?P<n>[2-9]|two|three|four|five|six|seven|eight|nine)\s+"
    r"(?:distinct\s+|different\s+|separate\s+|genuinely\s+different\s+)?"
    r"(?:paid\s+|ad\s+|email\s+)?"
    r"(?P<noun>variants?|variations?|hooks?|concepts?|briefs?|headlines?|emails?|angles?)\b",
    re.I,
)

# The count each prompt states by default, so a step that says nothing keeps the
# behaviour that shipped.
_DEFAULT_COUNTS: dict[DeliverableKind, tuple[str, int]] = {
    "copy": ("FIVE variants", 5),
    "sequence": ("FOUR emails", 4),
    "brief": ("Three concepts", 3),
}


def requested_count(title: str, detail: str) -> int | None:
    """How many the step asked for, or None if it did not say."""
    m = _COUNT_RE.search(f"{title} {detail}")
    if not m:
        return None
    n = m.group("n").lower()
    return _COUNT_WORDS.get(n, int(n) if n.isdigit() else None)


def instruction_for(
    kind: DeliverableKind,
    count: int | None = None,
    images: bool = False,
) -> str:
    """The per-kind half of the execute prompt, honouring a count the step named.

    `images` says whether this workspace can actually generate them, and it
    changes exactly one thing: which sentence the brief opens with. Defaulted to
    False so every existing caller keeps the brief that shipped, which is also the
    honest one for a workspace that has connected nothing.
    """
    instruction = _BRIEF_OPENINGS[images] + _BRIEF_BODY if kind == "brief" else _INSTRUCTIONS[kind]
    default = _DEFAULT_COUNTS.get(kind)
    if count is None or default is None or count == default[1]:
        return instruction

    phrase, _ = default
    unit = phrase.split(" ", 1)[1]
    return instruction.replace(phrase, f"{count} {unit}", 1)


# ---------------------------------------------------------- the image prompt --
#
# What the generator is actually handed, read out of the brief the model just
# wrote rather than asked of it as a second field.
#
# **The brief is what a person approves and what a person can check.** Letting the
# model emit its own image prompt beside the brief would create a second
# deliverable nobody reads and nothing renders, and the first time the two
# disagreed the picture would have come from the one that was never on the card.
# Deriving it here means what was approved and what was drawn are the same words
# (ADR-0033).
#
# Concept and Art direction, and deliberately not Shot list or Specs. Concept is
# the idea and Art direction is palette, type and mood, which is what an image
# model works from. Shot list describes three different frames, and folding all of
# them into one prompt asks for a single picture of three ideas; Specs are ratios
# and file formats, which the request already carries as fields.

_SECTION_RE = re.compile(r"^[ \t]*#{1,4}[ \t]*(?P<name>[^\n#]+?)[ \t]*$", re.M)

# The generator's own limit, mirrored from `GenerateImageProposal.prompt`. Stated
# here rather than imported, because this function is about the brief and the
# schema is about the wire: they agree today, and a change to either should be a
# decision rather than a surprise.
IMAGE_PROMPT_MAX = 1000


def _sections(body: str) -> dict[str, str]:
    """The brief's headed sections, keyed by lowercased heading."""
    out: dict[str, str] = {}
    matches = list(_SECTION_RE.finditer(body))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        out[m.group("name").strip().lower()] = body[m.end() : end].strip()
    return out


def image_prompt_from_brief(body: str, limit: int = IMAGE_PROMPT_MAX) -> str | None:
    """One paragraph to draw from, or None when the brief has nothing to draw.

    None rather than a best effort on an empty brief: an image generated from no
    description is a stock picture with a bill attached, and the brief is
    delivered either way.

    Falls back to the whole body when the model did not use the headings it was
    given, because a brief with the right words and the wrong formatting is still
    a brief, and the alternative is silently drawing nothing on a step somebody
    approved.

    Truncated at a word boundary, since the vendor rejects an over-length prompt
    outright and half a sentence draws better than a refused call.
    """
    found = _sections(body)
    parts = [
        f"{label}: {found[key]}"
        for key, label in (("concept", "Concept"), ("art direction", "Art direction"))
        if found.get(key)
    ]
    text = ("\n\n".join(parts) if parts else body).strip()
    if not text:
        return None
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip()
