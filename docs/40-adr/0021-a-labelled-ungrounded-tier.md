# ADR-0021: a labelled ungrounded tier, for marketing questions the corpus does not cover

**Status:** Accepted · **Date:** 2026-09-01 · **Supersedes:** nothing · **Amends:** the "grounded, cited, current, or refused" posture in [rag.md](../10-architecture/rag.md), for non-regulated questions only.

> **Amended by [ADR-0032](0032-reasoning-providers-are-workspace-connectors.md):** this tier may run on a workspace's own connected model rather than only on the house key. Every constraint below is unchanged, including that regulated topics are declined in code before any provider is called and that the label is written by `ungrounded.frame` rather than asked of the model.

## Context

The system had one rule for every question: grounded and cited, or refused. That
rule was written for the thing it protects and it protects it correctly. It also
produced a product that answers "I do not know" to most of what it is asked, and
the measurement is unambiguous.

The shared corpus is 17 documents. Before the deepening that landed alongside this
decision it was 99 chunks and about 17,000 words, of which the internally-authored
half was 7,443. `python -m octopus_ai.evaluation --gate` reports **"blocked 1.00 of
scope negatives"** as a PASS, and the six scope negatives it blocks are webinar
funnels, conversion tracking, app-store ranking, ad-format specs, influencer
platforms and affiliate networks. Every one is a reasonable thing for a founder to
ask a marketing product. **The metric reading green is the gap list**, and nothing
in the system measured coverage of the real question space, so no number got worse
while it drifted.

The corpus is the real fix and is being grown. It will never be finished, because
a corpus always has an edge, and the question is what the product does at that
edge.

Three options were on the table.

**Keep refusing.** Preserves the promise unqualified and keeps every fix coming
from corpus growth, which is slower but leaves nothing to misuse. Its cost is the
present behaviour, which the user described as the product usually saying it does
not know.

**Answer everything and label confidence.** Rejected without much argument. It
puts uncited output on the same footing as cited output and invites exactly the
confident-wrong-and-grounded-looking failure the whole retrieval stack exists to
prevent.

**A separate tier, structurally weaker than the grounded one.** Accepted.

## Decision

Add a fourth reasoning core, `ungrounded-general-v1`, which answers from general
practice and says so, subject to five constraints that are enforced by code and
by shape rather than by prompt.

**1. It runs only where domain is yes and coverage is no.** Specifically: the
groundedness gate returned `unsupported`, on a retrieval that returned chunks. The
two checks answer different questions and that is what makes the boundary
meaningful. The rerank threshold is a **domain** check, so an out-of-domain
question clears nothing and `refusing-v0` stays a refusal; this is what defends the
golden negatives, and answering "how to get a car licence" from parametric
knowledge is precisely the leak they exist to catch. The groundedness gate is a
**coverage** check, so `unsupported` means the corpus talked and missed.

`refusing-unverified-v1` is also excluded, and separately. It means the gate could
not run. Letting a provider outage change the product's posture would make the
strict mode fail open on the days nobody is watching, which is the opposite of how
every other gate in this service degrades.

**2. It cannot propose a plan.** It emits a `post_message` and nothing else. This
is the enforcement rather than a convention: a `propose_plan` proposal is what
Node materialises into a project and a task DAG, and a task DAG is what spends
money and publishes things. Prose in a room cannot become a step. Rule 7's "authz
and spend limits live in tool code, not prompts" is therefore satisfied by the
shape of the return value, and a future change that wanted an ungrounded plan
would have to be written deliberately rather than arrived at.

**3. `grounded=False` and `citations=[]`.** Every downstream consumer already
reads those two to decide whether an output may gate a regulated or irreversible
action (rule 10). Nothing new has to learn about this core in order to refuse it.

**4. Regulated topics are excluded in code.** `ungrounded.is_regulated` matches two
families and declines both. The first is rules 10, 11 and 19 directly: legal, tax,
permit and licensing, immigration, medical, and financial advice. The second is
the regulated corners **inside** marketing, which is the half that would otherwise
be missed: advertising disclosure, privacy and consent law, claims substantiation,
and the sector rules around alcohol, gambling, supplements and children's
advertising. Those are marketing questions and they are in-domain, which is exactly
why a confident uncited answer there is the harm rule 10 describes. When a rule
fires the caller's existing refusal is returned unchanged.

**5. The label is written by the code, not asked of the model.** The model writes
the body; `ungrounded.frame` wraps it in the preface and the closing note. This
project has now measured four separate times what happens to a prompt-level
disposition: decomposition was told "most goals need one or two stages" and took
the north-star case from coverage 1.00 to 0.33; the groundedness gate was told
"when unsure, answer false" and refused 0.36 of legitimate goals; `risk.py` exists
because a model asked to self-assess a step's risk agreed and then did not; and
`strip_particulars` exists because intake was asked to remove particulars and did
not. A missing disclaimer is the same class of failure, so it is made impossible
rather than unlikely.

## Reading of rule 10, stated rather than assumed

Rule 10 says: "Legal/tax/permit outputs must **cite** retrieved jurisdiction
sources with **effective dates**; uncited or low-similarity claims are flagged
`unverified` and cannot gate a legal action; they **escalate to a human node**."

Two things follow that this decision depends on. The citation mandate is scoped to
legal, tax and permit output, which "how do I build a webinar funnel" is not. And
the stated consequence of an uncited claim is that it **cannot gate a legal
action**, not that it must be withheld. A labelled reply that cannot become a plan
step, cannot spend, and carries no citation satisfies both halves as written.

Where a question does touch those categories, constraint 4 returns it to the
refusal path, and rule 11's human escalation is unchanged.

## Consequences

**The rate is a corpus-health metric that should fall.** Every ungrounded answer is
written to `retrieval_gaps` alongside the refusals, because it is the same signal
with a different response: the corpus could not support the goal. Reading the
ingest queue means every core except `refusing-unverified-v1`. A rising share of
`ungrounded-general-v1` means the tier is working and the corpus is not keeping up.
It is not a number to report as an achievement, and it is deliberately not on a
separate table, because splitting it would let turning the tier off appear to
empty the backlog.

**`UNGROUNDED_FALLBACK` restores the old posture.** Default on, logged at startup
beside `GROUNDEDNESS_CHECK`. Turning it off is a legitimate choice for a deployment
that would rather say nothing, and it is not a safety fix, because the tier cannot
propose a plan, cannot cite, and declines regulated topics regardless.

**The eval's meaning changes, and it needed to.** `--gate` scores block rate over
the scope negatives. Those questions now reach the ungrounded tier rather than a
refusal, so the pass is measured on the gate's verdict rather than on what the
product finally said. That distinction was always there and was invisible while
the two coincided. The gate's job is unchanged: it decides whether the corpus
supports the goal, and it is still zero-tolerance about answering as though it
does.

**The risk this accepts.** A labelled ungrounded answer is still an answer, and
some people will act on it as though it were grounded. The mitigations are the
label, the inability to become a plan, the regulated exclusion list, and the fact
that acting on it requires the person to do the thing themselves rather than
approving a step the AI then executes. The residual risk is real and is the price
of not refusing most of what the product is asked.

**What would reverse this.** Evidence that the ungrounded rate is not falling as
the corpus grows, which would mean the tier had become the product rather than its
edge; or a measured case of an ungrounded answer reaching an irreversible act,
which would mean constraint 2 had a hole in it.
