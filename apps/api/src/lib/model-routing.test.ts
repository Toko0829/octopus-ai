/**
 * Resolving a room's route into the target one AI call travels with.
 *
 * Four outcomes and they are not interchangeable, which is the whole reason this
 * is a function rather than a query:
 *
 *   * **No route** is Auto and returns null, which sends the call on the house
 *     key exactly as before connectors existed.
 *   * **A route at a provider with no live connection** also returns null, but
 *     warns: revoking a key deletes its routes, so this state should be
 *     unreachable, and reaching it means a stale row rather than a decision.
 *   * **A route with no master key** throws `not_configured`, and
 *   * **a route whose ciphertext will not open** throws `unreadable`.
 *
 * The two throws are the interesting half. The tempting behaviour for both is to
 * shrug and use the house key, and it is wrong twice: the workspace would be
 * silently billed to us, and the message would be stamped with a model the owner
 * did not choose. A run that stops with the variable named is a bug somebody
 * fixes in a minute.
 */

import { describe, expect, it, vi } from 'vitest';
import { ModelRoutingError, resolveGeneration, toWire } from './model-routing';
import { keyHint, modelConnectionAad, parseMasterKey, seal } from './envelope';

const ROOM = '11111111-1111-4111-8111-111111111111';
const HEX = 'a'.repeat(64);
const OTHER_HEX = 'b'.repeat(64);
const KEY = 'sk-ant-live-not-a-real-key-4f2a';

function sealedFor(hex: string, provider: string, keyVersion = 1) {
  const s = seal(KEY, parseMasterKey(hex), modelConnectionAad(ROOM, provider, keyVersion));
  return {
    key_ciphertext: s.ciphertext,
    key_iv: s.iv,
    key_tag: s.tag,
    key_version: keyVersion,
  };
}

/**
 * A Supabase double over two tables, answering `maybeSingle` from whatever the
 * test put there. Deliberately dumb: the filters are not simulated, because both
 * reads here select exactly one row and what is being tested is the decision, not
 * PostgREST.
 */
function stubClient(rows: { model_routes?: unknown; model_connections?: unknown }) {
  const seen: string[] = [];
  return {
    from(table: string) {
      seen.push(table);
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({
          data: (rows as Record<string, unknown>)[table] ?? null,
          error: null,
        }),
      });
      return b;
    },
    seen,
  };
}

const logger = () => ({ warn: vi.fn() });

