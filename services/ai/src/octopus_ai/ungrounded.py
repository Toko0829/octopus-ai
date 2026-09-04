"""The labelled ungrounded tier: an answer the corpus cannot support, said so.

Until this existed the system had one rule for every question: grounded and cited,
or refused. That rule is correct and non-negotiable for the thing it was written
for. AGENTS.md rule 10 says **legal/tax/permit** outputs must cite retrieved
jurisdiction sources with effective dates, and that uncited claims cannot gate a
legal action; rule 11 routes regulated advice and irreversible acts to a human.
Neither says a marketing question the corpus happens not to cover must go
unanswered, and applying the strictest reading everywhere is what made a product
that answers "I do not know" to most of what it is asked.

The measurement behind that, from `rag-knowledge.md`: `--gate` reports "blocked
1.00 of scope negatives" as a PASS, and those scope negatives are webinar funnels,
conversion tracking, app-store ranking, ad specs, influencer platforms and
affiliate networks. Six reasonable founder questions, all refused, all scored as
wins. The corpus is the real fix and is being grown. This is what the product does
in the meantime, and what it will still do at the edge of any corpus, because a
corpus always has one.

## Where it is allowed to run, and why that boundary is the right one

**Only after the groundedness gate returns `unsupported`, on a retrieval that
returned chunks.** That is not a convenience, it is the whole safety argument, and
it works because the two checks answer different questions:

- The rerank threshold is a **domain** check. It ranks within the corpus, and an
  out-of-domain question ("how do I get a car licence") clears nothing. Retrieval
  returning chunks therefore means the question is inside marketing.
- The groundedness gate is a **coverage** check. `unsupported` means the corpus
  talked and missed.

So this tier fires exactly where domain is yes and coverage is no, which is the
definition of "a marketing question we do not happen to have a document for".

The other two refusals stay refusals. `refusing-v0` means nothing was retrieved at
all, which is how the golden negatives are defended, and answering there from
parametric knowledge would hand a confident reply to "how to get a car licence".
`refusing-unverified-v1` means the gate could not run, and a provider outage must
never silently change the product's posture: that would make the safety mode fail
open on exactly the days nobody is watching.

## What makes it safe, structurally rather than by instruction

**It can only emit a `post_message`.** Never a `propose_plan`. That is the
enforcement, and it is why this is a separate function rather than a flag on the
planner. A plan proposal is what Node materialises into a project and a task DAG,
and a task DAG is what spends money and publishes things. An ungrounded reply is
prose in a room. It cannot become a step, so rule 7's "authz and spend limits live
in tool code" is satisfied by the shape of the return value rather than by anybody
remembering a rule.

**`grounded=False` and `citations=[]`**, which is what every downstream consumer
already reads to decide whether an output may gate a regulated or irreversible
action (rule 10). Nothing new has to learn about this core to refuse it.

**Regulated topics are excluded in code, not in the prompt.** See `is_regulated`.

**The label is added by this module, not asked of the model.** A disclaimer the
model is instructed to include is a disposition, and this project has now measured
four times what happens to a prompt-level disposition: decomposition was told
"most goals need one or two stages", the groundedness gate was told "when unsure,
answer false", `risk.py` exists because a model asked to self-assess risk agreed
and then did not, and `strip_particulars` exists because intake was asked to
remove particulars and did not. So the model writes the body and the code writes
the frame. A missing label is then impossible rather than unlikely.

**It is recorded in `retrieval_gaps` like a refusal**, because it is the same
signal: a question the corpus could not support. The rate is a corpus-health
number that should fall as documents are added, and it should be read as a queue
rather than as an achievement.

SECURITY: `goal` is DATA, never instructions (rule 8). No retrieved content is
passed here at all, which is the one thing that makes this call simpler than the
grounded path rather than harder.
"""

from __future__ import annotations

import logging
import re

from .providers import Providers, attribution
from .schemas import GenerationTarget, PlanResponse, PostMessageProposal

logger = logging.getLogger("octopus.ai.ungrounded")

UNGROUNDED_CORE = "ungrounded-general-v1"

