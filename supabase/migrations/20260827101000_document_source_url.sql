-- 20260827101000_document_source_url.sql — a citation you can actually open.
-- Owner doc: docs/10-architecture/data-model.md
--
-- `hybrid_search` already returns `source_url`, `retrieval.py` already carries
-- it onto every chunk, `Citation` already has a `url` field, and
-- `packages/contracts` already ships it to the browser. The whole wire has been
-- built for this and every value on it is null, because the only writer of
-- `knowledge_sources.url` is a code path that hardcodes NULL.
--
-- **Why the column goes on the document rather than only being fixed upstream.**
-- `knowledge_sources.url` is the address of a *source*: one row per crawled page
-- is fine, but the room path deliberately keeps one source row per workspace
-- (`Provided by this workspace (…)`) holding many documents, because document
-- identity is `(source_id, title)` and per-URL source rows there would let two
-- workspaces supersede each other. So a workspace's source row cannot carry a
-- URL that means anything, while each document under it can: this is the page
-- *this version* was read from.
--
-- Reading `coalesce(d.source_url, ks.url)` keeps both true. A crawled document
-- gets its own URL and would fall back to its source's; a document nobody gave
-- a URL to still shows nothing rather than borrowing a sibling's address, which
-- would be a false citation on the one surface built for checking.

alter table public.documents add column if not exists source_url text;

comment on column public.documents.source_url is
  'The page this exact version was read from. knowledge_sources.url is the '
  'source''s canonical address; this is the document''s, which is not the same '
  'thing once one source row holds many documents.';

-- ------------------------------------------------------------ the retrieval ----

-- Restated in full, per the convention 20260817120000 set: the signature and the
-- returned columns are unchanged, so no caller moves. The only difference from
-- that file is `ks.url` becoming `coalesce(d.source_url, ks.url)` in the final
-- select, which needs `d.source_url` carried through the `scoped` CTE.
create or replace function public.hybrid_search(
  p_embedding      extensions.halfvec(1024),
  p_query          text,
  p_market         text default null,
  p_business_type  text default null,
  p_doc_type       text default null,
  p_lang           regconfig default 'english',
  p_candidates     int default 40,
  p_limit          int default 40,
  p_rrf_k          int default 60,
  p_project_id     uuid default null,
  p_as_of          timestamptz default now(),
  p_room_id        uuid default null
)
returns table (
  chunk_id       uuid,
  document_id    uuid,
  chunk_text     text,
  context_prefix text,
  chunk_index    int,
  title          text,
  market         text,
  doc_type       text,
  effective_date date,
  valid_to       timestamptz,
  source_url     text,
  source_label   text,
  authority      public.source_authority,
  dense_rank     int,
  sparse_rank    int,
  rrf_score      double precision
)
language plpgsql
set search_path = public, extensions
as $$
#variable_conflict use_column
begin
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with scoped as (
    select c.id, c.document_id, c.chunk_text, c.context_prefix, c.chunk_index,
           c.embedding, c.fts,
           d.title, d.market, d.doc_type, d.effective_date, d.valid_to,
           d.source_url,
           d.source_id
    from doc_chunks c
    join documents d on d.id = c.document_id
    where c.embedding is not null
      and (p_market        is null or d.market        = p_market)
      and (p_business_type is null or d.business_type = p_business_type)
      and (p_doc_type      is null or d.doc_type      = p_doc_type)
      and (c.owner_project_id is null or c.owner_project_id = p_project_id)
      -- Shared rows always, this room's rows when it asks, nobody else's ever.
      -- Isolation is stated here rather than left to a policy because the caller
      -- is the AI service on the secret key, which bypasses RLS entirely.
      and (c.owner_room_id is null or c.owner_room_id = p_room_id)
      and d.valid_from <= p_as_of
      and (d.valid_to is null or d.valid_to > p_as_of)
  ),
  dense as (
    select s.id, row_number() over (order by s.embedding <=> p_embedding)::int as rank
    from scoped s
    order by s.embedding <=> p_embedding
    limit p_candidates
  ),
  sparse as (
    select s.id,
           row_number() over (order by ts_rank_cd(s.fts, q.query) desc, s.id)::int as rank
    from scoped s, websearch_to_tsquery(p_lang, p_query) as q(query)
    where s.fts @@ q.query
    order by ts_rank_cd(s.fts, q.query) desc, s.id
    limit p_candidates
  ),
  fused as (
    select coalesce(dense.id, sparse.id) as id,
           dense.rank  as d_rank,
           sparse.rank as s_rank,
           (coalesce(1.0 / (p_rrf_k + dense.rank), 0.0)
          + coalesce(1.0 / (p_rrf_k + sparse.rank), 0.0))::double precision as score
    from dense
    full outer join sparse on dense.id = sparse.id
  )
  select s.id, s.document_id, s.chunk_text, s.context_prefix, s.chunk_index,
         s.title, s.market, s.doc_type, s.effective_date, s.valid_to,
         -- The document's own address first. A document with none shows none,
         -- rather than borrowing the address of whatever else shares its source.
         coalesce(s.source_url, ks.url), ks.label, ks.authority,
         f.d_rank, f.s_rank, f.score
  from fused f
  join scoped s on s.id = f.id
  left join knowledge_sources ks on ks.id = s.source_id
  order by f.score desc, s.id
  limit p_limit;
end;
$$;

-- Same twelve-argument signature, so `create or replace` genuinely replaces and
-- there is nothing to drop. Grants survive a replace, and are restated anyway so
-- this file states the whole reachable surface rather than depending on the
-- previous migration having got it right.
revoke all on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz, uuid
) to service_role;
