"""Postgres access for the AI service, over PostgREST with the secret key.

ADR-0006 gives this service its own read/write access to the same Postgres. The
secret key BYPASSES RLS, so tenant scoping is passed explicitly on every call
(`p_project_id`) rather than left to a policy. That is the whole reason
`hybrid_search` takes a project parameter instead of relying on the database to
filter for us.

The key never leaves this process, and the service exposes no endpoint that
returns raw rows.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .config import Settings

logger = logging.getLogger("octopus.ai.db")

_MAX_ATTEMPTS = 3
_RETRY_STATUSES = {408, 429, 500, 502, 503, 504}

# PostgREST's code for "JWT issued at future": it compares the token's `iat`
# against its own clock and refuses if the token looks like it comes from the
# future. Our key is STATIC, so its `iat` is identical on every call and cannot
# be the variable here; the clock is. Supabase serves PostgREST from more than
# one node, so a single node with drift produces a 401 on some requests and not
# others, against the same credential, in the same second.
#
# Retried for that reason, and **only** this code among the 401s. An ordinary
# 401 means the key is wrong, where retrying burns three attempts to arrive at a
# worse error message. That distinction is the same one `providers.py` draws
# when it refuses to treat a 429 as a transient 5xx.
_CLOCK_SKEW_CODE = "PGRST303"


class DatabaseError(RuntimeError):
    pass


def to_pgvector(values: list[float]) -> str:
    """Render a vector in pgvector's text input format.

    Sent as a string rather than a JSON array because PostgREST would otherwise
    hand Postgres a json array, which has no implicit cast to halfvec.
    """
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


class Database:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._s = settings
        self._client = client or httpx.AsyncClient(timeout=settings.request_timeout_s)
        self._base = settings.supabase_url.rstrip("/")

    async def aclose(self) -> None:
        await self._client.aclose()

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self._s.supabase_secret_key,
            "Authorization": f"Bearer {self._s.supabase_secret_key}",
            "Content-Type": "application/json",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = dict(self._headers)
        if prefer:
            headers["Prefer"] = prefer

        # Bounded retry, which this client did not have and `providers.py` did.
        # The asymmetry cost a CI run: one eval shard hit a transient 401 from a
        # skewed PostgREST node, died, and because `--merge` refuses to report
        # unless every golden case is present, one lost shard took the whole gate
        # red. A single transient response must not be able to do that.
        #
        # Kept separate from `_post_with_retry` rather than shared. That function
        # is POST-only, raises ProviderError, and carries Retry-After handling
        # plus a rate-limit floor that exist for a metered provider API. Folding
        # both into one helper would parameterise away exactly the distinctions
        # each set of comments says are load-bearing.
        delay = 0.5
        last_detail = ""

        for attempt in range(1, _MAX_ATTEMPTS + 1):
            try:
                response = await self._client.request(
                    method, f"{self._base}{path}", headers=headers, json=json, params=params
                )
            except httpx.RequestError as exc:
                last_detail = f"transport error: {exc}"
                if attempt == _MAX_ATTEMPTS:
                    break
                await asyncio.sleep(delay)
                delay *= 2
                continue

            if response.status_code < 400:
                if not response.content:
                    return None
                return response.json()

            body = response.text[:400]
            last_detail = f"{response.status_code} {body}"
            retryable = response.status_code in _RETRY_STATUSES or (
                response.status_code == 401 and _CLOCK_SKEW_CODE in body
            )
            if not retryable or attempt == _MAX_ATTEMPTS:
                break

            logger.warning(
                "%s %s attempt %d failed (%s); retrying in %.1fs",
                method,
                path,
                attempt,
                last_detail,
                delay,
            )
            await asyncio.sleep(delay)
            delay *= 2

        raise DatabaseError(f"{method} {path} -> {last_detail}")

    # ------------------------------------------------------------- retrieval --

    async def hybrid_search(
        self,
        *,
        embedding: list[float],
        query: str,
        market: str | None = None,
        business_type: str | None = None,
        doc_type: str | None = None,
        candidates: int = 40,
        limit: int = 40,
        project_id: str | None = None,
        room_id: str | None = None,
    ) -> list[dict]:
        """Dense + sparse + RRF, fused inside Postgres. One round trip."""
        rows = await self._request(
            "POST",
            "/rest/v1/rpc/hybrid_search",
            json={
                "p_embedding": to_pgvector(embedding),
                "p_query": query,
                "p_market": market,
                "p_business_type": business_type,
                "p_doc_type": doc_type,
                "p_candidates": candidates,
                "p_limit": limit,
                "p_project_id": project_id,
                # The workspace asking. Shared rows always come back; this room's
                # own documents come back only to it. Stated here rather than
                # left to a policy because this client holds the secret key,
                # which bypasses RLS entirely.
                "p_room_id": room_id,
            },
        )
        return rows or []

    # ------------------------------------------------------------- ingestion --

    async def upsert_source(self, *, label: str, authority: str, url: str | None = None) -> str:
        existing = await self._request(
            "GET", "/rest/v1/knowledge_sources", params={"select": "id", "label": f"eq.{label}"}
        )
        if existing:
            return existing[0]["id"]
        created = await self._request(
            "POST",
            "/rest/v1/knowledge_sources",
            json={"label": label, "authority": authority, "url": url},
            prefer="return=representation",
        )
        return created[0]["id"]

    async def find_current_version(self, source_id: str, title: str) -> dict | None:
        """The in-force document for this (source, title), if any.

        (source_id, title) is the identity of a document across versions. Content
        hash cannot serve that role: the whole point is to detect when the same
        document's content has changed.
        """
        rows = await self._request(
            "GET",
            "/rest/v1/documents",
            params={
                "select": "id,version,content_hash",
                "source_id": f"eq.{source_id}",
                "title": f"eq.{title}",
                "valid_to": "is.null",
                "order": "version.desc",
                "limit": "1",
            },
        )
        return rows[0] if rows else None

    async def supersede_document(self, document_id: str) -> None:
        """Close a document's validity window instead of deleting it.

        Retrieval filters to in-force rows, so a superseded version stops being
        returned immediately, while the row and its chunks remain for audit and
        for answering "what did we tell them last month".
        """
        await self._request(
            "PATCH",
            "/rest/v1/documents",
            params={"id": f"eq.{document_id}"},
            json={"valid_to": "now()"},
        )

    async def insert_document(self, doc: dict) -> str:
        created = await self._request(
            "POST", "/rest/v1/documents", json=doc, prefer="return=representation"
        )
        return created[0]["id"]

    async def replace_chunks(self, document_id: str, chunks: list[dict]) -> int:
        """Write a document's chunks, replacing any that exist.

        Delete-then-insert rather than upsert: re-ingestion can change how a
        document splits, so stale chunks from a previous chunking would otherwise
        linger in the index and keep being retrieved.
        """
        await self._request(
            "DELETE", "/rest/v1/doc_chunks", params={"document_id": f"eq.{document_id}"}
        )
        if not chunks:
            return 0
        await self._request("POST", "/rest/v1/doc_chunks", json=chunks)
        return len(chunks)

    async def count_chunks(self) -> int:
        rows = await self._request(
            "GET", "/rest/v1/doc_chunks", params={"select": "id", "limit": "1"}
        )
        return len(rows or [])
