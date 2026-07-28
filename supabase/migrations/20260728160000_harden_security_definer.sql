-- 20260728160000_harden_security_definer.sql — take the SECURITY DEFINER helpers
-- off the PostgREST RPC surface (Supabase advisor lints 0028 / 0029).
-- Owner docs: docs/10-architecture/data-model.md, docs/10-architecture/security-compliance.md
--
-- is_room_member() is a policy helper, not an API. It cannot simply lose its
-- EXECUTE grant: RLS policy expressions are evaluated as the *querying* role, so
-- revoking EXECUTE from `authenticated` would break every select policy in
-- 20260728120000_chat.sql. Moving it to a schema PostgREST does not expose drops
-- the /rest/v1/rpc/ endpoint while leaving policy evaluation untouched.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create function private.is_room_member(p_room uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members m
    where m.room_id = p_room
      and m.user_id = auth.uid()
      and (m.expires_at is null or m.expires_at > now())
  );
$$;

-- anon keeps EXECUTE deliberately: an unauthenticated select must still resolve
-- to zero rows (auth.uid() is null) rather than a permission error.
revoke all on function private.is_room_member(uuid) from public;
grant execute on function private.is_room_member(uuid) to anon, authenticated;

-- Repoint the policies before dropping the public-schema copy.
alter policy "rooms_select_member"        on public.rooms        using (private.is_room_member(id));
alter policy "channels_select_member"     on public.channels     using (private.is_room_member(room_id));
alter policy "room_members_select_member" on public.room_members using (private.is_room_member(room_id));
alter policy "messages_select_member"     on public.messages     using (private.is_room_member(room_id));

alter policy "messages_insert_own" on public.messages
  with check (
    private.is_room_member(room_id)
    and author_id = auth.uid()
    and author_kind = 'user'
  );

drop function public.is_room_member(uuid);

-- Trigger / event-trigger functions: Postgres refuses to invoke these outside
-- their trigger context, but the default PUBLIC grant still advertises them at
-- /rest/v1/rpc/. Revoke it. Trigger firing does not re-check EXECUTE (that is
-- validated once, at CREATE TRIGGER time), so this is inert at runtime.
revoke all on function public.handle_new_user() from public;
revoke all on function public.broadcast_message() from public;

-- rls_auto_enable() backs the pre-existing `ensure_rls` event trigger, which
-- auto-enables RLS on new public tables. Not created by this repo; see
-- data-model.md. Revoked here for the same reason.
revoke all on function public.rls_auto_enable() from public;
