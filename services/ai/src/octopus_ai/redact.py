"""Scrub identifiers out of free text before it is stored anywhere durable.

Written for `retrieval_gaps`, which keeps the questions the corpus could not
answer so somebody can decide what to ingest next. That store is new, and rule 8
says PII stays out of URLs, logs and the index; a new store does not get a new
posture just because it is useful.

## What this removes, and what it deliberately does not

It removes **identifiers**: emails, URLs and bare domains, phone numbers, and
long digit runs. It does **not** remove the person's audience, product noun or
subject matter, and that omission is the point rather than an oversight. A ledger
of refusals whose entries all read "how do I get more [redacted] for my
[redacted]" records that something was refused and nothing about what, which is
the one thing it exists to record. Reading a hundred of these is how the next
document gets chosen.

**It is the opposite trade from `intake.strip_particulars`**, and the two must not
be confused. That function is conservative toward *keeping* text, because a query
stripped too hard retrieves nothing and an empty query is unrecoverable where a
polluted one is not. This one is conservative toward *removing* text, because the
cost of over-redaction is a rare word replaced in an ops table and the cost of
under-redaction is a stored identifier. Same word, opposite directions, for
reasons that both come from what happens when the rule is wrong.

The consequence of that choice is visible and accepted: `Next.js` becomes `[url]`,
and so does a missing space after a full stop, `"...signups.then we scale"`, which
has the shape of a host. That is a legibility cost of a word or two in an ops
table nobody reads for framework names, paid to avoid
maintaining a TLD allow-list that goes stale, which is the failure mode rule 21
already names. The capitalised form of the same typo, `"signups.Then"`, survives:
see `_BARE_HOST`.

**Order matters.** Emails are taken before domains, or `ana@shop.com` would lose
its domain half first and leave a dangling local part that no later rule matches.
"""

from __future__ import annotations

import re

EMAIL_MARK = "[email]"
URL_MARK = "[url]"
PHONE_MARK = "[phone]"
NUMBER_MARK = "[number]"

# Deliberately loose on the local part: this is deciding what to delete, not
# validating an address, and a rule that only matches well-formed addresses
# leaves the malformed ones in the table.
_EMAIL = re.compile(r"[^\s@<>()\[\],;:]+@[^\s@<>()\[\],;:]+\.[a-z]{2,}", re.IGNORECASE)

# A scheme'd URL first, then a bare host. The bare-host rule allows a path, so
# "bluelly.com/pricing" goes whole rather than leaving "/pricing" behind.
_URL = re.compile(r"\b(?:https?://|www\.)\S+", re.IGNORECASE)

# **The trailing label is all-lower or all-upper, never Capitalised**, and that
# one restriction is what keeps this rule from eating sentences. A missing space
# after a full stop is a common typo, and "signups.Then we scale" has the shape of
# a domain in every respect but the capital. Real domains are typed "bluelly.com"
# or occasionally "BLUELLY.COM"; almost nobody types "Bluelly.Com", which is the
# case this misses and the one worth missing.
#
# The labels before it stay case-insensitive: "Bluelly.com" is a host and reads
# like one. Only the final label decides.
#
# The flag is set per-branch rather than globally on purpose. `re.IGNORECASE` over
# the whole pattern would make the two trailing branches identical and undo the
# restriction; leaving it off entirely makes the LEADING labels lowercase-only,
# which silently misses "Bluelly.com" and "MYSITE.COM". Both were tried.
_BARE_HOST = re.compile(
    r"\b[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*"
    r"\.(?:[a-z]{2,24}|[A-Z]{2,24})\b(?:/\S*)?"
)

# The shape people type a phone number in, with the separators they actually use
# rather than any one national format: the product is US and EU first and a
# per-country table would be wrong somewhere on day one.
_PHONE = re.compile(r"(?<![\w.])\+?\d[\d\s().-]{5,}\d(?![\w.])")

# Nine, because that is what separates a phone number from a budget range. A
# marketing goal says "1000 - 2000 a month", which has eight digits and matches
# the shape above exactly; a dialable number has nine to fifteen once the country
# code is counted. A seven-digit local number with no area code is therefore
# missed here, and caught below only if it is written without separators. That is
# the trade: a redacted budget is a worse ledger entry than a rare missed local
# number is a leak, and the alternative was a rule that eats every price a founder
# mentions.
_PHONE_MIN_DIGITS = 9

# Whatever runs long after that: account numbers, ids, order references, and the
# unseparated phone numbers the rule above declines to guess at. Six is the floor
# because five digits is still plausibly money or a follower count, and both are
# things a founder says while describing a goal.
_LONG_DIGITS = re.compile(r"(?<![\w.])\d{6,}(?![\w.])")


def _phone_sub(match: re.Match[str]) -> str:
    digits = sum(c.isdigit() for c in match.group(0))
    return PHONE_MARK if digits >= _PHONE_MIN_DIGITS else match.group(0)


def scrub(text: str) -> str:
    """Replace identifiers with markers, leaving the sentence readable.

    Markers rather than deletion, so a reader can tell the difference between "a
    founder mentioned their site" and "a founder mentioned nothing", and so a
    scrubbed goal cannot be mistaken for the raw one somebody forgot to scrub.

    Idempotent: running it twice changes nothing, because every marker is bracket
    text with no digits, no `@` and no dot. That matters because this is called on
    a path that may be retried.
    """
    if not text:
        return ""

    scrubbed = _EMAIL.sub(EMAIL_MARK, text)
    scrubbed = _URL.sub(URL_MARK, scrubbed)
    scrubbed = _BARE_HOST.sub(URL_MARK, scrubbed)
    scrubbed = _PHONE.sub(_phone_sub, scrubbed)
    scrubbed = _LONG_DIGITS.sub(NUMBER_MARK, scrubbed)

    # Collapse the whitespace the substitutions leave behind. The stored value is
    # read in a table, where a goal wrapped over four lines because somebody
    # pasted it that way is harder to scan than it needs to be.
    return " ".join(scrubbed.split())
