-- 20260728170000_grant_table_privileges.sql — table-level privileges for the
-- PostgREST roles. Owner doc: docs/10-architecture/data-model.md
--
-- Neither 20260724000000_init.sql nor 20260728120000_chat.sql granted anything to
-- anon / authenticated / service_role, and the default-privilege grants Supabase
-- normally applies did not fire for them. Result: every table carried correct RLS
-- policies but was unreachable, because RLS FILTERS rows a grant already allows —
-- it does not itself grant access. Caught by end-to-end verification, which failed
-- with "permission denied for table rooms".
--
-- Grants are least-privilege and mirror the policies rather than blanket ALL:
--   * anon gets nothing. No unauthenticated surface exists in chat.
--   * authenticated gets exactly the verbs its policies allow; RLS then decides
--     which rows.
--   * service_role gets ALL for trusted server writes with no user context
--     (agent/system messages, the matcher inserting a node into room_members).
--     It stays server-only. AGENTS.md rule 6.

grant usage on schema public to anon, authenticated, service_role;

-- profiles: "profiles_select_own" / "profiles_update_own".
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- Chat reads: membership-gated by private.is_room_member().
grant select on public.rooms        to authenticated;
grant select on public.channels     to authenticated;
grant select on public.room_members to authenticated;

grant all on public.rooms        to service_role;
grant all on public.channels     to service_role;
grant all on public.room_members to service_role;

-- messages: members read; members insert their OWN user messages
-- ("messages_insert_own" re-checks author_id and author_kind). No update/delete
-- for end users, so the audit trail cannot be rewritten from a client.
grant select, insert on public.messages to authenticated;
grant all on public.messages to service_role;
