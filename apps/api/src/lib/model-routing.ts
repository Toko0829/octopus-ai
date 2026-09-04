import type { SupabaseClient } from '@supabase/supabase-js';
import { vendorFor, type ModelRole, type ModelVendor } from '@octopus/contracts';
import { EnvelopeError } from './envelope';
import { openSecretForProvider } from './model-connections';

/**
 * Turning a room's routes into the target one AI call travels with.
 *
 * **This is the only place a stored customer key becomes a value in memory**, and
 * the reason it is one function rather than a line in each caller. `openSecretForProvider`
 * is the read; this is the decision around it: which role, whether that role is
 * routed at all, and what to do when the answer is "routed, but we cannot open
 * it". ADR-0032 decision 7 buys the property that decryption happens only in the
 * Node code building the outbound request, and a second decrypting caller is how
 * that property stops being true.
 *
 * **A route decides who proposes, never who acts** (ADR-0032 decision 6). Nothing
 * here is consulted by `routeTask`, `checkSpendCap` or `apply_plan_diff`. A room
 * with the strongest model connected has exactly the authority a room with none
 * has, which is none, and the plan card is still the boundary.
 */

/** What one call is sent on. `apiKey` is a live customer credential in memory. */
export interface GenerationTarget {
  vendor: ModelVendor;
  /** Registry id, echoed back by the service and recorded in the ledger. */
  provider: string;
  model: string;
  apiKey: string;
  /** `openai_compatible` only. Absent means the vendor's own endpoint. */
  baseUrl?: string | null;
}

/**
 * A route exists and could not be honoured. Never carries a key or a ciphertext.
 *
 * **Two kinds, because the operator's next move differs and the person's sentence
 * does not.** `not_configured` is a deployment that offered to route somewhere and
 * has no master key to open the credential with, which is a variable to set;
 * `unreadable` is a stored ciphertext that will not open, which means the master
 * key changed under rows sealed with the old one and is a restore or a re-paste.
 *
 * **Both fail the run loudly rather than falling back to the house key.** Quiet
 * fallback is the tempting behaviour and it is the wrong one twice over: the
 * workspace chose a provider and would be silently billed to ours instead, and the
 * message would be stamped with a model the owner did not pick. A run that stops
 * with the variable named is a bug somebody fixes in a minute; a run that
 * misroutes is one nobody notices.
 */
export class ModelRoutingError extends Error {
  constructor(readonly kind: 'not_configured' | 'unreadable') {
    super(
      kind === 'not_configured'
        ? 'This workspace routes a role to its own model provider, but MODEL_KEY_SECRET is ' +
            'unset, so the stored key cannot be opened. Set it (openssl rand -hex 32) to the ' +
            'same value the key was sealed with.'
        : 'This workspace has a model key that could not be opened. It was sealed with a ' +
            'different MODEL_KEY_SECRET than the one this process holds, so it has to be ' +
            'connected again.',
    );
    this.name = 'ModelRoutingError';
  }
}

interface RouteRow {
  provider: string;
  model: string;
}

/**
 * The target for one role in one room, or null for the house default.
 *
 * Null is the ordinary answer and means **Auto**: no route row for the role, so
 * `services/ai` uses the server's own key exactly as it did before any of this
 * existed. It is deliberately the same value as "routed at a provider whose
 * connection has gone", which is the one case worth reading twice.
 *
 * **A dangling route warns and falls back rather than failing.** Revoking a key
 * deletes the routes that pointed at it (`revokeModelConnection`), so this state
 * should be unreachable; if it is reached, the row is stale metadata rather than a
 * decision anybody is making now, and stopping the run over it would punish the
 * owner for our bookkeeping. The two error kinds above are different: there the
 * credential exists and we are failing to use it, which is ours to fix.
 *
 * Reads as the service role, because `model_connections` has no client grant at
 * all. Membership is not this function's to check and there is nothing here for it
 * to check: it is called from inside a run that was already authorised.
 */
export async function resolveGeneration(
  admin: SupabaseClient,
  roomId: string,
  role: ModelRole,
  secret: string | null,
  log: { warn: (obj: object, msg: string) => void },
): Promise<GenerationTarget | null> {
  const { data, error } = await admin
    .from('model_routes')
    .select('provider, model')
    .eq('room_id', roomId)
    .eq('role', role)
    .maybeSingle<RouteRow>();
  if (error) throw error;
  if (!data) return null;

  // Checked after the route read rather than before it, so a deployment with no
  // master key and no routes never raises: the overwhelming majority of rooms
  // route nothing, and refusing to plan for them would be a regression bought
  // with a variable they do not need.
  if (!secret) throw new ModelRoutingError('not_configured');

  let apiKey: string | null;
  try {
    apiKey = await openSecretForProvider(admin, roomId, data.provider, secret);
  } catch (err) {
    if (err instanceof EnvelopeError) throw new ModelRoutingError('unreadable');
    throw err;
  }

  if (!apiKey) {
    log.warn(
      { roomId, role, provider: data.provider },
      'a role is routed to a provider with no active connection; falling back to the house default',
    );
    return null;
  }

  return {
    // From the registry rather than stored beside the route. The wire shape is a
    // fact about the provider and a copy of it in a row is a copy that can go
    // stale against the dialect the service actually implements.
    vendor: vendorFor(data.provider),
    provider: data.provider,
    model: data.model,
    apiKey,
    baseUrl: null,
  };
}

/**
 * The target as `services/ai` reads it (snake_case, `api_key`).
 *
 * Renamed rather than spread, which is this codebase's rule for every AI-service
 * body and load-bearing here for a second reason: a spread would carry any field
 * that is later added to `GenerationTarget` onto the wire without anybody
 * deciding to, and the field most likely to be added beside a credential is
 * another credential.
 *
 * `base_url` is omitted rather than sent as null when there is none, because the
 * service's own schema defaults it and "absent" is what its default is written
 * for. **Never logged**: the object this returns holds a live customer key, and
 * nothing in `ai.ts` logs a request body.
 */
export function toWire(target: GenerationTarget): Record<string, unknown> {
  return {
    vendor: target.vendor,
    provider: target.provider,
    model: target.model,
    api_key: target.apiKey,
    ...(target.baseUrl ? { base_url: target.baseUrl } : {}),
  };
}
