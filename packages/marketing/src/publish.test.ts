/**
 * The publish decisions, in the `spend.test.ts` shape.
 *
 * Three properties whose violation is invisible at the type level and expensive
 * at runtime.
 *
 * **The key is a pure function of the campaign id.** If it ever picks up a clock,
 * a run id or a random value, every retry becomes a second ad instead of finding
 * the first, and nothing about that fails to compile or throws. The exact string
 * is pinned here because it is also pinned in Postgres by
 * `ad_entities.idempotency_key`, and the two only agree by construction.
 *
 * **A non-active connection is chosen rather than hidden.** Refusing with "no
 * connection" when one exists and expired sends the owner to connect an account
 * they already connected, which is how somebody concludes the product is broken.
 *
 * **Every adapter error maps to the action the module rule requires.** A policy
 * rejection routed into the retry arm is the silently-keep-spending path
 * `adapter.ts` was designed to prevent, and a transient provider failure routed
 * into the terminal arm destroys a campaign a person authorised and paid
 * attention to.
 */

import { describe, expect, it } from 'vitest';
import {
  chooseConnection,
  decidePublishOutcome,
  publishIdempotencyKey,
  type PublishConnectionCandidate,
} from './publish';
import { createFakeAdapter, FAKE_PROVIDER, POLICY_VIOLATION_MARKER } from './fake-adapter';
import type { AdapterEntityRef, AdapterError, AdapterResult } from './adapter';

const CAMPAIGN = '11111111-1111-4111-8111-111111111111';

