"""Read the RAG corpus, the stage map, the golden set and eval shards.

Stdlib only, and deliberately so: this must run on a laptop with no `services/ai`
virtualenv, no model weights and no database, because the whole point is to be
cheap enough to run on every eval and attach to a PR.

**Nothing here is a second source of truth.** Every fact is read from the file
that already owns it:

    documents         services/ai/corpus/*.md, services/ai/eval/external/*.md
    stage map         the Stage/Documents table in docs/30-modules/rag-knowledge.md
    golden set        services/ai/eval/golden.json
    per-case results  the shard JSON the eval already writes (--shard N/5 --out)

Where a fact has no owning file, this module reports its absence rather than
supplying it. That is why `unmapped_documents` and `missing_documents` are
findings: a document nobody mapped to a funnel stage is doc drift, and the honest
thing to do with drift is show it, not paper over it with a table kept here.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up for AGENTS.md, which only the repo root has."""
    here = (start or Path(__file__)).resolve()
    for candidate in [here, *here.parents]:
        if (candidate / "AGENTS.md").is_file():
            return candidate
    raise FileNotFoundError("not inside the Octopus repo (no AGENTS.md above this file)")


# --- documents ---------------------------------------------------------------


@dataclass(frozen=True)
class Document:
    slug: str
    title: str
    origin: str  # "internal" | "external"
    market: str | None
    doc_type: str | None
    authority: str | None
    source_url: str | None
    effective_date: str | None
    words: int


def _parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """Mirror of `octopus_ai.corpus._parse`'s front matter reader.

    Reimplemented rather than imported because importing it drags in the AI
    service's dependency tree, and this tool's value is that it runs anywhere.
    It is eight lines and reads the same shape; if the corpus format ever grows
    something this cannot parse, the loader below drops the document rather than
    guessing at it, and a dropped document shows up as a finding.
    """
    if not text.startswith("---"):
        return {}, text
    _, front, body = text.split("---", 2)
    meta: dict[str, str] = {}
    for line in front.strip().splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta, body.strip()


def load_documents(root: Path) -> list[Document]:
    """Every document in the seeded corpus, internal and externally sourced.

    Both directories, because `seed.py` ingests both and the corpus retrieval
    actually searches is the union. Reporting only `corpus/` would show four
    fewer documents than the pipeline holds.
    """
    sources = [
        (root / "services" / "ai" / "corpus", "internal"),
        (root / "services" / "ai" / "eval" / "external", "external"),
    ]
    docs: list[Document] = []
    for directory, origin in sources:
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob("*.md")):
            meta, body = _parse_front_matter(path.read_text(encoding="utf-8"))
            if not meta.get("title"):
                continue
            docs.append(
                Document(
                    slug=path.stem,
                    title=meta["title"],
                    origin=origin,
                    market=meta.get("market"),
                    doc_type=meta.get("doc_type"),
                    authority=meta.get("authority"),
                    source_url=meta.get("source_url"),
                    effective_date=meta.get("effective_date"),
                    words=len(body.split()),
                )
            )
    return docs


# --- the funnel-stage map, read from the doc that owns it ---------------------

_STAGE_TABLE_HEADER = re.compile(r"^\s*>?\s*\|\s*Stage\s*\|\s*Documents\s*\|", re.IGNORECASE)
_ROW = re.compile(r"^\s*>?\s*\|(.+?)\|(.+)\|\s*$")
_SLUG = re.compile(r"`([a-z0-9][a-z0-9-]+)`")


def load_stage_map(root: Path) -> dict[str, list[str]]:
    """Stage to document slugs, parsed from rag-knowledge.md's coverage table.

    Parsed rather than copied. The table is the module doc's claim about what
    covers each funnel stage; keeping a second copy here would mean the lens
    could report full coverage of a stage the corpus had stopped covering, which
    is the exact class of drift it exists to catch.
    """
    path = root / "docs" / "30-modules" / "rag-knowledge.md"
    stages: dict[str, list[str]] = {}
    in_table = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if _STAGE_TABLE_HEADER.match(line):
            in_table = True
            continue
        if not in_table:
            continue
        match = _ROW.match(line)
        if not match:
            break
        stage = match.group(1).strip().strip("|").strip()
        if not stage or set(stage) <= set("-: "):
            continue  # the header separator row
        stages[stage] = _SLUG.findall(match.group(2))
    return stages


# --- golden set --------------------------------------------------------------


