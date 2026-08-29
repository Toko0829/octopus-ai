/**
 * Storing and reading a channel connection.
 *
 * Two properties carry this file, and both are security properties rather than
 * behaviour.
 *
 * **The projection cannot return a token.** `channel_connections` has no client
 * policy and no client grant, because RLS filters rows and not columns, so every
 * read here runs as the service role and the selected column list is the entire
 * control. A `select *` written while debugging would be a silent, total
 * credential leak to every member of the room, so the column list is asserted
 * directly rather than trusted to review.
 *
 * **A real credential is refused.** security-compliance.md accepts plaintext
 * tokens in this table only while the sole provider is the in-repo fake, and
 * says envelope encryption lands in the same change as the first real provider.
 * That was a sentence in a document; `writeConnection` makes it a failing write.
 */

import { describe, expect, it, vi } from 'vitest';
import * as marketing from '@octopus/marketing';
import {
  auditConnection,
  markConnectionExpired,
  readConnections,
  readPublishableConnections,
  revokeConnection,
  writeConnection,
} from './connections';

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'fake',
  channel: 'meta',
  external_account_id: 'fake-acct:abc',
  granted_scopes: ['ads:read'],
  status: 'active',
  token_expires_at: '2026-08-29T12:00:00.000Z',
  created_at: '2026-08-29T11:00:00.000Z',
};

/** Captures what was selected and what was written, which is what is under test. */
function stub(row: unknown = ROW) {
  const calls: {
    selected: string[];
    upserted: Record<string, unknown>[];
    updated: Record<string, unknown>[];
    inserted: Record<string, unknown>[];
  } = {
    selected: [],
    upserted: [],
    updated: [],
    inserted: [],
  };
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: (cols: string) => {
      calls.selected.push(cols);
      return builder;
    },
    upsert: (values: Record<string, unknown>) => {
      calls.upserted.push(values);
      return builder;
    },
    update: (values: Record<string, unknown>) => {
      calls.updated.push(values);
      return builder;
    },
    insert: async (values: Record<string, unknown>) => {
      calls.inserted.push(values);
      return { data: null, error: null };
    },
    eq: () => builder,
    neq: () => builder,
    order: async () => ({ data: [row], error: null }),
    maybeSingle: async () => ({ data: row, error: null }),
  });
  return { client: { from: () => builder } as never, calls };
}

describe('the member projection', () => {
  it('never selects a token column', () => {
    // The assertion this file exists for.
    const { client, calls } = stub();
    void readConnections(client, 'room');
    const selected = calls.selected.join(' ');
    expect(selected).not.toContain('access_token');
    expect(selected).not.toContain('refresh_token');
    expect(selected).not.toContain('*');
  });

  it('selects exactly what a member is allowed to see', () => {
    const { client, calls } = stub();
    void readConnections(client, 'room');
    const columns = (calls.selected[0] as string)
      .split(',')
      .map((c) => c.trim())
      .sort();
    expect(columns).toEqual(
      [
        'created_at',
        'channel',
        'external_account_id',
        'granted_scopes',
        'id',
        'provider',
        'status',
        'token_expires_at',
      ].sort(),
    );
  });

  it('maps a row to the wire shape with no token fields on it', async () => {
    const [connection] = await readConnections(stub().client, 'room');
    expect(connection).toEqual({
      id: ROW.id,
      provider: 'fake',
      channel: 'meta',
      externalAccountId: 'fake-acct:abc',
      grantedScopes: ['ads:read'],
      status: 'active',
      tokenExpiresAt: ROW.token_expires_at,
      connectedAt: ROW.created_at,
    });
    expect(Object.keys(connection as object)).not.toContain('accessToken');
  });

  it('reads a null scope array as empty rather than as null', async () => {
    const { client } = stub({ ...ROW, granted_scopes: null });
    const [connection] = await readConnections(client, 'room');
    expect(connection?.grantedScopes).toEqual([]);
  });
});

