-- document_supersession.sql — a re-crawled page may revert, and a citation may be opened.
--
-- Covers 20260827100000_documents_current_hash_idx.sql and
-- 20260827101000_document_source_url.sql.
--
-- Two properties, and the first is the one that is easy to get backwards.
-- `documents_source_hash_idx` exists to stop one source holding the same body
-- twice. Before this migration it enforced that across all history, including
-- superseded rows, which reads as the same rule and is not: a crawled page that
-- is edited and then reverted produces a body an old version already had, and
-- the insert failed. The narrowed index must still refuse a genuine duplicate
-- among in-force rows, so both directions are asserted rather than only the one
-- that was broken.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/document_supersession.sql

begin;

select extensions.plan(9);

-- ------------------------------------------------------------- fixtures ----

create temporary table dsids (k text primary key, v uuid) on commit drop;

create or replace function pg_temp.did(p_k text) returns uuid
language sql stable as $$ select v from dsids where k = p_k $$;

insert into dsids (k, v) values
  ('src',    gen_random_uuid()),
  ('src_b',  gen_random_uuid()),
  ('v1',     gen_random_uuid()),
  ('v2',     gen_random_uuid()),
  ('v3',     gen_random_uuid()),
  ('dupe',   gen_random_uuid()),
  ('other',  gen_random_uuid());

create or replace function pg_temp.vec() returns extensions.halfvec(1024)
language sql immutable as $$
  select ('[' || array_to_string(array_fill(0.1::real, array[1024]), ',') || ']')
           ::extensions.halfvec(1024)
$$;

insert into public.knowledge_sources (id, url, label, authority, crawl_cadence)
values
  (pg_temp.did('src'), 'https://example.test/policy', 'supersession fixture', 'official', '1 day'),
  (pg_temp.did('src_b'), 'https://example.test/other', 'second source fixture', 'official', '1 day');

-- ------------------------------------------------ the freshness columns ----

-- They have existed since 20260728210000 and nothing has ever written them. The
-- crawl sweep is their first writer, so assert they accept what it will store.
select extensions.is(
  (select crawl_cadence from public.knowledge_sources where id = pg_temp.did('src')),
  '1 day'::interval,
  'knowledge_sources.crawl_cadence holds the registry cadence'
);

update public.knowledge_sources
   set last_crawled = now(), content_hash = 'page-hash-1'
 where id = pg_temp.did('src');

select extensions.ok(
  (select last_crawled is not null and content_hash = 'page-hash-1'
     from public.knowledge_sources where id = pg_temp.did('src')),
  'and last_crawled plus content_hash record the sweep attempt and what it saw'
);

-- --------------------------------------------------- the revert scenario ----

-- Version 1: the page as first crawled.
insert into public.documents (id, source_id, title, content_hash, version, source_url)
values (pg_temp.did('v1'), pg_temp.did('src'), 'Example policy', 'body-A', 1,
        'https://example.test/policy');

-- The page is edited. Supersede, then insert version 2, exactly as
-- `Ingestor.ingest` does it.
update public.documents set valid_to = now() where id = pg_temp.did('v1');
insert into public.documents (id, source_id, title, content_hash, version, source_url)
values (pg_temp.did('v2'), pg_temp.did('src'), 'Example policy', 'body-B', 2,
        'https://example.test/policy');

-- The edit is reverted upstream. The next crawl produces body-A again. This is
-- the insert that used to fail.
update public.documents set valid_to = now() where id = pg_temp.did('v2');

select extensions.lives_ok(
  format(
    $q$insert into public.documents (id, source_id, title, content_hash, version, source_url)
       values (%L, %L, 'Example policy', 'body-A', 3, 'https://example.test/policy')$q$,
    pg_temp.did('v3'), pg_temp.did('src')
  ),
  'a reverted page re-ingests: the superseded version 1 no longer blocks a body coming back'
);

select extensions.is(
  (select count(*)::int from public.documents
    where source_id = pg_temp.did('src') and valid_to is null),
  1,
  'and exactly one version is in force afterwards'
);

-- --------------------------------------------- the duplicate still fails ----

select extensions.throws_ok(
  format(
    $q$insert into public.documents (id, source_id, title, content_hash, version)
       values (%L, %L, 'Example policy duplicate', 'body-A', 4)$q$,
    pg_temp.did('dupe'), pg_temp.did('src')
  ),
  '23505',
  null,
  'two in-force documents with one body under one source are still refused'
);

select extensions.lives_ok(
  format(
    $q$insert into public.documents (id, source_id, title, content_hash, version)
       values (%L, %L, 'Different source, same body', 'body-A', 1)$q$,
    pg_temp.did('other'), pg_temp.did('src_b')
  ),
  'the constraint is per source: two sources may legitimately publish the same text'
);

-- ------------------------------------------------------------ the citation ----

insert into public.doc_chunks (document_id, chunk_index, chunk_text, embedding)
values (pg_temp.did('v3'), 0, 'disclosure obligations for endorsements', pg_temp.vec());

select extensions.is(
  (select h.source_url from public.hybrid_search(
      pg_temp.vec(), 'disclosure obligations'
   ) h where h.document_id = pg_temp.did('v3')),
  'https://example.test/policy',
  'retrieval returns the document url, so a citation is something a reader can open'
);

-- A document with no url of its own falls back to its source's, and a source
-- with no url shows nothing rather than borrowing a sibling document's address.
insert into public.doc_chunks (document_id, chunk_index, chunk_text, embedding)
values (pg_temp.did('other'), 0, 'disclosure obligations for endorsements', pg_temp.vec());

select extensions.is(
  (select h.source_url from public.hybrid_search(
      pg_temp.vec(), 'disclosure obligations'
   ) h where h.document_id = pg_temp.did('other')),
  'https://example.test/other',
  'a document with no url of its own falls back to the source address'
);

select extensions.is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hybrid_search'),
  1,
  'still exactly one hybrid_search: replacing it in place must not leave an overload behind'
);

select * from extensions.finish();

rollback;