@dataclass(frozen=True)
class GoldenCase:
    id: str
    query: str
    expect_docs: list[str]
    notes: str | None
    kind: str  # "positive" | "negative" | "scope-negative"


def load_golden(root: Path) -> list[GoldenCase]:
    """The golden set, keeping the two negative kinds distinguishable.

    `negative` is out-of-scope for the corpus and retrieval must return nothing.
    `scope-negative` is in-vocabulary but uncovered, where retrieval leaks by
    design and the groundedness gate is what refuses. Collapsing them would
    misreport the second as a retrieval failure.
    """
    raw = json.loads(
        (root / "services" / "ai" / "eval" / "golden.json").read_text(encoding="utf-8")
    )
    cases = [
        GoldenCase(
            id=c["id"],
            query=c["query"],
            expect_docs=list(c.get("expect_docs", [])),
            notes=c.get("notes"),
            kind="negative" if not c.get("expect_docs") else "positive",
        )
        for c in raw.get("cases", [])
    ]
    cases += [
        GoldenCase(
            id=c["id"],
            query=c["query"],
            expect_docs=[],
            notes=c.get("notes"),
            kind="scope-negative",
        )
        for c in raw.get("scope_negatives", [])
    ]
    return cases


# --- eval shard results ------------------------------------------------------


@dataclass(frozen=True)
class CaseResult:
    """One scored case, as `octopus_ai.evaluation.result_to_dict` writes it."""

    id: str
    query: str
    expect_docs: list[str]
    retrieved_titles: list[str]
    top_score: float | None
    candidates: int
    dropped: int

    @property
    def is_negative(self) -> bool:
        return not self.expect_docs

    @property
    def hit(self) -> bool:
        return any(t in self.expect_docs for t in self.retrieved_titles)

    @property
    def leaked(self) -> bool:
        return self.is_negative and bool(self.retrieved_titles)

    @property
    def rank_of_first_hit(self) -> int | None:
        for i, title in enumerate(self.retrieved_titles, 1):
            if title in self.expect_docs:
                return i
        return None

    @property
    def coverage(self) -> float:
        if not self.expect_docs:
            return 1.0
        found = {t for t in self.retrieved_titles if t in self.expect_docs}
        return len(found) / len(self.expect_docs)


def load_shards(paths: list[Path]) -> dict[str, CaseResult]:
    """Merge shard files into one case-id-keyed run.

    Later files win on a duplicate id. No verdict is computed here and none
    should be: `octopus_ai.evaluation --merge` owns the thresholds and is the
    gate, and a second implementation of the same arithmetic is a second thing
    that can disagree with CI.
    """
    out: dict[str, CaseResult] = {}
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for d in payload.get("results", []):
            out[d["id"]] = CaseResult(
                id=d["id"],
                query=d["query"],
                expect_docs=list(d.get("expect_docs") or []),
                retrieved_titles=list(d.get("retrieved_titles") or []),
                top_score=d.get("top_score"),
                candidates=d.get("candidates", 0),
                dropped=d.get("dropped", 0),
            )
    return out


# --- retrieval traces (written by probe.py) ----------------------------------


@dataclass(frozen=True)
class Probe:
    query: str
    subqueries: list[str]
    threshold: float
    kept: int
    dropped: int
    scored: list[dict]
    gate: dict | None = None

    @property
    def top_score(self) -> float | None:
        return max((s["rerank_score"] for s in self.scored), default=None)

    @property
    def margin(self) -> float | None:
        """Top score as a multiple of the threshold.

        The single most useful number on the page. Under roughly 2x, a synonym
        the corpus does not happen to contain is enough to turn this answer into
        a refusal: that pair measured at 1.76x, and from outside it looked
        identical to having nothing relevant at all.
        """
        top = self.top_score
        if top is None or not self.threshold:
            return None
        return top / self.threshold


@dataclass(frozen=True)
class TraceFile:
    settings: dict = field(default_factory=dict)
    probes: list[Probe] = field(default_factory=list)


def load_trace(path: Path | None) -> TraceFile | None:
    if path is None or not path.is_file():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    return TraceFile(
        settings=raw.get("settings", {}),
        probes=[
            Probe(
                query=p["query"],
                subqueries=list(p.get("subqueries") or []),
                threshold=float(p.get("threshold") or 0.0),
                kept=p.get("kept", 0),
                dropped=p.get("dropped", 0),
                scored=list(p.get("scored") or []),
                gate=p.get("gate"),
            )
            for p in raw.get("probes", [])
        ],
    )
