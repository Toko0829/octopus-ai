import type { SupabaseClient } from '@supabase/supabase-js';
import type { ModelConnection, ModelProviderId, ModelRole, ModelRoute } from '@octopus/contracts';
import { keyHint, modelConnectionAad, open, parseMasterKey, seal } from './envelope';

/**
 * The IO half of connecting a reasoning provider.
 *
 * **`model_connections` is a table where RLS defends nothing**, and every
 * function here is shaped by that. It carries no policy and no grant to
 * `authenticated`, because it holds a customer's paid API key as ciphertext and
 * RLS filters rows rather than columns: a select policy that returned the row
 * would return the ciphertext, the IV and the tag with it. So a user client gets
 * `permission denied`, which is the deliberate answer asserted in
 * `supabase/tests/model_connections.sql`, and everything below runs as the
 * service role.
 *
 * That inverts this codebase's normal posture, exactly as `connections.ts` says
 * for the same reason: **the route is the entire control**, and membership must
 * be established before any function here is called.
 *
 * `model_routes` is the opposite and is read as the caller in the route, because
 * it holds no secret. It is written here, under the service key, after an
 * ownership check.
 */

/**
 * Everything a member may see, and nothing else.
 *
 * Named once and used by every read, so "does the projection leak a key" is a
 * question about one constant rather than a review of every call site.
 * `key_ciphertext`, `key_iv` and `key_tag` are absent, and their absence is
 * asserted directly in the tests: a `select *` here would hand every room member
 * the sealed key and its tag, and it is exactly the edit somebody makes while
 * debugging.
 *
 * `key_hint` is in, and is the one key-shaped thing that may be: four characters
 * that let a person tell two keys apart and complete into nothing.
 */
export const SELECTED_COLUMNS = 'id, provider, key_hint, status, created_at';

interface ConnectionRow {
  id: string;
  provider: string;
  key_hint: string;
  status: string;
  created_at: string;
}

function toConnection(row: ConnectionRow): ModelConnection {
  return {
    id: row.id,
    provider: row.provider as ModelProviderId,
    keyHint: row.key_hint,
    status: row.status as ModelConnection['status'],
    connectedAt: row.created_at,
  };
}

/** Every connection in a room, newest first. Membership is the caller's to have checked. */
export async function readModelConnections(
  admin: SupabaseClient,
  roomId: string,
): Promise<ModelConnection[]> {
  const { data, error } = await admin
    .from('model_connections')
    .select(SELECTED_COLUMNS)
    .eq('room_id', roomId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as ConnectionRow[]).map(toConnection);
}

export interface WriteModelConnectionInput {
  roomId: string;
  connectedBy: string;
  provider: ModelProviderId;
  apiKey: string;
  /** The hex master key, or null when `MODEL_KEY_SECRET` is unset. */
  secret: string | null;
  now: Date;
}

/** The current envelope version. Bumping it is a rotation, which is not built. */
const KEY_VERSION = 1;

/**
 * Seal a key and store it, or refuse.
 *
 * **The refusal exists here rather than only in the route**, on the reasoning
 * `writeConnection` records for `channel_connections`: a document cannot enforce
 * that a credential is never written in the clear, and a check three lines into
 * a handler is a check the next handler forgets. Without a master key there is
 * nowhere safe to put this, so nothing is written at all.
 *
 * Upsert on the unique key the table carries, so re-pasting a key for a provider
 * already connected replaces it rather than creating a rival, and a revoked
 * connection comes back by being reconnected. The status is stated rather than
 * left as whatever was there, and a fresh seal is written every time: reusing a
 * stored IV would be the one GCM mistake that actually breaks the construction.
 */
