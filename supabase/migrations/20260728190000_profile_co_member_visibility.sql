-- 20260728190000_profile_co_member_visibility.sql — let room members see each
-- other's profile basics. Owner doc: docs/10-architecture/data-model.md
--
-- `profiles_select_own` is own-row only, which is right for a private profile but
-- makes the chat member list impossible: you cannot render "Lena Ortiz · Verified
-- Pro" next to a message if you cannot read Lena's row. This adds the narrowest
-- policy that fixes it: you may read a profile if you currently share at least one
-- room with that person.
--
-- SECURITY DEFINER for the same reason as private.is_room_member(): a policy ON
-- profiles that queries room_members would otherwise evaluate room_members' own
-- policies, and the helper keeps that from turning into recursive policy
-- evaluation. It lives in `private` so PostgREST does not expose it as RPC.

create function private.shares_room_with(p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.room_members mine
    join public.room_members theirs on theirs.room_id = mine.room_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user
      and (mine.expires_at is null or mine.expires_at > now())
      and (theirs.expires_at is null or theirs.expires_at > now())
  );
$$;

revoke all on function private.shares_room_with(uuid) from public;
grant execute on function private.shares_room_with(uuid) to anon, authenticated;

-- Additive: `profiles_select_own` still covers reading your own row, including
-- before you have joined any room.
create policy "profiles_select_co_member" on public.profiles
  for select using (private.shares_room_with(user_id));
