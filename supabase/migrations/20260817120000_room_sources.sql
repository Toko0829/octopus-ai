-- 20260817120000_room_sources.sql — the corpus can finally hold what a user tells us about their own business.
-- Owner doc: docs/10-architecture/data-model.md
--
-- **The gap this closes was measured in delivered work, not guessed at.** Every
-- artifact the executor produces ends with a variant of the same sentence:
-- "product-specific claims, proof points for bluelly.com could not be included."
-- The pipeline retrieves, grounds, cites and gates correctly, and the corpus is
-- ten internally-authored documents about marketing principles, so the system
-- knows marketing and does not know the user's product. Ad copy comes back
-- written about advertising rather than about the thing being advertised.
--
-- **Most of the tenancy already existed.** `20260728210000_rag_schema.sql` gave
-- `documents` and `doc_chunks` an `owner_project_id`, a trigger syncing it down
-- to chunks, partial indexes, RLS denying tenant rows to clients, and
-- `hybrid_search` already blends `owner_project_id is null or = p_project_id`.
-- Somebody designed this in and left two wires unconnected: nothing supplies an
-- owner on the way in, and no caller passes a scope on the way out.
--
-- **So why a ROOM column rather than reusing the project one.** A project does
-- not exist until a plan is approved (`materialise_plan`), and what a user tells
-- us about their business arrives before that, while they are still describing
-- what they want. A room also now carries many projects over its life, which
-- `room-for-project.ts` had to establish the hard way after the first project
-- approved in a room claimed `rooms.project_id` permanently. Business knowledge
-- belongs to the workspace, not to one plan inside it, so it is scoped to the
-- room and every project in that room retrieves it.
--
-- `owner_project_id` is left exactly as it is. It is the right scope for things
-- a single project produces, campaign outcomes above all, which is what the
-- learning flywheel will write back.
--
-- **Room-scoped rows stay invisible to clients**, the same posture the project
-- rows already have. The read policies still say `owner_room_id is null` by
-- omission: they filter on `owner_project_id is null`, so a room-scoped row with
-- a null project would have leaked to every authenticated user. That is closed
-- explicitly below rather than left to be inferred.

-- ------------------------------------------------------------- the columns ----

alter table public.documents  add column if not exists owner_room_id uuid;
alter table public.doc_chunks add column if not exists owner_room_id uuid;

comment on column public.documents.owner_room_id is
  'The workspace this document belongs to, or NULL for the shared reference corpus. '
  'Room rather than project because business knowledge outlives any one plan.';

-- Partial, mirroring documents_owner_idx: the shared corpus is the common case
-- and indexing its NULLs would be indexing almost every row for nothing.
create index if not exists documents_owner_room_idx
  on public.documents (owner_room_id) where owner_room_id is not null;
create index if not exists doc_chunks_owner_room_idx
  on public.doc_chunks (owner_room_id) where owner_room_id is not null;

-- No foreign key to `rooms`, matching `owner_project_id`'s choice. A corpus row
-- outliving its room is a leak of nothing (it is unreachable by any query that
-- does not name the id) where a cascade would silently destroy ingested work on
-- a room delete. Recorded so the omission reads as a decision.

-- --------------------------------------------------------------- the sync ----

-- `create or replace` restates the whole body rather than patching it, the same
-- idiom 20260815200000 uses: the previous version is already applied and a file
-- that no longer matches what ran is worse than a longer file.
create or replace function private.sync_chunk_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Both owners are copied from the parent document in one read. A chunk can
  -- never disagree with its document about who it belongs to, which is why this
  -- is a trigger rather than something every writer has to remember.
  select d.owner_project_id, d.owner_room_id
    into new.owner_project_id, new.owner_room_id
  from public.documents d where d.id = new.document_id;
  return new;
end;
$$;

-- ---------------------------------------------------------------- the RLS ----

-- The existing policies admit a row when `owner_project_id is null`, which was
-- complete when that was the only owner column and is not any more: a
-- room-scoped document has a null project and would have been readable by every
-- authenticated user. Both owners must be null for a row to be shared.
drop policy if exists documents_read_shared on public.documents;
create policy documents_read_shared on public.documents
  for select to authenticated
  using (owner_project_id is null and owner_room_id is null);

drop policy if exists doc_chunks_read_shared on public.doc_chunks;
create policy doc_chunks_read_shared on public.doc_chunks
  for select to authenticated
  using (owner_project_id is null and owner_room_id is null);

-- ------------------------------------------------------------ the retrieval ----

-- Restated in full, as above. The only change is `p_room_id` and its predicate;
-- everything else is byte-identical to 20260728220000 on purpose, so a diff
-- between the two files shows exactly what this migration did and nothing else.
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
  -- The workspace asking. NULL means "shared reference corpus only", so every
  -- existing caller keeps its behaviour without being touched.
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
         ks.url, ks.label, ks.authority,
         f.d_rank, f.s_rank, f.score
  from fused f
  join scoped s on s.id = f.id
  left join knowledge_sources ks on ks.id = s.source_id
  order by f.score desc, s.id
  limit p_limit;
end;
$$;

-- Adding a parameter creates a NEW function rather than replacing the old one,
-- because the signature is part of the identity. The eleven-argument version is
-- dropped so there is exactly one `hybrid_search` and no chance of a caller
-- silently binding to the version that cannot see room sources.
drop function if exists public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz
);

revoke all on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.hybrid_search(
  extensions.halfvec(1024), text, text, text, text, regconfig, int, int, int, uuid, timestamptz, uuid
) to service_role;

-- --------------------------------------------------- dismissing a question ----

-- A person with an open question card had no way to say "forget that, this is
-- something new". `decideIntakeTurn` reads every message from the room owner as
-- an answer while a card is pending, which is correct for the case it was built
-- for and wrong for this one: a real goal was consumed as the answer to four
-- unrelated waiting steps, and the person's actual request was buried.
--
-- `dismissed` rather than reusing `expired`, following the reasoning that
-- created `answered` and `reported`: `expired` means nobody acted in time, and
-- recording a deliberate act as a timeout puts an untrue sentence in the audit
-- trail. A dismissal is also not a verdict, which is why it is not `rejected`.
alter type public.embed_state add value if not exists 'dismissed';
