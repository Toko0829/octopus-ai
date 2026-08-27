"""How a document finds the `knowledge_sources` row it hangs off.

Two regimes, and they are not interchangeable.

A **crawled page** is one source row, and `knowledge_sources_url_idx` is unique
on url. Matching it by label would fail to find the row the crawl sweep created
and then try to insert a second one straight into that unique index.

A **workspace** is one source row holding many documents, deliberately, because
document identity is `(source_id, title)`. If a workspace's row were keyed by url
then a person who pastes a regulator's URL into their own workspace would attach
their document to the regulator's source row, and titling it the same thing would
supersede the regulator's text.

The rule is expressed as "the caller passes a url or it does not", so these
assertions pin the query the client actually issues rather than the intent.

No network: httpx MockTransport.
"""

import json

import httpx
import pytest

from octopus_ai.config import Settings
from octopus_ai.db import Database


def _db(handler) -> Database:
    settings = Settings(
        supabase_url="https://example.supabase.co",
        supabase_secret_key="sb_secret_test",
        openai_api_key="sk-test",
        cohere_api_key="co-test",
    )
    return Database(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


class Recorder:
    """Answers every lookup with a miss, so the create path is exercised too."""

    def __init__(self, found: bool = False) -> None:
        self.found = found
        self.gets: list[httpx.QueryParams] = []
        self.posts: list[dict] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            self.gets.append(request.url.params)
            body = [{"id": "existing-source"}] if self.found else []
            return httpx.Response(200, json=body)
        self.posts.append(json.loads(request.content))
        return httpx.Response(201, json=[{"id": "created-source"}])


@pytest.mark.asyncio
async def test_a_url_is_looked_up_by_url():
    rec = Recorder()
    db = _db(rec)
    await db.upsert_source(
        label="Federal Trade Commission",
        authority="official",
        url="https://www.ftc.gov/business-guidance",
    )
    assert rec.gets[0].get("url") == "eq.https://www.ftc.gov/business-guidance"
    assert "label" not in rec.gets[0], "the unique index is on url, so url is the identity"


@pytest.mark.asyncio
async def test_no_url_falls_back_to_the_label():
    rec = Recorder()
    db = _db(rec)
    await db.upsert_source(label="Provided by this workspace (room-abc)", authority="vendor")
    assert rec.gets[0].get("label") == "eq.Provided by this workspace (room-abc)"
    assert "url" not in rec.gets[0]


@pytest.mark.asyncio
async def test_an_existing_row_is_reused_and_never_rewritten():
    """The crawl sweep in Node owns authority, cadence, last_crawled and the page
    hash on these rows. A second writer here would mean two components
    disagreeing about the freshness state of one source."""
    rec = Recorder(found=True)
    db = _db(rec)
    source_id = await db.upsert_source(
        label="Federal Trade Commission", authority="official", url="https://www.ftc.gov/x"
    )
    assert source_id == "existing-source"
    assert rec.posts == [], "finding a row must not update it"


@pytest.mark.asyncio
async def test_creating_a_row_records_all_three_fields():
    rec = Recorder()
    db = _db(rec)
    await db.upsert_source(
        label="Federal Trade Commission", authority="official", url="https://www.ftc.gov/x"
    )
    assert rec.posts[0] == {
        "label": "Federal Trade Commission",
        "authority": "official",
        "url": "https://www.ftc.gov/x",
    }
