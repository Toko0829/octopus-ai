-- room_sources.sql — a workspace's own documents reach that workspace and nobody else.
--
-- Covers 20260817120000_room_sources.sql.
--
-- The property under test is isolation, and it is worth stating plainly why it
-- is asserted here rather than trusted to RLS. The AI service calls
-- `hybrid_search` with the secret key, which BYPASSES row-level security
-- entirely, so the only thing standing between one customer's business
-- description and another customer's ad copy is the predicate inside that
-- function. A policy test would prove nothing about the path retrieval actually
-- takes.
--
-- Everything runs inside a transaction that ROLLBACKs, so it is safe against a
-- live database.
--
-- Run with:
--   psql "$DATABASE_URL" -f supabase/tests/room_sources.sql

begin;

select extensions.plan(14);

-- ------------------------------------------------------------- fixtures ----

-- An id registry, per the idiom the other suites use: a temp table plus a
-- lookup, so nothing is a hardcoded UUID and the names read in the assertions.
create temporary table rsids (k text primary key, v uuid) on commit drop;

create or replace function pg_temp.rid(p_k text) returns uuid
language sql stable as $$ select v from rsids where k = p_k $$;

insert into rsids (k, v) values
  ('room_a',   gen_random_uuid()),
  ('room_b',   gen_random_uuid()),
  ('doc_glob', gen_random_uuid()),
  ('doc_a',    gen_random_uuid()),
  ('doc_b',    gen_random_uuid()),
  ('src',      gen_random_uuid());

-- A unit vector every chunk shares. Retrieval quality is not what this suite
-- measures: with identical embeddings, which rows come back is decided purely by
-- the scoping predicate, which is exactly the variable under test.
create or replace function pg_temp.vec() returns extensions.halfvec(1024)
language sql immutable as $$
  select ('[' || array_to_string(array_fill(0.1::real, array[1024]), ',') || ']')
           ::extensions.halfvec(1024)
$$;

insert into public.knowledge_sources (id, label, authority)
values (pg_temp.rid('src'), 'room-sources test fixture', 'vendor');

-- Three documents: one shared, one owned by room A, one owned by room B. Same
-- words in all three, so nothing but ownership can separate them.
insert into public.documents (id, source_id, title, content_hash, owner_room_id)
values
  (pg_temp.rid('doc_glob'), pg_temp.rid('src'), 'Shared principles', 'h-glob', null),
  (pg_temp.rid('doc_a'),    pg_temp.rid('src'), 'Room A business',   'h-a',    pg_temp.rid('room_a')),
  (pg_temp.rid('doc_b'),    pg_temp.rid('src'), 'Room B business',   'h-b',    pg_temp.rid('room_b'));

-- Chunks are inserted WITHOUT an owner on purpose. The trigger is what fills it,
-- and a test that supplied the value would assert the fixture rather than the
-- mechanism.
insert into public.doc_chunks (document_id, chunk_index, chunk_text, embedding)
values
  (pg_temp.rid('doc_glob'), 0, 'lower cost per acquisition on paid social', pg_temp.vec()),
  (pg_temp.rid('doc_a'),    0, 'lower cost per acquisition on paid social', pg_temp.vec()),
  (pg_temp.rid('doc_b'),    0, 'lower cost per acquisition on paid social', pg_temp.vec());

-- ------------------------------------------------------- the sync trigger ----

select extensions.is(
  (select owner_room_id from public.doc_chunks where document_id = pg_temp.rid('doc_a')),
  pg_temp.rid('room_a'),
  'the trigger copies owner_room_id from the document, so a chunk cannot disagree with its parent'
);

select extensions.is(
  (select owner_room_id from public.doc_chunks where document_id = pg_temp.rid('doc_glob')),
  null::uuid,
  'a shared document produces shared chunks'
);

select extensions.is(
  (select owner_project_id from public.doc_chunks where document_id = pg_temp.rid('doc_a')),
  null::uuid,
  'room ownership does not invent a project owner: the two scopes are independent'
);

-- ------------------------------------------------------------ retrieval ----

