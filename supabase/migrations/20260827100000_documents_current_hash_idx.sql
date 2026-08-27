-- 20260827100000_documents_current_hash_idx.sql — dedupe among current documents, not across history.
-- Owner doc: docs/10-architecture/data-model.md
--
-- `20260728210000_rag_schema.sql` created:
--
--   create unique index documents_source_hash_idx on public.documents (source_id, content_hash)
--     where source_id is not null;
--
-- which is correct for the world it was written in, where a document is ingested
-- once from a file somebody edits forward. Supersession keeps the old row and
-- only sets `valid_to`, so every version a source has ever had stays in the
-- index, and the constraint therefore reads "this source has never had a
-- document with this body" rather than "this source does not currently have
-- one".
--
-- **Re-crawling breaks that, and it breaks it on the ordinary case rather than
-- an exotic one.** A page is edited and re-crawled: version 2 is inserted, and
-- version 1 stays in the table with `valid_to` set. The edit is then reverted,
-- which happens constantly on policy pages (a typo fix, a rolled-back change, a
-- CMS republishing last week's text). The next crawl produces a body byte
-- identical to version 1, `content_hash` matches the superseded row, and the
-- insert fails with a unique violation. The document is stuck at the version we
-- happen to have, the ingest reports an error nobody can act on, and the fix
-- would be to delete audit history.
--
-- Narrowed to current rows. What the index still guarantees is the property
-- that actually matters: one source cannot hold two *in-force* documents with
-- the same body, so a bug that ingests twice is still refused. What it stops
-- claiming is that a body can only ever appear once in a source's history,
-- which is not true of anything that is crawled repeatedly.
--
-- Note this does not weaken the skip-unchanged path. That compares against
-- `find_current_version(source_id, title)` in the service and returns early
-- before any insert, so an unchanged page never reaches this index at all.

drop index if exists public.documents_source_hash_idx;

create unique index documents_source_hash_idx on public.documents (source_id, content_hash)
  where source_id is not null and valid_to is null;

comment on index public.documents_source_hash_idx is
  'One source cannot hold two in-force documents with the same body. Deliberately '
  'scoped to valid_to is null: a re-crawl that reverts a page to a body an earlier '
  'superseded version already had is a normal event, not a duplicate.';
