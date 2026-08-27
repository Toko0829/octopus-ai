"""The `/ingest` endpoint contract.

The crawl sweep in `apps/api` is the only caller. What it hands over is metadata
it read from a checked-in registry, and the thing this endpoint must not do is
quietly reinterpret any of it: an `authority` the registry stated as `vendor`
becoming `official` on the way in would be a fabricated provenance on the one
surface built for checking.

`/sources` is deliberately a different endpoint, and the assertion that a crawled
document carries no room owner is what keeps the shared corpus shared.

Runs with no API keys and no database, like `test_plan.py`, and for the same
reason: a suite that needs live credentials is a suite that gets skipped.
TestClient is not used as a context manager, so the lifespan never runs.
"""

from fastapi.testclient import TestClient

import octopus_ai.main as main_module
from octopus_ai.main import app

client = TestClient(app)

URL = "https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers"


def _payload(**overrides):
    body = {
        "title": "FTC Disclosures 101 for Social Media Influencers",
        "text": "Disclose a material connection where people will see it.",
        "source_label": "Federal Trade Commission",
        "source_url": URL,
        "authority": "official",
        "market": "US",
        "business_type": "digital-marketing > full-funnel",
        "doc_type": "disclosure-guidance",
        "effective_date": "2026-08-27",
        "trace": {"agent_run_id": "crawl-1", "project_id": None},
    }
    body.update(overrides)
    return body


class StubIngestor:
    """Captures the kwargs the endpoint builds, without touching a database."""

    last_kwargs: dict = {}

    def __init__(self, *_a, **_k) -> None:
        pass

    async def ingest(self, **kwargs):
        StubIngestor.last_kwargs = kwargs

        class Result:
            document_id = "document-1"
            chunks_written = 3
            skipped_unchanged = False
            superseded = False

        return Result()


def _install(monkeypatch) -> None:
    monkeypatch.setattr(main_module, "Ingestor", StubIngestor)
    main_module.state.settings = object()
    main_module.state.db = object()
    main_module.state.providers = object()


def test_a_crawled_document_is_never_owned_by_a_room(monkeypatch):
    """What a regulator publishes is not one workspace's private knowledge."""
    _install(monkeypatch)
    res = client.post("/ingest", json=_payload())
    assert res.status_code == 200
    assert StubIngestor.last_kwargs["owner_room_id"] is None


def test_registry_metadata_is_passed_through_unchanged(monkeypatch):
    """Reinterpreting any of this would be inventing provenance."""
    _install(monkeypatch)
    client.post("/ingest", json=_payload())
    kwargs = StubIngestor.last_kwargs
    assert kwargs["authority"] == "official"
    assert kwargs["market"] == "US"
    assert kwargs["doc_type"] == "disclosure-guidance"
    assert kwargs["source_url"] == URL
    assert kwargs["effective_date"] == "2026-08-27"
    assert kwargs["source_label"] == "Federal Trade Commission"


def test_the_response_reports_what_ingestion_did(monkeypatch):
    _install(monkeypatch)
    body = client.post("/ingest", json=_payload()).json()
    assert body == {
        "document_id": "document-1",
        "chunks_written": 3,
        "skipped_unchanged": False,
        "superseded": False,
    }


def test_an_unknown_authority_is_refused(monkeypatch):
    """The column is an enum. Accepting a value Postgres will reject moves the
    failure from a fast 422 to a database error inside a background sweep."""
    _install(monkeypatch)
    res = client.post("/ingest", json=_payload(authority="regulator"))
    assert res.status_code == 422


def test_a_document_with_no_url_is_refused(monkeypatch):
    """Unlike a room source, where a url is optional. A crawled document exists
    because a page does, and one without an address cannot be checked."""
    _install(monkeypatch)
    payload = _payload()
    del payload["source_url"]
    assert client.post("/ingest", json=payload).status_code == 422
