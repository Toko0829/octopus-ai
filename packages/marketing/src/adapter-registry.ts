/**
 * The providers Octopus will talk to, declared rather than discovered.
 *
 * **Why a checked-in map and not a table**, in the words `crawl-registry.ts`
 * already uses for the same decision: every entry here is a claim that we have
 * reviewed what this adapter does with somebody's ad account and their money.
 * That is an editorial and security judgement. **A file gets reviewed in a diff
 * by a person; a row does not.** A provider registry in Postgres would mean a
 * row nobody read could put the publish path in front of an implementation
 * nobody read either.
 *
 * `channel_connections.provider` is plain `text` and is validated against this
 * map before any call is made, which is why the column has no enum and no check
 * constraint: the authority is here, and a second copy in the database would be
 * a second thing to keep in step.
 *
 * **An unknown provider raises.** It never falls back to the fake, and it never
 * returns undefined for a caller to ignore. Defaulting to the fake would be the
 * worst available failure, because the publish path would report success while
 * nothing reached any platform. This is the same stance the risk tier takes in
 * `materialise_plan` and the crawl registry takes on an unregistered host: a
 * value we cannot read is not a value we may guess at.
 */

import type { AdChannelAdapter } from './adapter';
import { createFakeAdapter, FAKE_PROVIDER } from './fake-adapter';

/**
 * Factories rather than instances, so each caller gets its own adapter and no
 * per-connection state is shared between two projects by accident.
 */
export const ADAPTER_REGISTRY: Readonly<Record<string, () => AdChannelAdapter>> = Object.freeze({
  // The only entry today. A real provider lands with its own ADR and with the
  // envelope encryption its credentials require (see the accepted risk in
  // security-compliance.md).
  [FAKE_PROVIDER]: createFakeAdapter,
});

/** Provider keys, for validating a connection row before anything is called. */
export function registeredProviders(): string[] {
  return Object.keys(ADAPTER_REGISTRY);
}

export function isRegisteredProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(ADAPTER_REGISTRY, provider);
}

/**
 * Build the adapter for a provider, or raise.
 *
 * `hasOwnProperty` rather than a truthiness check, so `constructor` and
 * `toString` do not resolve through the prototype chain into something that is
 * not an adapter. The map is frozen and null-prototype would be tidier still,
 * but the explicit check is what a reader can see.
 */
export function adapterFor(provider: string): AdChannelAdapter {
  if (!isRegisteredProvider(provider)) {
    throw new Error(
      `Unknown ad provider "${provider}". Registered: ${registeredProviders().join(', ')}. ` +
        'Adding one is a reviewed change to packages/marketing/src/adapter-registry.ts, not a row.',
    );
  }
  return ADAPTER_REGISTRY[provider]!();
}