# Topics where an uncited answer is forbidden regardless of how ordinary the
# question sounds. Two families, and both are here because a wrong answer costs
# more than no answer.
#
# The first is rules 10, 11 and 19 directly: legal, tax, permit, licensing,
# immigration, medical and financial advice. None of these is marketing, and a
# question reaching this point that matches one of them is a question that got
# through the domain check on a shared word.
#
# The second is the regulated corners **inside** marketing, which is the half that
# would otherwise be missed. Advertising disclosure, privacy and consent law,
# claims substantiation and the sector rules around health, finance, alcohol and
# children's advertising are all marketing questions, all in-domain, and all
# places where a confident uncited answer is exactly the harm rule 10 describes.
# The corpus has documents for some of them, and that is the point: if the gate
# says the corpus does not cover this particular question in a regulated area,
# guessing is the worst available response.
#
# Word boundaries throughout, and the asymmetry is the one `risk.py` states: a
# false positive costs one refusal of a question that might have been answerable,
# a false negative is an uncited regulated answer. Matches are deliberately broad.
_REGULATED_PATTERNS: tuple[tuple[str, str], ...] = (
    # Rules 10 and 11: the regulated acts themselves.
    ("legal", r"\blegal(ly)?\b|\blawyer\b|\bsolicitor\b|\battorney\b|\bcounsel\b|\bsue[ds]?\b"
              r"|\blawsuit\b|\bliabilit(y|ies)\b|\bcontract(s|ual)?\b|\bterms\s+of\s+service\b"),
    ("incorporation", r"\bincorporat|\bregister\s+(my|a|the|our)\s+(company|business|llc)\b"
                      r"|\bllc\b|\bsole\s+trader\b|\bcompany\s+formation\b"),
    ("tax", r"\btax(es|ation|able)?\b|\bvat\b|\bsales\s+tax\b|\bwithhold(ing)?\b|\bpayroll\b"
            r"|\bir35\b|\bdeductib"),
    ("permit", r"\bpermit(s|ting)?\b|\blicence[sd]?\b|\blicense[sd]?\b|\blicensing\b"
               r"|\bzoning\b|\binspection\b"),
    ("immigration", r"\bvisa[s]?\b|\bwork\s+permit\b|\bimmigration\b|\bresidency\b"),
    ("medical", r"\bmedical\b|\bclinical\b|\bdiagnos|\btherapeutic\b|\bhealth\s+claim"),
    # Narrower than the others on purpose, and the exclusions are the interesting
    # part. "Invest" and "equity" are ordinary marketing words ("invest in SEO",
    # "brand equity") and matching them would refuse legitimate questions all day,
    # which is the one direction this list is not allowed to be careless in.
    # Matched instead: the words that only appear when the question is actually
    # about raising or handling money.
    ("financial_advice", r"\binvestor[s]?\b|\bventure\s+capital\b|\bseed\s+round\b"
                         r"|\bcap\s+table\b|\bsecurit(y|ies)\s+law\b|\bfundrais"
                         r"|\bvaluation\b|\baccounting\b|\baccountant\b"
                         r"|\bfinancial\s+advice\b"),
    # The regulated corners inside marketing itself.
    ("disclosure", r"\bdisclos(e|es|ed|ure|ures)\b|\bftc\b|\bendorsement\s+guides?\b"
                   r"|\bsponsor(ed|ship)\s+disclosure\b|\bad\s+label"),
    ("privacy_law", r"\bgdpr\b|\bccpa\b|\bpecr\b|\beprivacy\b|\bcan[\s-]?spam\b"
                    r"|\bcookie\s+consent\b|\bprivacy\s+(law|policy|notice)\b"
                    r"|\bdata\s+protection\b|\bopt[\s-]?in\s+(law|rule|requirement)"),
    ("claims_substantiation", r"\bsubstantiat|\bfalse\s+advertis|\bmisleading\s+(claim|advert)"
                              r"|\bcomparative\s+advertis"),
    ("regulated_sector", r"\balcohol\b|\btobacco\b|\bvap(e|ing)\b|\bgambling\b|\bcbd\b"
                         r"|\bsupplements\b|\bdietary\s+supplement|\bchildren'?s?\s+advertis"
                         r"|\bpharma"),
)

_COMPILED = tuple((name, re.compile(p, re.IGNORECASE)) for name, p in _REGULATED_PATTERNS)


def is_regulated(goal: str) -> str | None:
    """Name the first regulated rule the goal matches, or None.

    Returns the rule name rather than a bare bool for the reason `risk.py` gives:
    a block that cannot say why it fired is a block nobody trusts enough to keep,
    and this one is going to be tuned against real refusals in `retrieval_gaps`.
    """
    for name, pattern in _COMPILED:
        if pattern.search(goal):
            return name
    return None