export async function writeModelConnection(
  admin: SupabaseClient,
  input: WriteModelConnectionInput,
): Promise<ModelConnection> {
  if (!input.secret) {
    throw new Error(
      'Refusing to store a model key: MODEL_KEY_SECRET is unset, so there is no master key ' +
        'to seal it with. Set it (openssl rand -hex 32) or do not offer connecting.',
    );
  }

  const key = parseMasterKey(input.secret);
  const sealed = seal(
    input.apiKey,
    key,
    modelConnectionAad(input.roomId, input.provider, KEY_VERSION),
  );

  const { data, error } = await admin
    .from('model_connections')
    .upsert(
      {
        room_id: input.roomId,
        connected_by: input.connectedBy,
        provider: input.provider,
        key_ciphertext: sealed.ciphertext,
        key_iv: sealed.iv,
        key_tag: sealed.tag,
        key_version: KEY_VERSION,
        key_hint: keyHint(input.apiKey),
        status: 'active',
        updated_at: input.now.toISOString(),
      },
      { onConflict: 'room_id,provider' },
    )
    .select(SELECTED_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('model connection upsert returned no row');

  return toConnection(data as unknown as ConnectionRow);
}

/**
 * Disconnect, which is a revocation and not a delete, and which **also clears
 * every role routed to that provider**.
 *
 * The row survives with `status = 'revoked'` and all three key columns nulled,
 * which is `revokeConnection`'s split: "this provider was connected on this
 * date, by this person, and disconnected on that one" is audit trail worth
 * keeping, and the credential is not.
 *
 * The route deletion is the part with no precedent, and it is the important
 * half. A route pointing at a provider with no key is a role that resolves to
 * nothing, and `resolveGeneration` would have to decide between failing the run
 * and silently using the house key. Neither is a good answer, so the state is
 * made unreachable instead: revoking a key clears the routes that depended on
 * it, and those roles fall back to Auto, which is a state the surface already
 * explains.
 *
 * Conditional on not already being revoked, so a double click is one revocation
 * and the caller can tell the difference.
 */
export async function revokeModelConnection(
  admin: SupabaseClient,
  roomId: string,
  connectionId: string,
  now: Date,
): Promise<ModelConnection | null> {
  const { data, error } = await admin
    .from('model_connections')
    .update({
      status: 'revoked',
      key_ciphertext: null,
      key_iv: null,
      key_tag: null,
      updated_at: now.toISOString(),
    })
    .eq('id', connectionId)
    .eq('room_id', roomId)
    .neq('status', 'revoked')
    .select(SELECTED_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const connection = toConnection(data as unknown as ConnectionRow);

  // After the revocation rather than before it, and not in a transaction. If
  // this fails the key is still gone, which is the half that matters; a stale
  // route resolves to null with a warning rather than to a key that no longer
  // exists. The other order would leave a live key with no routes on a failure,
  // which is a worse thing to be left with.
  const { error: routeError } = await admin
    .from('model_routes')
    .delete()
    .eq('room_id', roomId)
    .eq('provider', connection.provider);
  if (routeError) throw routeError;

  return connection;
}

/**
 * The one place a stored key is opened. Slice 3 is its only consumer.
 *
 * Named so that "where does decryption happen" has a single answer somebody can
 * grep for, which is the property ADR-0032 decision 7 buys by rejecting Vault.
 * Returns null when there is no active connection, so the caller distinguishes
 * "not connected" from "could not open"; the latter throws, because a key we
 * hold and cannot open is a real fault rather than an absence.
 */
export async function openSecretForProvider(
  admin: SupabaseClient,
  roomId: string,
  provider: string,
  secret: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from('model_connections')
    .select('key_ciphertext, key_iv, key_tag, key_version')
    .eq('room_id', roomId)
    .eq('provider', provider)
    .eq('status', 'active')
    .maybeSingle<{
      key_ciphertext: string | null;
      key_iv: string | null;
      key_tag: string | null;
      key_version: number;
    }>();
  if (error) throw error;
  if (!data || !data.key_ciphertext || !data.key_iv || !data.key_tag) return null;

  return open(
    { ciphertext: data.key_ciphertext, iv: data.key_iv, tag: data.key_tag },
    parseMasterKey(secret),
    modelConnectionAad(roomId, provider, data.key_version),
  );
}

interface RouteRow {
  role: string;
  provider: string;
  model: string;
}

/**
 * Every route in a room.
 *
 * Takes whichever client the caller hands it, unlike the connection reads above,
 * and that is deliberate: the route table has a member select policy, so the
 * GET reads it **as the caller** and lets Postgres decide, which is this
 * codebase's normal posture. The writes below pass the service client.
 */
export async function readRoutes(db: SupabaseClient, roomId: string): Promise<ModelRoute[]> {
  const { data, error } = await db
    .from('model_routes')
    .select('role, provider, model')
    .eq('room_id', roomId);
  if (error) throw error;
  return ((data ?? []) as unknown as RouteRow[]).map((row) => ({
    role: row.role as ModelRole,
    provider: row.provider as ModelProviderId,
    model: row.model,
  }));
}

export interface RouteWrite {
  role: ModelRole;
  provider: ModelProviderId | null;
  model: string | null;
}

/**
 * Set or clear routes, one role at a time.
 *
 * **A null provider deletes the row rather than storing a null**, because "no
 * row" is what Auto means and a row saying "no model" would be a second
 * representation of the same state for `resolveGeneration` to disagree about.
 *
 * Not a transaction, and the batch is at most six entries the owner just chose
 * on one surface. A partial apply is visible immediately on the response, which
 * is the projection read back after the writes rather than the request echoed.
 */
export async function writeRoutes(
  admin: SupabaseClient,
  roomId: string,
  updatedBy: string,
  routes: RouteWrite[],
  now: Date,
): Promise<void> {
  for (const route of routes) {
    if (route.provider === null || route.model === null) {
      const { error } = await admin
        .from('model_routes')
        .delete()
        .eq('room_id', roomId)
        .eq('role', route.role);
      if (error) throw error;
      continue;
    }

    const { error } = await admin.from('model_routes').upsert(
      {
        room_id: roomId,
        role: route.role,
        provider: route.provider,
        model: route.model,
        updated_by: updatedBy,
        updated_at: now.toISOString(),
      },
      { onConflict: 'room_id,role' },
    );
    if (error) throw error;
  }
}

/**
 * Record what happened, because these tables have no trigger of their own.
 *
 * Connecting a provider is an authorisation: it hands this system the ability to
 * spend somebody's model quota. An authorisation with no record is the thing the
 * audit trail exists to prevent, which is `auditConnection`'s argument on the
 * table one along.
 *
 * **`actor_id` is explicit.** The `auth.uid()` idiom the SQL writers use reads
 * null under the service key, and this whole file runs under the service key, so
 * relying on it would file a person's decision as the system's.
 *
 * **The payload never carries the key**, not even the hint's source. What is
 * recorded is which provider, which hint, and which roles moved.
 *
 * Never throws: an event that failed to write must not undo a connection that
 * succeeded.
 */
export async function auditModel(
  admin: SupabaseClient,
  event: {
    verb: 'model.connected' | 'model.revoked' | 'model.route_set';
    roomId: string;
    actorId: string;
    /**
     * What the event is about. A connection has an id; a batch of routes does
     * not, so its subject is the room. `subject_id` is `uuid not null`, so this
     * is a real id either way rather than a synthesised one.
     */
    subjectType: 'model_connection' | 'room';
    subjectId: string;
    payload: Record<string, unknown>;
  },
  log: { error: (o: unknown, m: string) => void },
): Promise<void> {
  // `private.notify_from_event` returns immediately on a verb it does not know,
  // so these three record a fact without inventing an inbox item for it.
  // Connecting a model is a settings change the owner just made on screen; a
  // notification about their own click is noise (ADR-0028).
  const { error } = await admin.from('events').insert({
    // Room-scoped, so there is no project to attribute it to. The column is
    // nullable and this is the case it is nullable for.
    project_id: null,
    actor_id: event.actorId,
    actor_kind: 'user',
    verb: event.verb,
    subject_type: event.subjectType,
    subject_id: event.subjectId,
    payload: { roomId: event.roomId, ...event.payload },
  });
  if (error) {
    log.error(
      { err: error, verb: event.verb, roomId: event.roomId },
      'model settings changed but the event was not recorded',
    );
  }
}