-- Counted rather than listed, because what matters is which rows are reachable.
create or replace function pg_temp.hits(p_room uuid) returns text
language sql as $$
  select coalesce(string_agg(h.title, ', ' order by h.title), '(none)')
  from public.hybrid_search(
    pg_temp.vec(),
    'cost per acquisition',
    p_room_id => p_room
  ) h
  where h.document_id in (
    pg_temp.rid('doc_glob'), pg_temp.rid('doc_a'), pg_temp.rid('doc_b')
  )
$$;

select extensions.is(
  pg_temp.hits(pg_temp.rid('room_a')),
  'Room A business, Shared principles',
  'room A retrieves the shared corpus and its own business, and nothing of room B'
);

select extensions.is(
  pg_temp.hits(pg_temp.rid('room_b')),
  'Room B business, Shared principles',
  'room B sees its own, symmetrically: this is the isolation the secret key bypasses RLS for'
);

select extensions.is(
  pg_temp.hits(null),
  'Shared principles',
  'no room means the shared corpus alone, so every existing caller is unchanged by this migration'
);

select extensions.is(
  pg_temp.hits(gen_random_uuid()),
  'Shared principles',
  'an unknown room gets the shared corpus rather than an error or somebody else rows'
);

-- The old eleven-argument signature is gone, so no caller can bind to a version
-- that cannot see room sources. Two functions of the same name is how a scoping
-- fix silently fails to apply.
select extensions.is(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hybrid_search'),
  1,
  'exactly one hybrid_search exists: an overload would let a caller keep the unscoped one'
);

-- ------------------------------------------------------------------ RLS ----

-- As a client, not as postgres. `postgres` bypasses RLS, so running these as the
-- owner would prove nothing, which is precisely how a policy bug survives review.
create or replace function pg_temp.visible_as_client(p_table text) returns int
language plpgsql as $$
declare n int;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  execute format(
    'select count(*)::int from public.%I where title in (%L, %L, %L)',
    p_table, 'Shared principles', 'Room A business', 'Room B business'
  ) into n;
  perform set_config('role', 'postgres', true);
  return n;
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $$;

select extensions.is(
  pg_temp.visible_as_client('documents'),
  1,
  'a client sees the shared document and neither room document: business knowledge is not published'
);

create or replace function pg_temp.chunks_visible_as_client() returns int
language plpgsql as $$
declare
  n int;
  d_glob uuid; d_a uuid; d_b uuid;
begin
  -- Resolved BEFORE the role switch. The id registry is a temp table owned by
  -- this session as `postgres`, and `authenticated` cannot read it: reading it
  -- afterwards fails with "permission denied for table rsids", which looks like
  -- an RLS result and is not one.
  d_glob := pg_temp.rid('doc_glob');
  d_a := pg_temp.rid('doc_a');
  d_b := pg_temp.rid('doc_b');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  select count(*)::int into n from public.doc_chunks
   where document_id in (d_glob, d_a, d_b);
  perform set_config('role', 'postgres', true);
  return n;
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $$;

select extensions.is(
  pg_temp.chunks_visible_as_client(),
  1,
  'the same holds for chunks, which is the table that actually carries the text'
);

-- The policy this migration had to correct. Before it, both read policies tested
-- only `owner_project_id is null`, so a room-scoped row (whose project owner is
-- null) satisfied them and would have been readable by every authenticated user.
select extensions.is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'documents'
      and policyname = 'documents_read_shared'
      and qual like '%owner_room_id IS NULL%'),
  1,
  'the documents read policy tests BOTH owners: testing only the project one leaked room rows'
);

select extensions.is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'doc_chunks'
      and policyname = 'doc_chunks_read_shared'
      and qual like '%owner_room_id IS NULL%'),
  1,
  'and so does the chunk read policy'
);

-- ------------------------------------------------------------ embed_state ----

select extensions.ok(
  'dismissed' = any (enum_range(null::public.embed_state)::text[]),
  'embed_state gained dismissed, so abandoning a question is not recorded as a timeout or a verdict'
);

select extensions.ok(
  'reported' = any (enum_range(null::public.embed_state)::text[]),
  'and reported is still there: the artifact card state the contracts enum had been missing'
);

select * from extensions.finish();

rollback;
