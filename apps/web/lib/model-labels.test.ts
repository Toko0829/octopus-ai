/**
 * Turning model settings into the words two surfaces render.
 *
 * **The properties worth pinning are the honest ones.** An id this build does
 * not recognise renders verbatim rather than as "Unknown", because it is still
 * the true answer to what wrote something (ADR-0032 decision 4). A role with
 * nothing routed reports the house default rather than a blank, because a room
 * that has routed nothing still runs on something. And a picker only ever offers
 * models a connected provider actually has, filtered by whether the role
 * produces text or images, because a text model routed to Creative would fail
 * inside a run rather than here.
 */

import { describe, expect, it } from 'vitest';
import { MODEL_PROVIDERS, type ModelConnection, type ModelRoute } from '@octopus/contracts';
import { connectableProviders, labelForRoute, optionsForRole, routesByRole } from './model-labels';

const route = (role: ModelRoute['role'], provider: ModelRoute['provider'], model: string) =>
  ({ role, provider, model }) satisfies ModelRoute;

const connection = (
  provider: ModelConnection['provider'],
  status: ModelConnection['status'] = 'active',
) =>
  ({
    id: `id-${provider}-${status}`,
    provider,
    keyHint: 'abcd',
    status,
    connectedAt: '2026-09-13T10:00:00.000Z',
  }) satisfies ModelConnection;

describe('routesByRole', () => {
  it('keys the routes by role', () => {
    const byRole = routesByRole([
      route('strategist', 'anthropic', 'claude-opus-5'),
      route('ads', 'google', 'gemini-3.8-flash'),
    ]);
    expect(byRole.strategist?.model).toBe('claude-opus-5');
    expect(byRole.ads?.provider).toBe('google');
    expect(byRole.analyst).toBeUndefined();
  });

  it('takes the later row when a role somehow arrives twice', () => {
    // The server writes one row per role, so this only matters if that stops
    // being true. The newest answer is the less wrong one to render.
    const byRole = routesByRole([
      route('content', 'openai', 'gpt-5.4'),
      route('content', 'anthropic', 'claude-sonnet-5'),
    ]);
    expect(byRole.content?.model).toBe('claude-sonnet-5');
  });
});

describe('labelForRoute', () => {
  it('names the routed model', () => {
    expect(labelForRoute(route('ads', 'anthropic', 'claude-sonnet-5'), null)).toBe(
      'Claude Sonnet 5',
    );
  });

  it('falls back to the house default, then to a phrase that names nothing', () => {
    expect(labelForRoute(undefined, { provider: 'openai', model: 'gpt-5.4' })).toBe('GPT-5.4');
    expect(labelForRoute(undefined, null)).toBe('the default model');
  });

  it('renders an unregistered id unchanged', () => {
    expect(labelForRoute(route('ads', 'openai', 'gpt-7-turbo'), null)).toBe('gpt-7-turbo');
    expect(labelForRoute(undefined, { provider: 'openai', model: 'gpt-7-turbo' })).toBe(
      'gpt-7-turbo',
    );
  });
});

describe('connectableProviders', () => {
  it('offers every registered provider', () => {
    expect(
      connectableProviders()
        .map((p) => p.id)
        .sort(),
    ).toEqual(Object.keys(MODEL_PROVIDERS).sort());
  });

  it('puts the ones that carry no real credential last', () => {
    // Not hidden, because it genuinely works and somebody should be able to walk
    // the whole path without spending anything. Last, because putting it among
    // the three that bill somebody invites the wrong click.
    const ids = connectableProviders();
    const firstFake = ids.findIndex((p) => !p.carriesRealCredentials);
    expect(firstFake).toBe(ids.length - 1);
    expect(ids[firstFake]?.id).toBe('fake');
  });
});

describe('optionsForRole', () => {
  it('offers only providers that are connected', () => {
    const options = optionsForRole('strategist', [connection('anthropic')]);
    expect(options.map((o) => o.provider.id)).toEqual(['anthropic']);
  });

  it('leaves out a revoked connection', () => {
    // A route to a provider whose key is gone cannot normally exist: revoking
    // deletes its routes. Offering one here would create that case on purpose.
    expect(optionsForRole('strategist', [connection('anthropic', 'revoked')])).toEqual([]);
  });

  it('gives text roles text models and Creative image models', () => {
    const text = optionsForRole('content', [connection('google')]);
    expect(text[0]?.models.every((m) => !m.images)).toBe(true);

    const images = optionsForRole('creative', [connection('google')]);
    expect(images[0]?.models.every((m) => m.images)).toBe(true);
    expect(images[0]?.models.map((m) => m.id)).toContain('gemini-3.1-flash-image');
  });

  it('offers nothing for Creative when the only connected provider has no image model', () => {
    // The picker then renders a sentence instead of a select with one dead
    // option, which is what a workspace on Anthropic alone sees today.
    expect(optionsForRole('creative', [connection('anthropic')])).toEqual([]);
  });

  it('keeps registry order rather than connection order', () => {
    const options = optionsForRole('ads', [connection('google'), connection('anthropic')]);
    expect(options.map((o) => o.provider.id)).toEqual(['anthropic', 'google']);
  });
});

describe('the labels a picker renders', () => {
  it('writes no em dash in any model or provider name', () => {
    // AGENTS.md rule 22, over the registry itself: these strings are rendered
    // verbatim as option and optgroup labels, so the rule reaches them too.
    for (const provider of Object.values(MODEL_PROVIDERS)) {
      expect(provider.label).not.toContain('—');
      for (const model of provider.models) expect(model.label).not.toContain('—');
    }
  });
});
