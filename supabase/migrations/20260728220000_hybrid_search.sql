-- 20260728220000_hybrid_search.sql — hybrid dense+sparse retrieval fused with RRF.
-- Owner docs: docs/10-architecture/rag.md · docs/30-modules/rag-knowledge.md
--
-- One query, not three. Dense and sparse candidates are gathered and fused
-- inside Postgres, so the network carries only the final top-N instead of two
-- candidate lists. rag.md specifies exactly this: "RRF (k=60) merging dense +
-- sparse in one SQL query (two CTEs + fused rank)".
--
-- RRF is rank-based, so the two lists need no score normalisation — which is the
-- point, since cosine distance and ts_rank_cd are not comparable quantities.

create or replace function public.hybrid_search(
  p_embedding      extensions.halfvec(1024),
  p_query          text,
  p_market         text default null,
  p_business_type  text default null,
  p_doc_type       text default null,
  p_lang           regconfig default 'english',
  -- Candidates per list. 40 is what gets handed to the cross-encoder (rag.md).
  p_candidates     int default 40,
  p_limit          int default 40,
  p_rrf_k          int default 60,
  -- Explicit tenant scope. The caller is the AI service using the secret key,
  -- which BYPASSES RLS, so isolation has to be stated here rather than assumed
  -- from a policy. NULL means "shared reference corpus only".
  p_project_id     uuid default null,
  -- Effective-dating: retrieval defaults to rules currently in force.
  p_as_of          timestamptz default now()
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
-- RETURNS TABLE names become plpgsql variables and would shadow identically
-- named columns. Every reference below is qualified, but this makes the
-- resolution explicit rather than relying on that staying true.
#variable_conflict use_column
begin
  -- Recall knobs, set with is_local => true so they last exactly one
  -- transaction (this call) and never leak into a pooled connection.
  --
  -- They are applied here rather than in the function's SET clause because
  -- Postgres validates that clause at CREATE time and `postgres` is not
  -- superuser on Supabase: "permission denied to set parameter hnsw.ef_search".
  -- A runtime set_config is permitted and has the same effect.
  --
  -- iterative_scan matters specifically because we apply hard filters. Without
  -- it the HNSW scan returns its k nearest and the WHERE clause then discards
  -- most of them, silently under-filling the candidate list. pgvector 0.8+.
  perform set_config('hnsw.ef_search', '100', true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with scoped as (
    select c.id, c.document_id, c.chunk_text, c.context_prefix, c.chunk_index,
           c.embedding, c.fts,
           d.title, d.market, d.doc_type, d.effective_date, d.valid_to,
           d.source_id
    from doc_chunks c
    join documents d on d.id = c.document_id
    where c.embedding is not null
      and (p_market        is null or d.market        = p_market)
      and (p_business_type is null or d.business_type = p_business_type)
      and (p_doc_type      is null or d.doc_type      = p_doc_type)
      and (c.owner_project_id is null or c.owner_project_id = p_project_id)
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
  -- Aliased d_rank/s_rank/score rather than reusing the OUT parameter names,
  -- which plpgsql would treat as variables inside this body.
  fused as (
    select coalesce(dense.id, sparse.id) as id,
           dense.rank  as d_rank,
           sparse.rank as s_rank,
           -- Cast explicitly: `1.0 / integer` is numeric in Postgres, and the
           -- function signature promises double precision.
           (coalesce(1.0 / (p_rrf_k + dense.rank), 0.0)
          + coalesce(1.0 / (p_rrf_k + sparse.rank), 0.0))::double precision as score
    from dense
    full outer join sparse on dense.id = sparse.id
  )
  select s.id, s.document_id, s.chunk_text, s.context_prefix, s.chunk_index,
         s.title, s.market, s.doc_type, s.effective_date, s.valid_to,
         ks.url, ks.label, ks.authority,
         f.d_rank, f.s_rank, f.score
  from fused f
  join scoped s on s.id = f.id
  left join knowledge_sources ks on ks.id = s.source_id
  order by f.score desc, s.id
  limit p_limit;
end;
$$;

-- Server-side only. The AI service calls this with the secret key; there is no
-- reason for a browser to reach it, and leaving the default PUBLIC grant would
-- publish it at /rest/v1/rpc/hybrid_search.
revoke all on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz
) from public, anon, authenticated;

grant execute on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz
) to service_role;