describe('writeConnection', () => {
  const credential = {
    accessToken: 'fake-access:aaa',
    refreshToken: 'fake-refresh:bbb',
    expiresInSeconds: 3600,
    grantedScopes: ['ads:read'],
    externalAccountId: 'fake-acct:abc',
  };
  const now = new Date('2026-08-29T11:00:00.000Z');

  it('turns the relative lifetime into an absolute instant', async () => {
    // The clock lives here because `packages/marketing` has none. An hour from
    // now, not an hour from whenever the row is next read.
    const { client, calls } = stub();
    await writeConnection(client, {
      roomId: 'room',
      connectedBy: 'user',
      provider: 'fake',
      channel: 'meta',
      credential,
      now,
    });
    expect(calls.upserted[0]?.token_expires_at).toBe('2026-08-29T12:00:00.000Z');
  });

  it('leaves the expiry null for a token that does not age out', async () => {
    const { client, calls } = stub();
    await writeConnection(client, {
      roomId: 'room',
      connectedBy: 'user',
      provider: 'fake',
      channel: 'meta',
      credential: { ...credential, expiresInSeconds: null },
      now,
    });
    expect(calls.upserted[0]?.token_expires_at).toBeNull();
  });

  it('reactivates on reconnect rather than leaving a revoked status', async () => {
    const { client, calls } = stub();
    await writeConnection(client, {
      roomId: 'room',
      connectedBy: 'user',
      provider: 'fake',
      channel: 'meta',
      credential,
      now,
    });
    expect(calls.upserted[0]?.status).toBe('active');
  });

  it('refuses to store a credential for a provider that carries real ones', async () => {
    // The enforced half of the accepted risk. When this test needs changing,
    // envelope encryption belongs in the same commit as the change.
    const spy = vi.spyOn(marketing, 'carriesRealCredentials').mockReturnValue(true);
    try {
      await expect(
        writeConnection(stub().client, {
          roomId: 'room',
          connectedBy: 'user',
          provider: 'meta',
          channel: 'meta',
          credential,
          now,
        }),
      ).rejects.toThrow(/Envelope encryption/);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses before writing anything, not after', async () => {
    const spy = vi.spyOn(marketing, 'carriesRealCredentials').mockReturnValue(true);
    const { client, calls } = stub();
    try {
      await writeConnection(client, {
        roomId: 'room',
        connectedBy: 'user',
        provider: 'meta',
        channel: 'meta',
        credential,
        now,
      }).catch(() => undefined);
      expect(calls.upserted).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an unregistered provider, because unknown is not the same as safe', async () => {
    await expect(
      writeConnection(stub().client, {
        roomId: 'room',
        connectedBy: 'user',
        provider: 'never-reviewed',
        channel: 'meta',
        credential,
        now,
      }),
    ).rejects.toThrow(/Unknown channel auth provider/);
  });
});

describe('revokeConnection', () => {
  it('nulls both tokens and keeps the row', async () => {
    // Not a delete: "connected on this date, disconnected on that one" is audit
    // trail worth keeping, and the credential is not.
    const { client, calls } = stub({ ...ROW, status: 'revoked' });
    await revokeConnection(client, 'room', ROW.id, new Date());
    expect(calls.updated[0]).toMatchObject({
      status: 'revoked',
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
    });
  });

  it('returns null when nothing was revoked', async () => {
    // Already revoked, or not in this room. The caller reports one conflict for
    // both rather than confirming which ids exist.
    const { client } = stub(null);
    expect(await revokeConnection(client, 'room', ROW.id, new Date())).toBeNull();
  });
});

describe('auditConnection', () => {
  it('records the scopes and the account, never the token', async () => {
    const { client, calls } = stub();
    await auditConnection(
      client,
      {
        verb: 'channel.connected',
        actorId: 'user',
        connectionId: ROW.id,
        payload: { provider: 'fake', grantedScopes: ['ads:read'] },
      },
      { error: () => {} },
    );
    expect(JSON.stringify(calls.inserted[0])).not.toContain('fake-access');
  });

  it('files the act under the person, not the system', async () => {
    // `auth.uid()` reads null under the service key, and this whole file runs
    // under it, so an implicit actor would record a person's decision as ours.
    const { client, calls } = stub();
    await auditConnection(
      client,
      { verb: 'channel.revoked', actorId: 'user-7', connectionId: ROW.id, payload: {} },
      { error: () => {} },
    );
    expect(calls.inserted[0]).toMatchObject({ actor_id: 'user-7', actor_kind: 'user' });
  });

  it('never throws, because a missing event must not undo a real connection', async () => {
    const failing = {
      from: () => ({ insert: async () => ({ data: null, error: { message: 'nope' } }) }),
    } as never;
    const logged: unknown[] = [];
    await expect(
      auditConnection(
        failing,
        { verb: 'channel.connected', actorId: 'u', connectionId: ROW.id, payload: {} },
        { error: (o) => logged.push(o) },
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });
});

describe('the publisher projection', () => {
  it('never selects a token column either', () => {
    // A SECOND column list, asserted separately. Merging the two constants would
    // mean one list answering two questions, and widening it for the publisher
    // would silently widen what a room member sees.
    const { client, calls } = stub();
    void readPublishableConnections(client, 'room', 'meta');
    const selected = calls.selected.join(' ');
    expect(selected).not.toContain('access_token');
    expect(selected).not.toContain('refresh_token');
    expect(selected).not.toContain('*');
  });

  it('selects exactly what a publish decision needs', () => {
    const { client, calls } = stub();
    void readPublishableConnections(client, 'room', 'meta');
    const columns = (calls.selected[0] as string)
      .split(',')
      .map((c) => c.trim())
      .sort();
    expect(columns).toEqual(['created_at', 'granted_scopes', 'id', 'provider', 'status'].sort());
  });

  it('maps a row to the candidate shape the decision takes', async () => {
    const [candidate] = await readPublishableConnections(stub().client, 'room', 'meta');
    expect(candidate).toEqual({
      id: ROW.id,
      provider: 'fake',
      grantedScopes: ['ads:read'],
      status: 'active',
      createdAt: ROW.created_at,
    });
  });

  it('reads a null scope array as no scopes, never as every scope', () => {
    // The direction matters: an empty grant makes `checkScopes` refuse, which is
    // the safe answer for a column that should never have been null.
    const { client } = stub({ ...ROW, granted_scopes: null });
    return readPublishableConnections(client, 'room', 'meta').then(([candidate]) => {
      expect(candidate?.grantedScopes).toEqual([]);
    });
  });
});

describe('expiry is not revocation', () => {
  it('records the status and leaves both tokens alone', async () => {
    // `revokeConnection` nulls the tokens because the credential should not
    // exist; an expiry means it stopped working, and the refresh token is what
    // reconnecting uses. Nulling here would make a recoverable state final.
    const { client, calls } = stub();
    await markConnectionExpired(client, ROW.id, new Date('2026-08-29T13:00:00.000Z'));

    expect(calls.updated[0]).toMatchObject({ status: 'expired' });
    expect(calls.updated[0]).not.toHaveProperty('access_token');
    expect(calls.updated[0]).not.toHaveProperty('refresh_token');
  });
});
