"""Load the seed corpus from `services/ai/corpus/*.md`.

Markdown files with a small YAML-ish front matter block, kept as files rather
than Python literals so the knowledge is reviewable in a diff by someone who does
not read Python.

`CORPUS_DIR` holds **internal playbook** documents, authored here and labelled as
such. They are deliberately not attributed to regulators or ad platforms:
inventing a citation is worse than having none, because the whole point of the
citation is that a reader can check it.

`EXTERNAL_DIR` holds the other kind, and the same loader reads both. These are
snapshots of pages the crawl sweep in `apps/api` fetched, carrying the real
`source_url`, `authority` and the date they were read. They live in `eval/` and
not in `corpus/` for two reasons: nothing here authored them, and a test asserts
that everything under `corpus/` claims no external authority, which is a rule
worth keeping true rather than relaxing.

They are checked in so the eval gate is deterministic. Scoring retrieval against
whatever a live crawl happened to return that morning would mean a regression and
a publisher's edit are the same event.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

CORPUS_DIR = Path(__file__).resolve().parents[2] / "corpus"
EXTERNAL_DIR = Path(__file__).resolve().parents[2] / "eval" / "external"

_REQUIRED = ("title", "source_label", "authority")


@dataclass(frozen=True)
class CorpusDocument:
    title: str
    body: str
    source_label: str
    authority: str
    market: str | None = None
    business_type: str | None = None
    doc_type: str | None = None
    # Set on crawled snapshots, absent on internal playbooks. A document without
    # a url shows no link rather than borrowing one, because a citation pointing
    # somewhere it did not come from is worse than a citation pointing nowhere.
    source_url: str | None = None
    # The day the page was read, for a crawled document. Not the publisher's own
    # date, which we do not reliably know and will not invent.
    effective_date: str | None = None

    def as_ingest_kwargs(self) -> dict:
        return {
            "text": self.body,
            "title": self.title,
            "source_label": self.source_label,
            "authority": self.authority,
            "market": self.market,
            "business_type": self.business_type,
            "doc_type": self.doc_type,
            "source_url": self.source_url,
            "effective_date": self.effective_date,
        }


def _parse(text: str, path: Path) -> CorpusDocument:
    if not text.startswith("---"):
        raise ValueError(f"{path.name}: missing front matter")

    _, front, body = text.split("---", 2)

    meta: dict[str, str] = {}
    for line in front.strip().splitlines():
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()

    missing = [k for k in _REQUIRED if not meta.get(k)]
    if missing:
        raise ValueError(f"{path.name}: front matter missing {', '.join(missing)}")

    return CorpusDocument(
        title=meta["title"],
        body=body.strip(),
        source_label=meta["source_label"],
        authority=meta["authority"],
        market=meta.get("market"),
        business_type=meta.get("business_type"),
        doc_type=meta.get("doc_type"),
        source_url=meta.get("source_url"),
        effective_date=meta.get("effective_date"),
    )


def load_corpus(directory: Path | None = None) -> list[CorpusDocument]:
    """Read every document in the corpus directory, sorted for deterministic order."""
    root = directory or CORPUS_DIR
    if not root.exists():
        return []
    return [_parse(p.read_text(encoding="utf-8"), p) for p in sorted(root.glob("*.md"))]