describe('resolveGeneration', () => {
  it('returns null when the role is not routed, which is what Auto means', async () => {
    const log = logger();
    const target = await resolveGeneration(stubClient({}) as never, ROOM, 'strategist', HEX, log);
    expect(target).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('never reads a connection when there is no route', async () => {
    // The cheap-path claim: an unrouted room costs one select, not two, and never
    // decrypts anything. Most rooms are this room.
    const client = stubClient({});
    await resolveGeneration(client as never, ROOM, 'content', HEX, logger());
    expect(client.seen).toEqual(['model_routes']);
  });

  it('opens the stored key and names the vendor from the registry', async () => {
    const target = await resolveGeneration(
      stubClient({
        model_routes: { provider: 'anthropic', model: 'claude-sonnet-5' },
        model_connections: sealedFor(HEX, 'anthropic'),
      }) as never,
      ROOM,
      'strategist',
      HEX,
      logger(),
    );
    expect(target).toEqual({
      // From `MODEL_PROVIDERS`, not from the row: the wire shape is a fact about
      // the provider, and a copy of it beside the route is a copy that can go
      // stale against the dialect the service implements.
      vendor: 'anthropic',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      apiKey: KEY,
      baseUrl: null,
    });
  });

  it('resolves the fallback role like any other, so an ungrounded answer is routable', async () => {
    const target = await resolveGeneration(
      stubClient({
        model_routes: { provider: 'google', model: 'gemini-3.8-flash' },
        model_connections: sealedFor(HEX, 'google'),
      }) as never,
      ROOM,
      'fallback',
      HEX,
      logger(),
    );
    expect(target?.vendor).toBe('google');
    expect(target?.model).toBe('gemini-3.8-flash');
  });

  it('warns and falls back when the route points at a provider with no live key', async () => {
    const log = logger();
    const target = await resolveGeneration(
      stubClient({ model_routes: { provider: 'openai', model: 'gpt-5.4' } }) as never,
      ROOM,
      'ads',
      HEX,
      log,
    );
    // Null rather than a throw: revoking a key deletes its routes, so this is
    // stale metadata rather than a decision anybody is making now, and stopping
    // the run over our own bookkeeping would punish the owner for it.
    expect(target).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('throws not_configured when a route exists and there is no master key', async () => {
    await expect(
      resolveGeneration(
        stubClient({ model_routes: { provider: 'anthropic', model: 'claude-opus-5' } }) as never,
        ROOM,
        'strategist',
        null,
        logger(),
      ),
    ).rejects.toMatchObject({ name: 'ModelRoutingError', kind: 'not_configured' });
  });

  it('names the variable in the message, so the fix is in the error', async () => {
    const err = await resolveGeneration(
      stubClient({ model_routes: { provider: 'anthropic', model: 'claude-opus-5' } }) as never,
      ROOM,
      'strategist',
      null,
      logger(),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('MODEL_KEY_SECRET');
  });

  it('does not throw not_configured for an unrouted room with no master key', async () => {
    // The common deployment: no connectors anywhere and no variable set. Refusing
    // to plan for it would be a regression bought with a setting nobody needs.
    await expect(
      resolveGeneration(stubClient({}) as never, ROOM, 'strategist', null, logger()),
    ).resolves.toBeNull();
  });

  it('throws unreadable when the ciphertext was sealed under a different master key', async () => {
    await expect(
      resolveGeneration(
        stubClient({
          model_routes: { provider: 'anthropic', model: 'claude-opus-5' },
          model_connections: sealedFor(OTHER_HEX, 'anthropic'),
        }) as never,
        ROOM,
        'strategist',
        HEX,
        logger(),
      ),
    ).rejects.toMatchObject({ name: 'ModelRoutingError', kind: 'unreadable' });
  });

  it('throws unreadable when the row was sealed for a different provider', async () => {
    // The AAD binds a ciphertext to its row, so a key copied between providers
    // fails to open rather than resolving to somebody else's credential.
    await expect(
      resolveGeneration(
        stubClient({
          model_routes: { provider: 'anthropic', model: 'claude-opus-5' },
          model_connections: sealedFor(HEX, 'openai'),
        }) as never,
        ROOM,
        'strategist',
        HEX,
        logger(),
      ),
    ).rejects.toMatchObject({ kind: 'unreadable' });
  });

  it('carries no key material in either error message', async () => {
    // These messages reach a room and a log. Both of them.
    const notConfigured = new ModelRoutingError('not_configured').message;
    const unreadable = new ModelRoutingError('unreadable').message;
    for (const message of [notConfigured, unreadable]) {
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(keyHint(KEY));
      expect(message).not.toContain(HEX);
    }
  });
});

describe('toWire', () => {
  it('renames to the service contract and sends no base URL when there is none', () => {
    expect(
      toWire({
        vendor: 'anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: KEY,
        baseUrl: null,
      }),
    ).toEqual({
      vendor: 'anthropic',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      api_key: KEY,
    });
  });

  it('sends base_url when the dialect has one', () => {
    expect(
      toWire({
        vendor: 'openai_compatible',
        provider: 'openai',
        model: 'gpt-5.4',
        apiKey: KEY,
        baseUrl: 'https://gateway.example/v1',
      }),
    ).toMatchObject({ base_url: 'https://gateway.example/v1' });
  });

  it('emits exactly the contract keys and nothing else', () => {
    // Renamed rather than spread, and this is the assertion that keeps it so: a
    // field later added to `GenerationTarget` must not reach the wire because
    // somebody widened an object literal, and the field most likely to be added
    // beside a credential is another credential.
    expect(
      Object.keys(
        toWire({
          vendor: 'fake',
          provider: 'fake',
          model: 'fake-strong',
          apiKey: 'fake-key',
        }),
      ).sort(),
    ).toEqual(['api_key', 'model', 'provider', 'vendor']);
  });
});
