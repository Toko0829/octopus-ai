import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelConnection } from '@octopus/contracts';
import {
  carriesRealCredentials,
  type ChannelCredential,
  type PublishConnectionCandidate,
} from '@octopus/marketing';

/**
 * The IO half of connecting a channel account.
 *
 * **`channel_connections` is the one table in this system where RLS defends
 * nothing**, and every function here is shaped by that. The table carries no
 * policy and no grant to `authenticated` at all, because it holds an access
 * token and a refresh token and RLS filters rows rather than columns: a select
 * policy that returned the row would return the secrets with it. So a user
 * client gets `permission denied`, which is the deliberate answer asserted in
 * `supabase/tests/marketing_rls.sql`, and everything below must therefore run as
 * the service role.
 *
 * That inverts this codebase's normal posture. Elsewhere the route reads as the
 * caller and lets Postgres decide; here **the route is the entire control**, and
 * membership has to be established before any function in this file is called.
 * The column list in `SELECTED_COLUMNS` is the other half: it is the only thing
 * standing between a member's panel and a credential.
 */

/**
 * Everything a member may see, and nothing else.
 *
 * Named once and used by every read, rather than written inline per query, so
 * "does the projection leak a token" is a question about one constant instead of
 * a review of every call site. `access_token`, `refresh_token` are absent, and
 * their absence is asserted directly in the tests: a `select *` here would be a
 * silent, total credential leak to every room member, and it is exactly the edit
 * somebody makes while debugging.
 */
const SELECTED_COLUMNS =
  'id, provider, channel, external_account_id, granted_scopes, status, token_expires_at, created_at';

interface ConnectionRow {
  id: string;
  provider: string;
  channel: string;
  external_account_id: string | null;
  granted_scopes: string[] | null;
  status: string;
  token_expires_at: string | null;
  created_at: string;
}

function toConnection(row: ConnectionRow): ChannelConnection {
  return {
    id: row.id,
    provider: row.provider,
    channel: row.channel as ChannelConnection['channel'],
    externalAccountId: row.external_account_id,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status as ChannelConnection['status'],
    tokenExpiresAt: row.token_expires_at,
    connectedAt: row.created_at,
  };
}

/** Every connection in a room, newest first. Membership is the caller's to have checked. */
export async function readConnections(
  admin: SupabaseClient,
  roomId: string,
): Promise<ChannelConnection[]> {
  const { data, error } = await admin
    .from('channel_connections')
    .select(SELECTED_COLUMNS)
    .eq('room_id', roomId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as ConnectionRow[]).map(toConnection);
}

/**
 * What the publisher needs, which is not what the panel needs.
 *
 * **A second column list rather than a reuse of the first**, and the duplication
 * is deliberate. `SELECTED_COLUMNS` is shaped by what a room member may see;
 * this one is shaped by what a decision needs. Merging them would mean one
 * constant answering two questions, and the next person widening it for the
 * publisher would widen it for the panel without noticing. Each list is
 * independently the entire control, so each gets its own assertion in the tests.
 *
 * **No token columns here either, and that is slice 1 rather than an oversight.**
 * The only registered provider takes no credential: `createFakeAdapter` has
 * nothing to authenticate with and the seam has no credential-passing convention
 * yet. Reading a token to pass to something that does not accept one would be
 * handling a secret for no reason. When a real provider lands it needs the
 * credential, and that read belongs in the same change as the envelope
 * encryption the accepted risk in security-compliance.md already names as its
 * trigger.
 */
const PUBLISH_SELECTED_COLUMNS = 'id, provider, granted_scopes, status, created_at';

interface PublishConnectionRow {
  id: string;
  provider: string;
  granted_scopes: string[] | null;
  status: string;
  created_at: string;
}

/**
 * Every connection in a room for one channel, whatever its status.
 *
 * **Expired and revoked rows are returned on purpose.** Filtering to `active`
 * here would collapse "you have not connected an account" and "the account you
 * connected expired" into one answer, and they need different sentences: one
 * sends somebody to connect, the other to reconnect. `chooseConnection` prefers
 * an active row and `checkScopes` produces the precise refusal for whatever is
 * left, so the distinction survives all the way to the message in the room.
 *
 * Membership is the caller's to have checked, exactly as `readConnections` says:
 * this table has no grant to `authenticated` and no policy, so nothing about
 * running as the service role here is unusual for this file.
 */
export async function readPublishableConnections(
  admin: SupabaseClient,
  roomId: string,
  channel: string,
): Promise<PublishConnectionCandidate[]> {
  const { data, error } = await admin
    .from('channel_connections')
    .select(PUBLISH_SELECTED_COLUMNS)
    .eq('room_id', roomId)
    .eq('channel', channel)
    .order('created_at', { ascending: false });
  if (error) throw error;

  return ((data ?? []) as unknown as PublishConnectionRow[]).map((row) => ({
    id: row.id,
    provider: row.provider,
    grantedScopes: row.granted_scopes ?? [],
    status: row.status as PublishConnectionCandidate['status'],
    createdAt: row.created_at,
  }));
}

/**
 * Record that the platform said this credential is done.
 *
 * **Expiry is not revocation, so the tokens stay.** `revokeConnection` nulls them
 * because a disconnection means the credential should not exist; an expiry means
 * it stopped working, and a refresh token that has outlived its access token is
 * exactly what reconnecting uses. Nulling here would turn a recoverable state
 * into an unrecoverable one on the platform's say-so.
 *
 * Conditional on `active`, so a connection somebody revoked while a publish was
 * in flight is not quietly resurrected into `expired`.
 */
