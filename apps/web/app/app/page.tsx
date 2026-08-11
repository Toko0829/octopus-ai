import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import './chat.css';
import { ChatApp } from '../../components/chat/ChatApp';
import { EmptyWorkspace } from '../../components/chat/EmptyWorkspace';
import { createClient } from '../../lib/supabase/server';
import { fetchChannels, fetchMembers, fetchMessages, fetchRooms } from '../../lib/api-server';

export const metadata: Metadata = {
  title: 'Octopus · Workspace',
};

/**
 * The workspace is per-request by definition: it resolves the caller's session and
 * reads their rooms. Declare that rather than letting it fall out of `cookies()`
 * throwing Next's dynamic bailout, because `createClient()` validates env *before*
 * it reaches `cookies()`. Without this line a build with no Supabase env tries to
 * prerender the page, hits that validation, and fails, which is how CI broke while
 * every local build passed on the strength of a present `.env.local`.
 */
export const dynamic = 'force-dynamic';

/** Reads happen here (RSC), so the shell renders with real data already in place. */
export default async function WorkspacePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in?next=/app');

  const roomsResult = await fetchRooms();
  const rooms = roomsResult?.rooms ?? [];

  // No rooms is the normal state for a new account, not an error. Say what is
  // true rather than rendering an empty chrome that looks broken.
  if (rooms.length === 0) {
    return (
      <EmptyWorkspace
        reachedApi={roomsResult !== null}
        email={user.email ?? null}
        apiUrl={process.env.API_URL ?? 'http://localhost:3001'}
      />
    );
  }

  const active = rooms[0]!;
  const [channels, members, messages] = await Promise.all([
    fetchChannels(active.id),
    fetchMembers(active.id),
    fetchMessages(active.id),
  ]);

  return (
    <ChatApp
      viewerId={user.id}
      viewerEmail={user.email ?? null}
      rooms={rooms}
      initialRoomId={active.id}
      initialChannels={channels?.channels ?? []}
      initialMembers={members?.members ?? []}
      initialMessages={messages?.messages ?? []}
    />
  );
}
