/**
 * The model registry, and the key check that runs before anything is stored.
 *
 * The registry half asserts properties rather than contents. Which models are
 * offered is an editorial decision that will change; that every provider offers
 * at least one strong model, that no id appears under two providers, and that
 * the fake provider is flagged as carrying no real credential are invariants the
 * rest of the system reads as facts.
 *
 * The `verifyKey` half exists because the failure it prevents is expensive and
 * silent: a key stored happily and refused four minutes into an agent run, in a
 * system notice, where a person cannot tell a typo from an outage.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_PROVIDERS,
  defaultModelFor,
  isRegisteredModelProvider,
  labelForModel,
  modelBelongsTo,
  vendorFor,
} from '@octopus/contracts';
import { modelProviderCarriesRealCredentials, verifyKey } from './model-providers';

describe('the registry', () => {
  it('gives every provider at least one strong model', () => {
    // A provider with only cheap models could be connected and then never
    // routed anywhere, which is a dead entry in a picker.
    for (const provider of Object.values(MODEL_PROVIDERS)) {
      expect(provider.models.some((m) => m.tier === 'strong')).toBe(true);
    }
  });

  it('never repeats a model id across providers', () => {
    // `modelEntryFor` and `labelForModel` search across providers, so a repeated
    // id would resolve to whichever came first and render the wrong label.
    const ids = Object.values(MODEL_PROVIDERS).flatMap((p) => p.models.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flags the fake provider as carrying no real credential', () => {
    expect(MODEL_PROVIDERS.fake.carriesRealCredentials).toBe(false);
    expect(modelProviderCarriesRealCredentials('fake')).toBe(false);
  });

  it('flags every other provider as carrying one', () => {
    for (const [id, provider] of Object.entries(MODEL_PROVIDERS)) {
      if (id === 'fake') continue;
      expect(provider.carriesRealCredentials).toBe(true);
    }
  });

  it('raises on an unregistered provider rather than answering false', () => {
    // The inverted reading, "a provider we have never heard of certainly does
    // not carry real credentials", is the one that matters: an unregistered name
    // is one nobody reviewed. Fail closed.
    expect(() => modelProviderCarriesRealCredentials('mystery')).toThrow(/Unknown model provider/);
    expect(() => vendorFor('mystery')).toThrow(/Unknown model provider/);
  });

  it('does not resolve a prototype property as a provider', () => {
    expect(isRegisteredModelProvider('constructor')).toBe(false);
    expect(isRegisteredModelProvider('toString')).toBe(false);
    expect(modelBelongsTo('constructor', 'anything')).toBe(false);
  });

  it('knows which models belong to which provider', () => {
    expect(modelBelongsTo('anthropic', 'claude-opus-5')).toBe(true);
    expect(modelBelongsTo('anthropic', 'gpt-5.4')).toBe(false);
    expect(modelBelongsTo('openai', 'gpt-5.4')).toBe(true);
  });

  it('renders an unknown model id as itself', () => {
    // An id we no longer recognise is still the true answer to what wrote a
    // thing, so it is more honest than "Unknown" over a real audit trail.
    expect(labelForModel('claude-opus-5')).toBe('Claude Opus 5');
    expect(labelForModel('gpt-7-from-the-future')).toBe('gpt-7-from-the-future');
  });

  it('picks a first model per tier, and null for an unknown provider', () => {
    expect(defaultModelFor('openai')).toBe('gpt-5.4');
    expect(defaultModelFor('openai', 'cheap')).toBe('gpt-5.4-mini');
    expect(defaultModelFor('mystery')).toBeNull();
  });

  it('offers image models only where images are actually produced', () => {
    // The creative role needs one and every other role must not get one, so an
    // empty set here would make that check unfalsifiable.
    const images = Object.values(MODEL_PROVIDERS).flatMap((p) => p.models.filter((m) => m.images));
    expect(images.length).toBeGreaterThan(0);
  });
});

describe('verifyKey', () => {
  const ok = () => new Response('{}', { status: 200 });

  it('sends each vendor its own auth header', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return ok();
    }) as unknown as typeof fetch;

    await verifyKey('anthropic', 'sk-ant', fetchImpl);
    await verifyKey('openai', 'sk-oai', fetchImpl);
    await verifyKey('google', 'sk-goo', fetchImpl);

    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/models');
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant');
    expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen[1]!.url).toBe('https://api.openai.com/v1/models');
    expect(seen[1]!.headers.authorization).toBe('Bearer sk-oai');
    expect(seen[2]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(seen[2]!.headers['x-goog-api-key']).toBe('sk-goo');
  });

  it('accepts a key the provider accepts', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    await expect(verifyKey('openai', 'sk-oai', fetchImpl)).resolves.toEqual({ ok: true });
  });

  it.each([401, 403, 404, 400])('treats %i as the key being wrong', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
    await expect(verifyKey('openai', 'sk-oai', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'invalid_key',
    });
  });

  it.each([500, 502, 503])('treats %i as the provider being unreachable', async (status) => {
    // Not the person's fault and not their fix, so it is a different status code
    // and a different sentence.
    const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch;
    await expect(verifyKey('openai', 'sk-oai', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('treats a transport failure as unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(verifyKey('anthropic', 'sk-ant', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
    });
  });

  it('checks the fake provider by prefix and touches no network', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    await expect(verifyKey('fake', 'fake-anything', fetchImpl)).resolves.toEqual({ ok: true });
    // A real key pasted against the fake provider fails here rather than being
    // stored encrypted under a name that promises never to use it.
    await expect(verifyKey('fake', 'sk-ant-real', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'invalid_key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an unregistered provider without calling anything', async () => {
    const fetchImpl = vi.fn(async () => ok()) as unknown as typeof fetch;
    await expect(verifyKey('mystery', 'k', fetchImpl)).resolves.toEqual({
      ok: false,
      reason: 'invalid_key',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
