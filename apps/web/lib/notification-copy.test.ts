import { describe, expect, it } from 'vitest';
import type { Notification } from '@octopus/contracts';
import {
  COMPOSED_KINDS,
  NOTIFICATION_SLOTS,
  composeNotification,
  hrefFor,
  money,
  until,
} from './notification-copy';

/**
 * The sentences people actually read.
 *
 * **This file is the reason the copy is in TypeScript rather than in the row.**
 * AGENTS.md rule 22 bans em dashes in product copy and names notifications in
 * the list; a template composed in plpgsql could only be checked by somebody
 * reading the migration. Here every slot is walked and every rendered string is
 * asserted, which is a thing a machine can do on every push.
 */

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

/** One row of each shape, with the payload the deriving trigger actually writes. */
function rowFor(slot: string): Notification {
  const [kind, role] = slot.split(':') as [Notification['kind'], Notification['recipientRole']];
  const payload: Record<string, unknown> = {
    task_id: '55555555-5555-4555-8555-555555555555',
    task_title: 'Draft the launch email',
    room_id: '66666666-6666-4666-8666-666666666666',
    expires_at: '2026-09-11T12:00:00.000Z',
    deadline_at: '2026-09-16T12:00:00.000Z',
    agreed_price: 400,
    amount: 400,
    rate: 250,
    currency: 'USD',
    note: 'The headline does not match the brief.',
    resolution: 'partial',
    release_amount: 150,
    refund_amount: 400,
    raised_role: role === 'node' ? 'owner' : 'node',
    from_state: 'in_progress',
    to: 'verified',
    from: 'pending',
  };
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind,
    recipientRole: role,
    subjectType: 'task',
    subjectId: '22222222-2222-4222-8222-222222222222',
    projectId: '33333333-3333-4333-8333-333333333333',
    payload,
    createdAt: '2026-09-09T10:00:00.000Z',
    readAt: null,
  };
}

describe('every kind can be said out loud', () => {
  it('has a sentence for each kind the contract declares', () => {
    for (const kind of COMPOSED_KINDS) {
      const found = NOTIFICATION_SLOTS.some((slot) => slot.startsWith(`${kind}:`));
      expect(found, `no sentence is written for ${kind}`).toBe(true);
    }
  });

  it('writes both sides of the moments that reach two people', () => {
    for (const slot of ['engagement.reassigned', 'dispute.raised', 'dispute.resolved']) {
      expect(NOTIFICATION_SLOTS).toContain(`${slot}:node`);
      expect(NOTIFICATION_SLOTS).toContain(`${slot}:owner`);
    }
  });
});

