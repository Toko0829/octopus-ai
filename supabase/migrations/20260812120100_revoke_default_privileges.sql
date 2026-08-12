-- 20260812120100_revoke_default_privileges.sql — close the grants nobody asked for.
-- Owner doc: docs/10-architecture/data-model.md
--
-- Found while verifying the grants on `action_embeds`: every table in `public`
-- carried `REFERENCES, TRIGGER, TRUNCATE` for **anon** and `TRUNCATE` for
-- authenticated, from Supabase's default privileges rather than from any
-- migration here.
--
-- Why this matters more than the usual over-grant. RLS filters rows a grant
-- already permits, but **TRUNCATE is not row-level and bypasses RLS entirely**,
-- so a role holding it can empty a table whatever the policies say. `anon` held
-- it on `messages`, `rooms` and the whole RAG corpus, while
-- 20260728170000_grant_table_privileges.sql states plainly that "anon gets
-- nothing. No unauthenticated surface exists in chat."
--
-- Honest scoping: this was not remotely exploitable. PostgREST exposes no
-- TRUNCATE verb, so there was no route to it through the API. It is closed
-- because a privilege that cannot be justified should not be held, not because
-- an attack was available.
--
-- Note the earlier migration's comment says Supabase's default grants "did not
-- fire" for the first two migrations. They fire for tables created through other
-- paths, which is precisely why the durable fix below is the ALTER DEFAULT
-- PRIVILEGES at the end rather than this one-time cleanup.

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

revoke all on all tables in schema public from anon;

-- Restore exactly what the policies need, mirroring 20260728170000.
grant select, update on public.profiles to authenticated;
grant select on public.rooms to authenticated;
grant select on public.channels to authenticated;
grant select on public.room_members to authenticated;
grant select, insert on public.messages to authenticated;
grant select on public.documents to authenticated;
grant select on public.doc_chunks to authenticated;
grant select on public.knowledge_sources to authenticated;
grant select on public.eval_golden_set to authenticated;
grant select on public.action_embeds to authenticated;

-- The durable half: stop the same defaults reapplying to tables created later.
-- Without this the cleanup above decays the next time anyone adds a table.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;