export async function markConnectionExpired(
  admin: SupabaseClient,
  connectionId: string,
  now: Date,
): Promise<void> {
  const { error } = await admin
    .from('channel_connections')
    .update({ status: 'expired', updated_at: now.toISOString() })
    .eq('id', connectionId)
    .eq('status', 'active');
  if (error) throw error;
}

export interface WriteConnectionInput {
  roomId: string;
  connectedBy: string;
  provider: string;
  channel: string;
  credential: ChannelCredential;
  /** The clock, passed in, so the expiry arithmetic is testable without waiting. */
  now: Date;
}

/**
 * Store a credential, or refuse to.
 *
 * **The refusal is the point of this function existing rather than being three
 * lines in the route.** security-compliance.md accepts plaintext tokens in this
 * table only while the sole registered provider is the in-repo fake, and names
 * the trigger to fix it: the first real provider credential, "in that change,
 * not after it, because the interval between a real token landing and the
 * encryption landing is exactly the exposure". A document cannot enforce that.
 * This can, and does, before the insert rather than after it.
 *
 * `carriesRealCredentials` raises on an unregistered provider rather than
 * answering false, so an unknown name fails closed here too.
 */
export async function writeConnection(
  admin: SupabaseClient,
  input: WriteConnectionInput,
): Promise<ChannelConnection> {
  if (carriesRealCredentials(input.provider)) {
    throw new Error(
      `Refusing to store a real credential for "${input.provider}": ` +
        'channel_connections holds access_token and refresh_token as plain columns. ' +
        'Envelope encryption (pgsodium or KMS) lands in the same change as the first real ' +
        'provider, per the accepted risk in docs/10-architecture/security-compliance.md.',
    );
  }

  const { credential } = input;
  const expiresAt =
    credential.expiresInSeconds === null
      ? null
      : new Date(input.now.getTime() + credential.expiresInSeconds * 1000).toISOString();

  // Upsert on the unique key the table already carries. A second authorisation
  // for an account already connected updates the row rather than creating a
  // rival, which is what keeps "which token do we use" from having two answers.
  const { data, error } = await admin
    .from('channel_connections')
    .upsert(
      {
        room_id: input.roomId,
        connected_by: input.connectedBy,
        provider: input.provider,
        channel: input.channel,
        external_account_id: credential.externalAccountId,
        granted_scopes: credential.grantedScopes,
        access_token: credential.accessToken,
        refresh_token: credential.refreshToken,
        token_expires_at: expiresAt,
        // Reconnecting an expired or revoked account is how it comes back, so
        // the write states the status rather than leaving whatever was there.
        status: 'active',
        updated_at: input.now.toISOString(),
      },
      { onConflict: 'room_id,provider,external_account_id' },
    )
    .select(SELECTED_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('connection upsert returned no row');

  return toConnection(data as unknown as ConnectionRow);
}

/**
 * Disconnect, which is not a delete.
 *
 * The row survives with `status = 'revoked'` and **both token columns nulled**.
 * That split is the whole decision: "this account was connected on this date, by
 * this person, and disconnected on that one" is audit trail worth keeping, and
 * the credential is not. Deleting the row would destroy the first to achieve the
 * second, and leaving the tokens in place would achieve neither.
 *
 * Conditional on not already being revoked, so a double click is one revocation
 * and the caller can tell the difference.
 */
export async function revokeConnection(
  admin: SupabaseClient,
  roomId: string,
  connectionId: string,
  now: Date,
): Promise<ChannelConnection | null> {
  const { data, error } = await admin
    .from('channel_connections')
    .update({
      status: 'revoked',
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      updated_at: now.toISOString(),
    })
    .eq('id', connectionId)
    .eq('room_id', roomId)
    .neq('status', 'revoked')
    .select(SELECTED_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? toConnection(data as unknown as ConnectionRow) : null;
}

/**
 * Record what happened, because this table has no trigger of its own.
 *
 * `campaigns` audits itself through `private.guard_campaign_transition`; this
 * table has no such trigger, so connecting and disconnecting an account would
 * otherwise be the only acts in this domain with no event behind them. Connecting
 * an ad account is an authorisation, and an authorisation with no record is the
 * thing the audit trail exists to prevent.
 *
 * **`actor_id` is explicit.** The `auth.uid()` idiom the SQL writers use reads
 * null under the service key, and this whole file runs under the service key, so
 * relying on it would file a person's decision as the system's.
 *
 * Never throws: an event that failed to write must not undo a connection that
 * succeeded. Logged loudly instead, on the same reasoning `feedback_events` uses
 * in the embed action route.
 */
export async function auditConnection(
  admin: SupabaseClient,
  event: {
    verb: 'channel.connected' | 'channel.revoked';
    actorId: string;
    connectionId: string;
    payload: Record<string, unknown>;
  },
  log: { error: (o: unknown, m: string) => void },
): Promise<void> {
  const { error } = await admin.from('events').insert({
    // Room-scoped, so there is no project to attribute it to. The column is
    // nullable and this is the case it is nullable for.
    project_id: null,
    actor_id: event.actorId,
    actor_kind: 'user',
    verb: event.verb,
    subject_type: 'channel_connection',
    subject_id: event.connectionId,
    payload: event.payload,
  });
  if (error) {
    log.error(
      { err: error, verb: event.verb, connectionId: event.connectionId },
      'connection changed but the event was not recorded',
    );
  }
}
