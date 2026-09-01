import 'server-only';
import type {
  Channel,
  ListMessagesResponse,
  NodeEngagement,
  NodeOffer,
  NodeProfile,
  OpsDisputeSummary,
  OpsIdentity,
  Room,
  RoomMember,
} from '@octopus/contracts';
import { getAccessToken } from './supabase/server';

/**
 * Server-side reads straight to Fastify (docs/10-architecture/architecture.md:
 * "RSC for reads"). The BFF proxy exists for the browser; a Server Component
 * already holds the session, so routing through it would just add a hop.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function get<T>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(`${API_URL}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      // A 404 is a legitimate answer here (room not visible), not an incident.
      if (res.status !== 404) {
        console.error('[api-server] request failed', { path, status: res.status });
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error('[api-server] request threw', { path, err });
    return null;
  }
}

export function fetchRooms() {
  return get<{ rooms: Room[] }>('/rooms');
}

export function fetchChannels(roomId: string) {
  return get<{ channels: Channel[] }>(`/rooms/${roomId}/channels`);
}

export function fetchMembers(roomId: string) {
  return get<{ members: RoomMember[] }>(`/rooms/${roomId}/members`);
}

export function fetchMessages(roomId: string) {
  return get<ListMessagesResponse>(`/rooms/${roomId}/messages?limit=100`);
}

/**
 * The caller's own marketplace record, or null when they have none.
 *
 * Null is the ordinary answer, not a failure: almost everybody signing in is a
 * workspace owner rather than a node, and the API answers 404 to a caller with
 * no `node_profiles` row because whether somebody is a node is not a fact
 * strangers get to confirm. `get` already folds a 404 into null without logging
 * it as an incident, which is exactly the behaviour wanted here.
 */
export function fetchNode() {
  return get<{ node: NodeProfile }>('/node');
}

/**
 * The node's offers, read on the server so the console renders with them
 * already in hand.
 *
 * Same null-on-404 behaviour as `fetchNode`: a signed-in person who is not a
 * node has no offers and that is not an incident.
 */
export function fetchNodeOffers() {
  return get<{ offers: NodeOffer[] }>('/node/offers');
}

/**
 * The work this node already took, read on the server for the same reason the
 * offers are: the console should render with it in hand rather than flashing an
 * empty section and filling it in.
 */
export function fetchNodeEngagements() {
  return get<{ engagements: NodeEngagement[] }>('/node/engagements');
}

/**
 * Whether the caller is an operator.
 *
 * **The gate for `/ops`, and it is a server round trip on purpose.** Being an
 * operator is `profiles.role`, which the session cookie does not carry and the
 * JWT does not either: `apps/api/src/plugins/auth.ts` maps an unrecognised claim
 * to `'user'`, and Supabase mints `role = 'authenticated'`, so nothing reaching
 * the browser knows this. The API reads the column with the service key behind
 * its own check, and this asks it.
 *
 * Null on 403 as well as on failure, folded by `get` without logging a 403 as an
 * incident. The page treats both the same way — a redirect rather than a
 * message — because whether an ops surface exists is not something to confirm to
 * somebody who may not use it.
 */
export function fetchOpsIdentity() {
  return get<OpsIdentity>('/ops/me');
}

/** The operator's queue. Open disputes oldest-first; see the route for why. */
export function fetchOpsDisputes(status: 'open' | 'resolved' = 'open') {
  return get<{ disputes: OpsDisputeSummary[] }>(`/ops/disputes?status=${status}`);
}
