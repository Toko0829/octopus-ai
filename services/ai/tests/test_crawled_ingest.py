"""Ingesting a crawled page into the shared corpus.

Three properties, and each of them is a way an externally-cited document could
quietly become something else.

**A crawled document is shared.** It carries no room owner, so every workspace
retrieves it. That is the whole point of crawling a regulator: what the FTC
publishes is not one customer's private knowledge. The room path is the mirror
image and is covered in `test_sources.py`.

**Its source row is keyed by url, and a room's is not.** `knowledge_sources` is
unique on url, so a crawled page is one row; a workspace is one row holding many
documents. Passing a url in the room case would let somebody who pastes a
regulator's URL into their own workspace attach their document to the crawl
source and, because identity is `(source_id, title)`, supersede the regulator's
text by titling theirs the same.

**The url reaches the document.** `POST /sources` accepted `source_url` and threw
it away for as long as it existed, so every citation the product has ever
rendered has been unopenable. That is asserted here rather than left to review.

No network: db and providers are stubs.
"""

import pytest

from octopus_ai.config import Settings
from octopus_ai.ingestion import Ingestor


class StubDb:
    """Records what ingestion asked the database to do."""

    def __init__(self, current: dict | None = None) -> None:
        self.current = current
        self.source_calls: list[dict] = []
        self.documents: list[dict] = []
        self.superseded: list[str] = []
        self.chunks: list[dict] = []

    async def upsert_source(self, *, label: str, authority: str, url: str | None = None) -> str:
        self.source_calls.append({"label": label, "authority": authority, "url": url})
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


URL = "https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers"

TEXT = (
    "If you endorse a product through social media, your endorsement message "
    "should make it obvious when you have a relationship with the brand. A "
    "material connection could be a personal, family, or employment relationship "
    "or a financial relationship, such as the brand paying you or giving you free "
    "or discounted products or services. Disclose the connection where people "
    "will see it, in the endorsement message itself rather than in a profile or "
    "behind a more link."
)


async def crawl_ingest(db: StubDb, *, text: str = TEXT, url: str | None = URL):
    """The call the /ingest endpoint makes, with nothing owning the document."""
    return await Ingestor(make_settings(), db, StubProviders()).ingest(
        text=text,
        title="FTC Disclosures 101 for Social Media Influencers",
        source_label="Federal Trade Commission",
        authority="official",
        source_url=url,
        market="US",
        business_type="digital-marketing > full-funnel",
        doc_type="disclosure-guidance",
        effective_date="2026-08-27",
        owner_room_id=None,
    )


@pytest.mark.asyncio
async def test_a_crawled_document_is_shared_with_every_workspace():
    db = StubDb()
    await crawl_ingest(db)
    assert db.documents[0]["owner_room_id"] is None


@pytest.mark.asyncio
async def test_the_document_carries_the_page_it_was_read_from():
    """A citation nobody can open is the thing this whole path exists to end."""
    db = StubDb()
    await crawl_ingest(db)
    assert db.documents[0]["source_url"] == URL


@pytest.mark.asyncio
async def test_the_registry_metadata_reaches_the_row():
    """authority, market and doc_type are stated by the registry, not inferred.

    Whether a page is authoritative is an editorial call; deriving it from a
    hostname is how a vendor blog becomes a regulator.
    """
    db = StubDb()
    await crawl_ingest(db)
    row = db.documents[0]
    assert row["market"] == "US"
    assert row["doc_type"] == "disclosure-guidance"
    assert row["effective_date"] == "2026-08-27"
    assert db.source_calls[0]["authority"] == "official"


@pytest.mark.asyncio
async def test_the_shared_source_row_is_matched_by_url():
    """knowledge_sources is unique on url, so a crawled page is one row."""
    db = StubDb()
    await crawl_ingest(db)
    assert db.source_calls[0]["url"] == URL


@pytest.mark.asyncio
async def test_a_room_source_never_keys_its_source_row_on_a_url():
    """Otherwise a workspace could attach itself to a regulator's source row and
    supersede its text by reusing the title. The document still keeps the url."""
    db = StubDb()
    await Ingestor(make_settings(), db, StubProviders()).ingest(
        text=TEXT,
        title="What our product does",
        source_label="Provided by this workspace (room-abc)",
        authority="vendor",
        source_url="https://example.com/about",
        doc_type="user-source",
        owner_room_id="room-abcdef12",
    )
    assert db.source_calls[0]["url"] is None, "a room must not claim a page's source row"
    assert db.documents[0]["source_url"] == "https://example.com/about"


@pytest.mark.asyncio
async def test_an_unchanged_page_re_embeds_nothing():
    """The sweep already skips unchanged pages by hash; this is the second net,
    and it catches the case the first cannot: same bytes, different embedder."""
    first = StubDb()
    await crawl_ingest(first)
    digest = first.documents[0]["content_hash"]

    again = StubDb(current={"id": "document-1", "content_hash": digest, "version": 1})
    result = await crawl_ingest(again)

    assert result.skipped_unchanged is True
    assert again.documents == []


@pytest.mark.asyncio
async def test_an_edited_page_supersedes_rather_than_duplicating():
    """Two live copies of one policy page would be reranked against each other."""
    db = StubDb(current={"id": "old-doc", "content_hash": "previous", "version": 2})
    result = await crawl_ingest(db, text=TEXT + " Platform labels may not be enough on their own.")

    assert db.superseded == ["old-doc"]
    assert db.documents[0]["version"] == 3
    assert result.superseded is True