function candidate(over: Partial<PublishConnectionCandidate> = {}): PublishConnectionCandidate {
  return {
    id: 'c1',
    provider: FAKE_PROVIDER,
    grantedScopes: ['ads:read', 'ads:write'],
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

function failure(error: AdapterError): AdapterResult<AdapterEntityRef> {
  return { ok: false, error };
}

describe('the key names one side effect and nothing else about the moment', () => {
  it('is a pure function of the campaign id', () => {
    expect(publishIdempotencyKey(CAMPAIGN)).toBe(`publish:${CAMPAIGN}:campaign`);
    expect(publishIdempotencyKey(CAMPAIGN)).toBe(publishIdempotencyKey(CAMPAIGN));
  });

  it('differs per campaign', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(publishIdempotencyKey(other)).not.toBe(publishIdempotencyKey(CAMPAIGN));
  });

  it('carries the tree level, so slice 6 cannot collide with it', () => {
    // The suffix is the reason an ad set published later under the same campaign
    // gets its own key without changing this one. Changing the key of a campaign
    // already published is the single edit this value must never suffer.
    expect(publishIdempotencyKey(CAMPAIGN).endsWith(':campaign')).toBe(true);
  });

  it('produces a stable external id through the fake, in this process and the next', async () => {
    // The two halves of idempotency meeting: our key, their derived id. Asserted
    // together because a test on either alone would pass while they disagreed.
    const adapter = createFakeAdapter();
    const key = publishIdempotencyKey(CAMPAIGN);
    const first = await adapter.createCampaign(
      { name: 'Launch', channel: 'meta', budgetCap: 400, currency: 'USD' },
      key,
    );
    const second = await createFakeAdapter().createCampaign(
      { name: 'Launch', channel: 'meta', budgetCap: 400, currency: 'USD' },
      key,
    );

    expect(first.ok && second.ok && first.value.externalId).toBe(
      second.ok ? second.value.externalId : 'different',
    );
    expect(first.ok && first.value.externalId).toMatch(/^fake:[0-9a-f]{12}$/);
  });
});

describe('choosing which account publishes', () => {
  it('refuses when nothing is connected, and says so as a channel problem', () => {
    const choice = chooseConnection([]);

    expect(choice.chosen).toBe(false);
    expect(choice.chosen === false && choice.rule).toBe('no_connection');
  });

  it('prefers an active connection over an expired one whatever their order', () => {
    const expired = candidate({
      id: 'old',
      status: 'expired',
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    const active = candidate({
      id: 'new',
      status: 'active',
      createdAt: '2026-08-02T00:00:00.000Z',
    });

    expect(chooseConnection([expired, active]).chosen === true).toBe(true);
    const choice = chooseConnection([expired, active]);
    expect(choice.chosen === true && choice.connection.id).toBe('new');
  });

  it('takes the newest when several are active, because reconnecting supersedes', () => {
    const older = candidate({ id: 'older', createdAt: '2026-08-01T00:00:00.000Z' });
    const newer = candidate({ id: 'newer', createdAt: '2026-08-25T00:00:00.000Z' });

    const choice = chooseConnection([older, newer]);
    expect(choice.chosen === true && choice.connection.id).toBe('newer');
  });

  it('returns an expired connection when it is the only one, rather than pretending there is none', () => {
    // The load-bearing case. `checkScopes` runs next and produces "this
    // connection has expired and needs reconnecting", which is the sentence that
    // actually unblocks the owner. Refusing here with "no connection" would send
    // them to connect an account they already connected.
    const choice = chooseConnection([candidate({ status: 'expired' })]);

    expect(choice.chosen === true && choice.connection.status).toBe('expired');
  });

  it('never chooses a provider the registry does not know', () => {
    const choice = chooseConnection([candidate({ provider: 'meta' })]);

    expect(choice.chosen).toBe(false);
    expect(choice.chosen === false && choice.rule).toBe('no_registered_provider');
    // The refusal names the registry, because that is where the fix is.
    expect(choice.chosen === false && choice.reason).toContain(FAKE_PROVIDER);
  });

  it('picks the registered one out of a mixed set', () => {
    const unregistered = candidate({
      id: 'meta',
      provider: 'meta',
      createdAt: '2026-08-28T00:00:00.000Z',
    });
    const registered = candidate({ id: 'fake', createdAt: '2026-08-01T00:00:00.000Z' });

    const choice = chooseConnection([unregistered, registered]);
    expect(choice.chosen === true && choice.connection.id).toBe('fake');
  });

  it('does not let a malformed timestamp outrank a good one', () => {
    const broken = candidate({ id: 'broken', createdAt: 'not-a-date' });
    const good = candidate({ id: 'good', createdAt: '2026-01-01T00:00:00.000Z' });

    const choice = chooseConnection([broken, good]);
    expect(choice.chosen === true && choice.connection.id).toBe('good');
  });

  it('does not mutate the array it was given', () => {
    const rows = [
      candidate({ id: 'a', createdAt: '2026-08-01T00:00:00.000Z' }),
      candidate({ id: 'b', createdAt: '2026-08-09T00:00:00.000Z' }),
    ];
    chooseConnection(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('what to do about what the platform answered', () => {
  it('confirms a success and carries the id', () => {
    const decision = decidePublishOutcome({
      ok: true,
      value: { externalId: 'fake:abc123abc123' },
      alreadyExisted: false,
    });

    expect(decision.action).toBe('confirm');
    expect(decision.action === 'confirm' && decision.externalId).toBe('fake:abc123abc123');
  });

  it('carries alreadyExisted through, so a retry reads as a retry', () => {
    const decision = decidePublishOutcome({
      ok: true,
      value: { externalId: 'fake:abc123abc123' },
      alreadyExisted: true,
    });

    expect(decision.action === 'confirm' && decision.alreadyExisted).toBe(true);
  });

  it('sends a policy rejection to revise-and-re-approve, never to retry', () => {
    // The one that matters most. Routed into `retry` this becomes the
    // silently-keep-spending path the whole error union exists to prevent.
    const decision = decidePublishOutcome(
      failure({ kind: 'policy_rejected', message: 'Disapproved.', detail: 'Prohibited claim.' }),
    );

    expect(decision.action).toBe('reject');
    expect(decision.action === 'reject' && decision.detail).toBe('Prohibited claim.');
  });

  it('stops on a spec the platform will never accept', () => {
    const decision = decidePublishOutcome(
      failure({ kind: 'invalid_spec', message: 'Bad budget.' }),
    );

    expect(decision.action).toBe('stop');
    expect(decision.action === 'stop' && decision.kind).toBe('invalid_spec');
  });

  it('stops on not_found rather than retrying blind', () => {
    const decision = decidePublishOutcome(failure({ kind: 'not_found', message: 'Gone.' }));

    expect(decision.action).toBe('stop');
  });

  it('waits for a reconnect on an expired credential', () => {
    const decision = decidePublishOutcome(
      failure({ kind: 'auth_expired', message: 'Token expired.' }),
    );

    expect(decision.action).toBe('await_reconnect');
  });

  it('retries a rate limit and carries the platform hint', () => {
    const decision = decidePublishOutcome(
      failure({ kind: 'rate_limited', message: 'Slow down.', retryAfterMs: 5000 }),
    );

    expect(decision.action).toBe('retry');
    expect(decision.action === 'retry' && decision.retryAfterMs).toBe(5000);
  });

  it('retries a provider error rather than destroying an authorised campaign', () => {
    // `failed` is terminal in Postgres with no retry arc, so treating a 503 as
    // terminal would close a campaign somebody authorised because a server
    // blipped. Recovering from that costs a new card and a re-typed budget.
    const decision = decidePublishOutcome(
      failure({ kind: 'provider_error', message: 'Upstream unavailable.', status: 503 }),
    );

    expect(decision.action).toBe('retry');
    expect(decision.action === 'retry' && decision.status).toBe(503);
  });

  it('quotes the platform verbatim on every failure', () => {
    // A person reading "the platform said X" needs X to be what the platform
    // said. Paraphrasing it would be this codebase inventing a reason for
    // somebody else's decision.
    const kinds: AdapterError[] = [
      { kind: 'policy_rejected', message: 'MSG' },
      { kind: 'invalid_spec', message: 'MSG' },
      { kind: 'not_found', message: 'MSG' },
      { kind: 'auth_expired', message: 'MSG' },
      { kind: 'rate_limited', message: 'MSG' },
      { kind: 'provider_error', message: 'MSG' },
    ];

    for (const error of kinds) {
      const decision = decidePublishOutcome(failure(error));
      expect(decision.action === 'confirm' ? '' : decision.message).toBe('MSG');
    }
  });

  it('reaches the reject arm from a real fake rejection', () => {
    // End to end through the double rather than a hand-built union value, so the
    // marker the fake actually recognises stays the marker this decides on.
    return createFakeAdapter()
      .createCampaign(
        {
          name: `Launch ${POLICY_VIOLATION_MARKER}`,
          channel: 'meta',
          budgetCap: 400,
          currency: 'USD',
        },
        publishIdempotencyKey(CAMPAIGN),
      )
      .then((result) => {
        expect(decidePublishOutcome(result).action).toBe('reject');
      });
  });

  it('states a next step in every refusal, without an em dash', () => {
    // Rule 22 applies wherever a sentence can reach a person, and these reasons
    // reach the room through the sweep's messages.
    const decisions = (
      [
        { kind: 'policy_rejected', message: 'm' },
        { kind: 'invalid_spec', message: 'm' },
        { kind: 'not_found', message: 'm' },
        { kind: 'auth_expired', message: 'm' },
        { kind: 'rate_limited', message: 'm' },
        { kind: 'provider_error', message: 'm' },
      ] as AdapterError[]
    ).map((e) => decidePublishOutcome(failure(e)));

    for (const decision of decisions) {
      if (decision.action === 'confirm') continue;
      expect(decision.reason.length).toBeGreaterThan(0);
      expect(decision.reason).not.toContain('—');
    }
  });
});
