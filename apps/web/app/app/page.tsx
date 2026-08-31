import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import './chat.css';
import { ChatApp } from '../../components/chat/ChatApp';
import { EmptyWorkspace } from '../../components/chat/EmptyWorkspace';
import { createClient } from '../../lib/supabase/server';
import {
  fetchChannels,
  fetchMembers,
  fetchMessages,
  fetchNode,
  fetchRooms,
} from '../../lib/api-server';

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

  // Both reads, because the answer to "what should this person see" needs both.
  // `fetchNode` is null for almost everybody: being a node is by invitation, and
  // the API answers 404 to a caller with no record.
  const [roomsResult, nodeResult] = await Promise.all([fetchRooms(), fetchNode()]);
  const rooms = roomsResult?.rooms ?? [];

  // An invited expert with no workspace of their own belongs on their own
  // surface, not in an empty chrome telling them to start a business.
  //
  // The branch reads `node_profiles` rather than `profiles.role`, deliberately.
  // The row is the fact, RLS enforces who can see it, and `profiles.role` still
  // authorises nothing anywhere in this system (20260831110000:27-35). It gains
  // its first writer in this slice and does not become load-bearing here.
  //
  // A node who also owns a workspace stays here and reaches their profile from
  // the top bar, because being an expert does not stop somebody running their
  // own business.
  if (rooms.length === 0 && nodeResult) redirect('/node');

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
      isNode={nodeResult !== null}
      viewerEmail={user.email ?? null}
      rooms={rooms}
      initialRoomId={active.id}
      initialChannels={channels?.channels ?? []}
      initialMembers={members?.members ?? []}
      initialMessages={messages?.messages ?? []}
    />
  );
}
