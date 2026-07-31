-- 20260728210000_rag_schema.sql — the RAG corpus: sources, documents, chunks, eval set.
-- Owner docs: docs/10-architecture/data-model.md · docs/10-architecture/rag.md
-- Decisions: ADR-0002 (stay in Postgres/pgvector), ADR-0007 (OpenAI embeddings @ 1024).
--
-- Grants are issued IN THIS MIGRATION alongside RLS. RLS filters rows a grant
-- already permits; a table with policies and no grant is simply unreachable.
-- Both earlier migrations got this wrong and had to be repaired.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- sources ----

create type public.source_authority as enum (
  'official',   -- regulator, ad platform policy, government registry
  'vendor',     -- platform docs, tool documentation
  'research',   -- studies, benchmarks
  'internal'    -- our own measured outcomes (the flywheel)
);

create table public.knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  url           text,
  label         text not null,
  authority     public.source_authority not null,
  -- Freshness is a first-order feature (rag.md): how often to re-crawl, and what
  -- we saw last time, so unchanged documents are skipped instead of re-embedded.
  crawl_cadence interval,
  last_crawled  timestamptz,
  content_hash  text,
  created_at    timestamptz not null default now()
);
create unique index knowledge_sources_url_idx on public.knowledge_sources (url) where url is not null;

-- -------------------------------------------------------------- documents ----

create table public.documents (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid references public.knowledge_sources (id) on delete set null,

  title          text not null,
  -- Hard filters the self-query step extracts from a question and pushes into
  -- SQL. These are the single biggest correctness lever in retrieval (rag.md),
  -- so they are real columns, not JSONB keys.
  market         text,            -- 'US', 'US/TX/Austin', 'EU/DE' — unambiguous keys
  business_type  text,            -- 'digital-marketing > full-funnel'
  doc_type       text,            -- 'ad-policy' | 'playbook' | 'benchmark' | ...
  lang           regconfig not null default 'english',

  -- Effective-dating, so retrieval can filter to rules currently in force and
  -- surface "last verified" to the user.
  effective_date date,
  valid_from     timestamptz not null default now(),
  valid_to       timestamptz,

  -- Change detection + supersession.
  content_hash   text not null,
  version        int not null default 1,

  -- NULL = shared reference corpus. Non-null = tenant-scoped (the flywheel's
  -- real-outcome layer). Present now so the RLS shape never has to change; see
  -- the policies below for why non-null rows are currently invisible to clients.
  owner_project_id uuid,

  created_at     timestamptz not null default now()
);

create unique index documents_source_hash_idx on public.documents (source_id, content_hash)
  where source_id is not null;
create index documents_market_idx on public.documents (market) where market is not null;
create index documents_business_type_idx on public.documents (business_type) where business_type is not null;
create index documents_doc_type_idx on public.documents (doc_type) where doc_type is not null;
-- In-force lookups are `valid_from <= now() and (valid_to is null or valid_to > now())`.
create index documents_validity_idx on public.documents (valid_from, valid_to);
create index documents_owner_idx on public.documents (owner_project_id) where owner_project_id is not null;

-- ------------------------------------------------------------- doc_chunks ----

create table public.doc_chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents (id) on delete cascade,
  -- Small-to-big: retrieve the precise chunk, optionally expand to its parent.
  parent_id     uuid references public.doc_chunks (id) on delete set null,

  chunk_index   int not null,
  chunk_text    text not null,
  -- Anthropic-style contextual retrieval: a generated blurb situating the chunk
  -- in its document. Stored separately from chunk_text so the raw chunk can be
  -- shown to a user while the *contextualised* text is what gets embedded.
  context_prefix text,

  -- ADR-0007: OpenAI text-embedding-3-large requested at dimensions:1024.
  -- halfvec halves storage and memory versus vector with negligible recall loss.
  embedding     extensions.halfvec(1024),
  embed_model   text,
  embedded_at   timestamptz,

  -- Sparse half of hybrid retrieval. Generated (not trigger-maintained) because
  -- to_tsvector(regconfig, text) is IMMUTABLE, unlike the single-argument form —
  -- which is what lets the config vary per row and keeps this multilingual.
  lang          regconfig not null default 'english',
  fts           tsvector generated always as (
                  to_tsvector(lang, coalesce(context_prefix, '') || ' ' || chunk_text)
                ) stored,

  metadata      jsonb not null default '{}'::jsonb,

  -- Denormalised from documents. Keeps the RLS predicate a plain column test on
  -- the hot retrieval path instead of a join or a per-row function call. Kept
  -- truthful by the trigger below, never written by callers.
  owner_project_id uuid,

  created_at    timestamptz not null default now()
);

create unique index doc_chunks_document_index_idx on public.doc_chunks (document_id, chunk_index);
create index doc_chunks_document_idx on public.doc_chunks (document_id);
create index doc_chunks_owner_idx on public.doc_chunks (owner_project_id) where owner_project_id is not null;
create index doc_chunks_fts_idx on public.doc_chunks using gin (fts);

-- HNSW over cosine distance. m/ef_construction per rag.md. Built here while the
-- table is empty, which is the cheap moment; rebuilding later wants
-- max_parallel_maintenance_workers raised first.
create index doc_chunks_embedding_idx on public.doc_chunks
  using hnsw (embedding extensions.halfvec_cosine_ops)
  with (m = 16, ef_construction = 200);

create or replace function private.sync_chunk_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select d.owner_project_id into new.owner_project_id
  from public.documents d where d.id = new.document_id;
  return new;
end;
$$;

create trigger doc_chunks_owner_sync
  before insert or update of document_id on public.doc_chunks
  for each row execute function private.sync_chunk_owner();

-- --------------------------------------------------------- eval golden set ----

-- Built alongside retrieval, not after it: ADR-0006 makes the eval gate a merge
-- requirement, and a golden set written after the fact tends to encode whatever
-- the implementation already does.
create table public.eval_golden_set (
  id            uuid primary key default gen_random_uuid(),
  query         text not null,
  market        text,
  business_type text,
  -- What good retrieval must surface, and what it must not.
  expected_doc_ids   uuid[] not null default '{}',
  expected_answer    text,
  must_not_contain   text[] not null default '{}',
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- RLS -------

alter table public.knowledge_sources enable row level security;
alter table public.documents enable row level security;
alter table public.doc_chunks enable row level security;
alter table public.eval_golden_set enable row level security;

-- The curated reference corpus is shared: any signed-in user may read it, and it
-- carries no tenant data by construction.
create policy "knowledge_sources_read" on public.knowledge_sources
  for select to authenticated using (true);

-- Tenant-scoped rows (owner_project_id not null) are DENIED to clients outright
-- rather than guessed at. There is no projects/membership table yet, so there is
-- nothing to check ownership against, and defaulting to visible would be a leak
-- waiting for the flywheel to fill this column. Server code reaches them with
-- the secret key. Widen this policy in the same migration that adds projects.
create policy "documents_read_shared" on public.documents
  for select to authenticated using (owner_project_id is null);

create policy "doc_chunks_read_shared" on public.doc_chunks
  for select to authenticated using (owner_project_id is null);

-- Eval data is internal. No client-facing policy at all; service_role only.

-- ---------------------------------------------------------------- grants ----

grant select on public.knowledge_sources to authenticated;
grant select on public.documents        to authenticated;
grant select on public.doc_chunks       to authenticated;

grant all on public.knowledge_sources to service_role;
grant all on public.documents         to service_role;
grant all on public.doc_chunks        to service_role;
grant all on public.eval_golden_set   to service_role;
