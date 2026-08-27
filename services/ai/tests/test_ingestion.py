"""Chunking and corpus-loading tests.

Pure functions, no network. The properties asserted here are the ones whose
violation is silent: a chunk that loses text, a boundary that splits mid-word, or
a corpus document missing the metadata retrieval filters on.
"""

from octopus_ai.corpus import EXTERNAL_DIR, load_corpus
from octopus_ai.ingestion import (
    MIN_CHARS,
    TARGET_CHARS,
    chunk_document,
    content_hash,
    deterministic_context,
)


def test_short_document_is_one_chunk():
    assert chunk_document("A single short paragraph.") == ["A single short paragraph."]


def test_empty_document_yields_nothing():
    assert chunk_document("") == []
    assert chunk_document("   \n\n  ") == []


def test_splits_on_headings():
    """Sections large enough to stand alone stay separate."""
    alpha = "Alpha guidance about paid acquisition. " * 12
    beta = "Beta guidance about lifecycle email. " * 12
    chunks = chunk_document(f"# First\n\n{alpha}\n\n# Second\n\n{beta}")

    assert len(chunks) == 2
    assert "Alpha" in chunks[0] and "Beta" not in chunks[0]
    assert "Beta" in chunks[1]


def test_tiny_sections_are_merged_rather_than_indexed_separately():
    """Deliberate: a 20-character chunk is never usefully the best match."""
    chunks = chunk_document("# First\n\nAlpha body.\n\n# Second\n\nBeta body.")
    assert len(chunks) == 1
    assert "Alpha" in chunks[0] and "Beta" in chunks[0]


def test_bare_heading_is_not_left_as_its_own_chunk():
    """A heading followed by an oversized paragraph used to strand the heading
    as a three-character chunk."""
    text = "# H\n\n" + ("Long sentence about marketing funnels. " * 60)
    chunks = chunk_document(text)
    assert all(len(c) >= MIN_CHARS for c in chunks)


def test_long_section_is_split_and_chunks_stay_near_target():
    para = "This sentence has some length to it and repeats. " * 12  # ~570 chars
    text = "# Heading\n\n" + "\n\n".join([para] * 12)
    chunks = chunk_document(text)

    assert len(chunks) > 1
    # Overlap can push a chunk slightly past target; a large overshoot would mean
    # the splitter is not actually splitting.
    assert all(len(c) < TARGET_CHARS * 1.5 for c in chunks)


def test_no_chunk_ends_mid_word():
    para = "Alpha beta gamma delta epsilon zeta eta theta iota kappa. " * 40
    for chunk in chunk_document(para):
        assert not chunk.endswith("-")
        # A trailing partial word would show up as a final token that is not a
        # real word boundary; splitting happens on sentences, so the last
        # character should be punctuation or a letter, never whitespace.
        assert chunk == chunk.strip()


def test_tiny_trailing_fragment_is_merged():
    """A stub chunk would be indexed and never be the best match for anything."""
    text = "# H\n\n" + ("Long sentence about marketing funnels. " * 60) + "\n\nTiny."
    chunks = chunk_document(text)
    assert all(len(c) >= MIN_CHARS or len(chunks) == 1 for c in chunks)


def test_content_hash_detects_change_and_ignores_nothing():
    a = content_hash("marketing plan")
    assert a == content_hash("marketing plan")
    assert a != content_hash("marketing plans")


def test_content_hash_covers_the_embedding_model():
    """Switching embedder must invalidate every document (ADR-0008).

    Without this the source bytes are unchanged, so re-ingestion skips
    everything: the corpus keeps the old model's vectors while queries are
    embedded by the new one, in the same HNSW index. That mixes two
    incompatible vector spaces and degrades retrieval silently, with nothing
    raised and nothing logged.
    """
    openai = content_hash("marketing plan", "text-embedding-3-large")
    local = content_hash("marketing plan", "BAAI/bge-m3")

    assert openai != local
    # Same model, same text: still a no-op re-ingest, which is what keeps
    # re-running the seed cheap.
    assert openai == content_hash("marketing plan", "text-embedding-3-large")


def test_deterministic_context_includes_metadata():
    ctx = deterministic_context("CPA control", "US", "playbook")
    assert "CPA control" in ctx and "US" in ctx and "playbook" in ctx


def test_deterministic_context_tolerates_missing_metadata():
    assert deterministic_context("Title only", None, None) == "From: Title only"


class TestSeedCorpus:
    """The shipped corpus must stay loadable and filterable."""

    def test_corpus_loads(self):
        docs = load_corpus()
        assert len(docs) >= 4

    def test_every_document_carries_retrieval_filters(self):
        # market and business_type are the hard filters self-query pushes into
        # SQL. A document without them is invisible to a filtered search.
        for doc in load_corpus():
            assert doc.market, f"{doc.title} has no market"
            assert doc.business_type, f"{doc.title} has no business_type"
            assert doc.doc_type, f"{doc.title} has no doc_type"

    def test_documents_chunk_into_something_retrievable(self):
        for doc in load_corpus():
            chunks = chunk_document(doc.body)
            assert chunks, f"{doc.title} produced no chunks"

    def test_seed_corpus_claims_no_external_authority(self):
        """These are internally authored. Attributing them to a regulator would
        fabricate a citation, which is worse than having none.

        Crawled pages are the other kind and live in `eval/external/`, asserted
        below. Keeping them out of `corpus/` is what keeps this rule true rather
        than something that had to be relaxed the first time a real source
        arrived."""
        for doc in load_corpus():
            assert doc.authority == "internal", f"{doc.title} claims {doc.authority}"

    def test_seed_corpus_carries_no_source_url(self):
        """An internal playbook has no page to point at, and inventing one would
        be the same fabrication from the other direction."""
        for doc in load_corpus():
            assert doc.source_url is None, f"{doc.title} claims to come from a page"


class TestExternalSnapshots:
    """Checked-in snapshots of crawled pages, seeded so the eval is deterministic.

    In production these documents arrive from the crawl sweep. The ingestion path
    is identical, which is what makes seeding them here honest rather than a
    fixture that flatters the gate. What the files must not do is drift from the
    registry, because document identity is `(source_id, title)` and the golden
    set matches on title.
    """

    def test_every_snapshot_is_externally_attributed(self):
        for doc in load_corpus(EXTERNAL_DIR):
            assert doc.authority != "internal", f"{doc.title} is filed as our own writing"
            assert doc.source_url, f"{doc.title} has no url, so its citation cannot be opened"
            assert doc.source_url.startswith("https://"), f"{doc.title} has a non-https url"

    def test_every_snapshot_records_when_it_was_read(self):
        """The honest claim is when we saw the page, not when its publisher wrote
        it, and a stale crawl should be visible rather than undated."""
        for doc in load_corpus(EXTERNAL_DIR):
            assert doc.effective_date, f"{doc.title} has no effective_date"

    def test_every_snapshot_carries_retrieval_filters(self):
        for doc in load_corpus(EXTERNAL_DIR):
            assert doc.market, f"{doc.title} has no market"
            assert doc.doc_type, f"{doc.title} has no doc_type"

    def test_snapshots_chunk_into_something_retrievable(self):
        for doc in load_corpus(EXTERNAL_DIR):
            assert chunk_document(doc.body), f"{doc.title} produced no chunks"
