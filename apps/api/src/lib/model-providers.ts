import {
  MODEL_PROVIDERS,
  isRegisteredModelProvider,
  type ModelProviderId,
} from '@octopus/contracts';

/**
 * Checking a key against the provider that issued it, before anything is stored.
 *
 * **This is the whole reason connecting is a route rather than a form field.** A
 * wrong key stored happily is a key that fails four minutes into an agent run,
 * in a system notice, on a surface where the person cannot tell a typo from an
 * outage. Checking here moves that failure to the settings block, where the
 * paste is still on screen and the fix is obvious.
 *
 * **A list-models call, because it is the one request every vendor answers for
 * free.** It authenticates, it needs no model id and no tokens, and it bills
 * nothing. A one-token completion would also work and would cost a fraction of a
 * cent per paste, which is somebody else's fraction of a cent.
 *
 * Nothing here reads the response body. What is being asked is "does this key
 * authenticate", and the status code is the entire answer; parsing the model
 * list would tie us to three response shapes for no gain, and the registry is
 * deliberately curated rather than fetched.
 */

export type VerifyKeyResult = { ok: true } | { ok: false; reason: 'invalid_key' | 'unreachable' };

/** Where each vendor answers "who am I", and with which header. */
const MODELS_ENDPOINT: Readonly<
  Record<ModelProviderId, { url: string; headers: (key: string) => Record<string, string> }>
> = Object.freeze({
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key }),
  },
  // Never called: `verifyKey` short-circuits on the prefix below.
  fake: { url: '', headers: () => ({}) },
});

/** The prefix a fake key must carry, so a real one pasted here fails loudly. */
const FAKE_KEY_PREFIX = 'fake-';

/**
 * Does this key authenticate against its provider?
 *
 * Three outcomes rather than a boolean, because the caller says three different
 * sentences. `invalid_key` is the person's to fix and is a 400. `unreachable` is
 * ours or the vendor's and is a 502, with nothing stored either way: storing a
 * key we could not check would mean the settings block shows "connected" for
 * something that may never work.
 *
 * **A 4xx that is not 401 or 403 counts as invalid.** A 404 on the models
 * endpoint most often means the key is for a different product or project, which
 * the person fixes the same way they fix a typo. Only a transport failure and a
 * 5xx are the vendor's problem.
 *
 * `fetchImpl` is injected so the tests drive every branch without a network, and
 * the timeout is enforced here rather than trusted to the runtime: a vendor that
 * accepts a connection and never answers would otherwise hold a request open for
 * as long as it liked.
 */
export async function verifyKey(
  provider: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<VerifyKeyResult> {
  if (!isRegisteredModelProvider(provider)) {
    // Unreachable through the routes, which validate the provider first. Fails
    // closed rather than throwing, so a caller that skipped that check refuses
    // the key instead of storing it unchecked.
    return { ok: false, reason: 'invalid_key' };
  }

  if (provider === 'fake') {
    // No network, and a prefix check rather than an accept-anything: a real key
    // pasted against the fake provider should fail here rather than be stored
    // encrypted under a name that promises never to use it.
    return apiKey.startsWith(FAKE_KEY_PREFIX) ? { ok: true } : { ok: false, reason: 'invalid_key' };
  }

  const endpoint = MODELS_ENDPOINT[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint.url, {
      method: 'GET',
      headers: endpoint.headers(apiKey),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status >= 500) return { ok: false, reason: 'unreachable' };
    return { ok: false, reason: 'invalid_key' };
  } catch {
    // A transport error, a DNS failure or our own timeout. Deliberately not
    // distinguished: all three mean "we could not ask", which is one sentence to
    // the person and one status code.
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raises on an unknown provider rather than answering `false`, which is the
 * `packages/marketing` idiom and the inverted-reading argument recorded there:
 * an unregistered name is one nobody reviewed, and answering `false` would let a
 * writer treat its key as harmless. Fail closed.
 */
export function modelProviderCarriesRealCredentials(provider: string): boolean {
  if (!isRegisteredModelProvider(provider)) {
    throw new Error(
      `Unknown model provider "${provider}". Registered: ${Object.keys(MODEL_PROVIDERS).join(', ')}.`,
    );
  }
  return MODEL_PROVIDERS[provider].carriesRealCredentials;
}