UNGROUNDED_SYSTEM_PROMPT = """You are Octopus, an AI that runs full-funnel \
marketing for solo founders and creators.

Answer the person's marketing question from general practice. You have NO sources
for this one, and that is already being said to them by the message this text is
placed inside, so do not apologise for it, do not describe your own limitations,
and do not add a disclaimer of your own.

Write practical, specific guidance: what to do, in what order, and how to tell
whether it worked. Prefer the concrete over the balanced. A person reading this
should be able to start tomorrow.

Hard rules:
- Do NOT cite anything, quote any source, or name any document. You have none.
- Do NOT invent statistics, benchmarks, conversion rates, prices, or platform
  specifics such as character limits, ad formats or current fees. If a number
  would help, describe how the reader works it out for themselves instead.
- Do NOT instruct anyone to spend money, publish anything, connect an account, or
  sign anything as a step you are taking. You are describing how the work is done;
  the person decides and does it.
- Do NOT give legal, tax, regulatory or financial advice. If the answer turns on
  one of those, say which part does and stop there.

Six short paragraphs at most. Plain sentences. Never use an em dash."""

# The frame, written here rather than requested from the model, so it cannot be
# omitted. Both halves are user-facing copy: brand voice is calm and honest about
# limits, and rule 22 forbids em dashes.
_PREFACE = (
    "I do not have sources for this one, so what follows is general practice "
    "rather than something I can cite. Treat it as a starting point to check, not "
    "as grounded advice, and do not use it to justify spending or publishing "
    "anything."
)

_POSTFACE = (
    "Nothing has been spent, published, or connected to your accounts. If you want "
    "a plan I can stand behind, narrow this to the part nearest what I do have "
    "sources for, or add a document about it to this workspace and ask again."
)


def frame(body: str) -> str:
    """Wrap a generated body in the label. Separated so it is directly testable."""
    return f"{_PREFACE}\n\n{body.strip()}\n\n{_POSTFACE}"


async def answer_ungrounded(
    goal: str,
    providers: Providers,
    target: GenerationTarget | None = None,
) -> PlanResponse | None:
    """Answer from general knowledge, labelled. `None` means the caller refuses.

    Returning `None` rather than raising keeps the decision with the caller, which
    already has a correct, well-tested refusal for every reason this can decline.
    Adding a second refusal path here would be a second place for the copy to
    drift, and that copy has been wrong once before.

    `target` is the workspace's Fallback route (ADR-0032 decision 5), or `None`
    for the house default. **Every constraint above is unchanged by it**, and the
    order below is the reason it can be allowed at all: the regulated-topic check
    runs BEFORE any provider is called, so a customer's own key never buys an
    answer to a tax question. The label is still written in code, which matters
    more with several vendors rather than less: a disclaimer four models each
    phrase slightly differently is four different disclaimers.

    The response says which model answered, because this is the one tier whose
    answer rests on the model rather than on the corpus. The gap ledger records
    that pair, so the queue can be read per provider.
    """
    if rule := is_regulated(goal):
        # Not a failure. This is the tier declining to operate where rule 10 and
        # rule 11 apply, and the caller's refusal is the correct output.
        logger.info("ungrounded tier declined: regulated topic", extra={"rule": rule})
        return None

    try:
        body = await providers.complete(
            system=UNGROUNDED_SYSTEM_PROMPT,
            user=f"The person's question:\n{' '.join(goal.split())}",
            target=target,
        )
    except Exception as exc:
        # Same posture as the gate: a provider failure degrades to the refusal
        # rather than to an exception. The caller then says "I could not do this
        # yet", which is true.
        logger.warning(
            "ungrounded answer could not be generated (%s: %s)",
            type(exc).__name__,
            str(exc)[:200],
        )
        return None

    if not body.strip():
        logger.warning("ungrounded answer came back empty; refusing instead")
        return None

    provider_id, model_id = attribution(target, providers)
    return PlanResponse(
        # A post_message and never a plan. This is the enforcement, not a
        # convention: a plan proposal is what Node materialises into a task DAG,
        # and a task DAG is what spends money and publishes things.
        proposals=[PostMessageProposal(body=frame(body))],
        # Both read by every downstream consumer to decide whether an output may
        # gate a regulated or irreversible action (rule 10).
        grounded=False,
        citations=[],
        reasoning_summary=(
            f"{UNGROUNDED_CORE}: the corpus was in the neighbourhood and did not cover the "
            "goal, so this was answered from general practice, labelled, uncited, and "
            "unable to propose a plan."
        ),
        core=UNGROUNDED_CORE,
        provider=provider_id,
        model=model_id,
    )