describe('AGENTS.md rule 22, checked rather than reviewed', () => {
  it('uses no em dash in any title or body', () => {
    for (const slot of NOTIFICATION_SLOTS) {
      const { title, body } = composeNotification(rowFor(slot), NOW);
      expect(title, `em dash in the title of ${slot}`).not.toContain('—');
      expect(body, `em dash in the body of ${slot}`).not.toContain('—');
    }
  });

  /**
   * The kyc branch reads five states from one payload key, so the walk above
   * only ever sees one of them. Each is composed here so none can carry a dash
   * or an empty sentence unseen.
   */
  it('uses no em dash in any verification outcome', () => {
    for (const to of ['verified', 'rejected', 'pending', 'suspended', 'unverified']) {
      const row = rowFor('node.kyc_status_changed:node');
      const { title, body } = composeNotification({ ...row, payload: { ...row.payload, to } }, NOW);
      expect(title).not.toContain('—');
      expect(body).not.toContain('—');
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it('says every resolution without a dash', () => {
    for (const resolution of [
      'released',
      'refunded',
      'partial',
      'reassigned',
      'rejection_upheld',
      'something_new',
    ]) {
      for (const role of ['node', 'owner'] as const) {
        const row = rowFor(`dispute.resolved:${role}`);
        const { body } = composeNotification(
          { ...row, payload: { ...row.payload, resolution } },
          NOW,
        );
        expect(body).not.toContain('—');
        expect(body.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never renders an empty sentence', () => {
    for (const slot of NOTIFICATION_SLOTS) {
      const { title, body } = composeNotification(rowFor(slot), NOW);
      expect(title.trim().length, `empty title for ${slot}`).toBeGreaterThan(0);
      expect(body.trim().length, `empty body for ${slot}`).toBeGreaterThan(0);
    }
  });
});

describe('where a click goes', () => {
  it('sends a node to their own surface and an owner to the room', () => {
    for (const slot of NOTIFICATION_SLOTS) {
      const row = rowFor(slot);
      const { href } = composeNotification(row, NOW);
      if (row.recipientRole === 'node') expect(href).toBe('/node');
      else expect(href).toBe('/app?room=66666666-6666-4666-8666-666666666666');
    }
  });

  it('falls back to the shell when the trigger found no room', () => {
    const row = rowFor('offer.accepted:owner');
    expect(hrefFor({ ...row, payload: { ...row.payload, room_id: null } })).toBe('/app');
  });
});

describe('what is waiting on the reader', () => {
  /**
   * The predicate is "nothing moves until they do". A dispute matters more than
   * most things here and is deliberately not on the list, because an operator
   * decides it and the reader has no button.
   */
  it('is true for exactly the five slots where the reader is the blocker', () => {
    const needing = NOTIFICATION_SLOTS.filter(
      (slot) => composeNotification(rowFor(slot), NOW).needsAction,
    ).sort();
    expect(needing).toEqual(
      [
        'offer.created:node',
        'proof.bounced:node',
        'proof.submitted:owner',
        'task.transitioned:owner',
        'work.rejected:node',
      ].sort(),
    );
  });

  it('does not ask for action on a dispute either party raised', () => {
    expect(composeNotification(rowFor('dispute.raised:node'), NOW).needsAction).toBe(false);
    expect(composeNotification(rowFor('dispute.raised:owner'), NOW).needsAction).toBe(false);
    expect(composeNotification(rowFor('dispute.resolved:node'), NOW).needsAction).toBe(false);
  });
});

describe('a payload the trigger could not enrich', () => {
  it('says "a step" rather than leaving a hole', () => {
    const row = rowFor('proof.submitted:owner');
    const { body } = composeNotification({ ...row, payload: { room_id: null } }, NOW);
    expect(body).toContain('a step');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
  });

  it('drops the money clause rather than printing a blank amount', () => {
    const row = rowFor('offer.accepted:owner');
    const { body } = composeNotification({ ...row, payload: { task_title: 'A step' } }, NOW);
    expect(body).not.toContain('escrow');
    expect(body).not.toContain('NaN');
  });

  it('renders a kind it has no sentence for without throwing', () => {
    const row = rowFor('offer.created:node');
    const composed = composeNotification({
      ...row,
      kind: 'offer.created',
      recipientRole: 'owner',
    });
    expect(composed.title.length).toBeGreaterThan(0);
    expect(composed.needsAction).toBe(false);
  });
});

describe('money', () => {
  it('formats with its currency', () => {
    expect(money(400, 'USD')).toBe('$400.00');
  });

  it('accepts the string a jsonb number arrives as', () => {
    expect(money('150.5', 'USD')).toBe('$150.50');
  });

  it('is null when there is no amount, so the clause can be dropped', () => {
    expect(money(null, 'USD')).toBeNull();
    expect(money(undefined, 'USD')).toBeNull();
    expect(money('', 'USD')).toBeNull();
  });

  it('still prints the number when the currency code is unusable', () => {
    expect(money(400, null)).toBe('400.00');
    expect(money(400, 'NOTACODE')).toBe('400.00');
  });
});

describe('until', () => {
  it('counts in hours inside a day and in days beyond one', () => {
    expect(until('2026-09-09T15:00:00.000Z', NOW)).toBe('within 3 hours');
    expect(until('2026-09-11T12:00:00.000Z', NOW)).toBe('within 2 days');
  });

  it('says a deadline that has passed has passed', () => {
    expect(until('2026-09-08T12:00:00.000Z', NOW)).toBe('now');
  });

  it('is null for a missing or unparseable time', () => {
    expect(until(null, NOW)).toBeNull();
    expect(until('soon', NOW)).toBeNull();
  });
});
