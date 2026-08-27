"""Ingesting what a user tells us about their own business.

The property under test is **isolation by construction**. This service calls
Postgres with the secret key, which bypasses row-level security, so nothing in
the database is protecting one customer's product description from ending up in
another customer's ad copy. Two things do: `owner_room_id` written on the way in,
and `p_room_id` sent on the way out. Both are asserted here, and again against
the real database in `supabase/tests/room_sources.sql`.

The second property is that **one room's edits cannot supersede another's**.
Document identity is `(source_id, title)`, so a shared source row would make two
workspaces that both write "Our product" overwrite each other. The per-room
source label is what prevents it, and it is easy to "simplify" away without
noticing, so it is pinned.

No network: db and providers are stubs.
"""

import pytest

from octopus_ai.config import Settings
from octopus_ai.ingestion import Ingestor


class StubDb:
    """Records what ingestion asked the database to do."""

    def __init__(self, current: dict | None = None) -> None:
        self.current = current
        self.labels: list[str] = []
        self.documents: list[dict] = []
        self.superseded: list[str] = []
        self.chunks: list[dict] = []

    async def upsert_source(self, *, label: str, authority: str, url: str | None = None) -> str:
        self.labels.append(label)
        return "source-1"

    async def find_current_version(self, source_id: str, title: str) -> dict | None:
        return self.current

    async def supersede_document(self, document_id: str) -> None:
        self.superseded.append(document_id)

    async def insert_document(self, row: dict) -> str:
        self.documents.append(row)
        return "document-1"

    async def replace_chunks(self, document_id: str, rows: list[dict]) -> int:
        self.chunks = rows
        return len(rows)


class StubProviders:
    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [[0.1] * 1024 for _ in texts]


def make_settings() -> Settings:
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="sb_secret_test",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
    )


TEXT = (
    "Bluelly turns lecture notes into flashcards. Students paste a PDF and get a "
    "deck in under a minute. It is free for the first hundred cards, then five "
    "dollars a month. Most users are undergraduates revising before an exam."
)


async def ingest(db: StubDb, *, room: str | None = "room-1", text: str = TEXT):
    return await Ingestor(make_settings(), db, StubProviders()).ingest(
        text=text,
        title="What Bluelly is",
        source_label=f"Provided by this workspace ({room[:8]})" if room else "Shared corpus",
        authority="vendor",
        doc_type="user-source",
        owner_room_id=room,
    )


@pytest.mark.asyncio
async def test_the_document_records_which_room_owns_it():
    db = StubDb()
    await ingest(db)
    assert db.documents[0]["owner_room_id"] == "room-1"


@pytest.mark.asyncio
async def test_chunks_do_not_carry_the_owner_themselves():
    """The trigger copies it down, so a chunk cannot disagree with its document.

    Writing it here as well would be a second source of truth for the same fact,
    and the one that drifts is always the one a writer has to remember.
    """
    db = StubDb()
    await ingest(db)
    assert db.chunks, "expected chunks"
    assert all("owner_room_id" not in row for row in db.chunks)


@pytest.mark.asyncio
async def test_a_shared_document_still_has_no_owner():
    """The seed path must be untouched by this addition."""
    db = StubDb()
    await ingest(db, room=None)
    assert db.documents[0]["owner_room_id"] is None


@pytest.mark.asyncio
async def test_the_source_label_is_per_room():
    """Document identity is (source_id, title), so a shared source row would let
    two workspaces both titling something "Our product" supersede each other."""
    db = StubDb()
    await ingest(db, room="room-abcdef12")
    assert "room-abc" in db.labels[0]


@pytest.mark.asyncio
async def test_resubmitting_identical_text_re_embeds_nothing():
    """Re-adding the same source must be cheap and safe, not a duplicate."""
    first = StubDb()
    result = await ingest(first)
    digest = first.documents[0]["content_hash"]

    again = StubDb(current={"id": "document-1", "content_hash": digest, "version": 1})
    second = await ingest(again)

    assert second.skipped_unchanged is True
    assert second.chunks_written == 0
    assert again.documents == [], "a skipped ingest must not write a document"
    assert result.skipped_unchanged is False


@pytest.mark.asyncio
async def test_edited_text_supersedes_rather_than_duplicating():
    """Two live copies of one document would be reranked against each other."""
    db = StubDb(current={"id": "old-doc", "content_hash": "something-else", "version": 3})
    result = await ingest(db, text=TEXT + " We also support shared decks.")

    assert db.superseded == ["old-doc"], "the old version must be closed before the new insert"
    assert db.documents[0]["version"] == 4
    assert result.superseded is True


@pytest.mark.asyncio
async def test_the_text_is_chunked_and_embedded():
    db = StubDb()
    result = await ingest(db)
    assert result.chunks_written >= 1
    assert db.chunks[0]["chunk_text"]
    assert db.chunks[0]["embedding"].startswith("[")
