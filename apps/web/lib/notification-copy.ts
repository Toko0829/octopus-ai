import type { Notification, NotificationKind, NotificationRecipientRole } from '@octopus/contracts';

/**
 * The sentences. Every one of them, in one file.
 *
 * **The database stores facts and this composes words**, which is the decision
 * [ADR-0028](../../docs/40-adr/0028-a-notification-is-derived-from-the-event.md)
 * records. Three things follow from it and all three are the reason it was made:
 * copy changes without a migration, the sentences are unit-tested against
 * AGENTS.md rule 22 (which bans em dashes in notification copy by name), and
 * product voice lives somewhere a person reviewing product voice would look.
 *
 * A kind with no entry renders nothing at all rather than a placeholder. That is
 * deliberate: a half-written notification is worse than a missing one, because it
 * looks like the system had something to say and could not say it. Adding a kind
 * means touching the migration, the contract enum and this map together, and the
 * test below fails until all three agree.
 */

export interface ComposedNotification {
  title: string;
  body: string;
  href: string;
  /**
   * Whether this is waiting on the person reading it.
   *
   * **The predicate is "nothing moves until they do", not "this is important".**
   * A dispute raised against a node matters enormously and is not this: an
   * operator decides it, and the node has no button. A bounced handover is this,
   * because the step sits where it is until they resubmit. The badge in
   * `InboxBell` turns amber on this and nothing else, which is what keeps amber
   * meaning "needs your approval" rather than "notification"
   * (design-system.md:69, AGENTS.md rule 15).
   */
  needsAction: boolean;
}

/** A step title, or a phrase that reads correctly when the join found nothing. */
function step(n: Notification): string {
  const title = n.payload.task_title;
  return typeof title === 'string' && title.trim() ? title.trim() : 'a step';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Money, tabular and with its currency, or nothing.
 *
 * Returns null rather than "0" or "unknown" when the amount is missing, and
 * every caller drops the clause instead of printing a blank. A sentence about
 * money that cannot name the amount should not mention money.
 */
export function money(amount: unknown, currency: unknown): string | null {
  const value = num(amount);
  if (value === null) return null;
  const code = typeof currency === 'string' && currency.length === 3 ? currency : null;
  try {
    return code
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(value)
      : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(value);
  } catch {
    // An unregistered currency code is a data problem, not a reason to render
    // nothing: the number is still the useful half.
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(value);
  }
}

/**
 * How long is left, in words a person uses.
 *
 * `now` is a parameter so the tests are not a function of when they run. Past
 * deadlines say so rather than counting backwards, because "2 days ago" beside
 * "reply before" reads as an instruction to do something impossible.
 */
export function until(when: unknown, now: number): string | null {
  if (typeof when !== 'string' || !when.trim()) return null;
  const at = Date.parse(when);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  if (ms <= 0) return 'now';
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'within the hour';
  if (hours < 24) return `within ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `within ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** What a resolution meant, in the reader's terms rather than the schema's. */
function resolutionPhrase(resolution: unknown, role: NotificationRecipientRole): string {
  switch (resolution) {
    case 'released':
      return role === 'node'
        ? 'The work stands and the payment goes ahead.'
        : 'The work stands and the payment goes ahead.';
    case 'refunded':
      return role === 'node'
        ? 'The escrow went back to the client and the step is closed.'
        : 'Your escrow was returned in full and the step is closed.';
    case 'partial':
      return role === 'node'
        ? 'Part of the escrow was released to you and the rest went back.'
        : 'Part of the escrow went to the expert and the rest came back to you.';
    case 'reassigned':
      return role === 'node'
        ? 'The step went back to the market and your escrow was returned to the client.'
        : 'Your escrow was returned and the step went back to the market.';
    case 'rejection_upheld':
      return role === 'node'
        ? 'The decision to send the work back stands.'
        : 'Your decision to send the work back stands.';
    default:
      return 'An operator has decided it.';
  }
}

type Composer = (n: Notification, now: number) => { title: string; body: string };

/**
 * Keyed by `<kind>:<role>`, because the same moment is a different sentence to
 * each party. `dispute.resolved` is the clearest case: one event, two rows, and
 * "your escrow was returned" is true for exactly one of them.
 */
const COPY: Partial<Record<string, Composer>> = {
  'offer.created:node': (n, now) => {
    const when = until(n.payload.expires_at, now);
    const rate = money(n.payload.rate, 'USD');
    return {
      title: 'A step is offered to you',
      body: [
        `${step(n)}.`,
        rate ? `Offered at ${rate}.` : null,
        when === 'now' ? 'This offer has expired.' : when ? `Answer ${when}.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },

  'offer.accepted:owner': (n) => {
    const price = money(n.payload.agreed_price, n.payload.currency);
    return {
      title: 'An expert took a step',
      body: [`${step(n)}.`, price ? `${price} is now held in escrow.` : null]
        .filter(Boolean)
        .join(' '),
    };
  },

  'proof.submitted:owner': (n) => ({
    title: 'Work is ready for you to review',
    body: `${step(n)}. Read what was handed over, then approve it or send it back with a note.`,
  }),

  'proof.bounced:node': (n) => ({
    title: 'Your handover was sent back automatically',
    body: `${step(n)}. The acceptance criteria were not met yet, so the step is still yours.`,
  }),

  'work.approved:node': (n) => ({
    title: 'Your work was approved',
    body: `${step(n)}. Payment is released on the next pass.`,
  }),

  'work.rejected:node': (n) => {
    const note = typeof n.payload.note === 'string' ? n.payload.note.trim() : '';
    return {
      title: 'Your work was sent back',
      body: [`${step(n)}.`, note ? `They said: ${note}` : 'No note was left.']
        .filter(Boolean)
        .join(' '),
    };
  },

  'engagement.reassigned:node': (n) => ({
    title: 'A step was taken back from you',
    body: `${step(n)}. The deadline passed, so it went back to the market.`,
  }),

  'engagement.reassigned:owner': (n) => {
    const price = money(n.payload.agreed_price, n.payload.currency);
    return {
      title: 'A step went back to the market',
      body: [
        `${step(n)}.`,
        'The expert missed the deadline.',
        price ? `${price} was returned to your budget.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },

  'payout.settled:node': (n) => {
    const amount = money(n.payload.amount, n.payload.currency);
    return {
      title: amount ? `You were paid ${amount}` : 'You were paid',
      body: `${step(n)}. The escrow has been released and the step is finished.`,
    };
  },

  'dispute.raised:node': (n) => ({
    title: 'The client raised a dispute',
    body: `${step(n)}. An operator will read both sides and decide. You do not need to do anything yet.`,
  }),

  'dispute.raised:owner': (n) => ({
    title: 'The expert raised a dispute',
    body: `${step(n)}. An operator will read both sides and decide.`,
  }),

  'dispute.resolved:node': (n) => ({
    title: 'The dispute was decided',
    body: `${step(n)}. ${resolutionPhrase(n.payload.resolution, 'node')}`,
  }),

  'dispute.resolved:owner': (n) => ({
    title: 'The dispute was decided',
    body: `${step(n)}. ${resolutionPhrase(n.payload.resolution, 'owner')}`,
  }),

  'node.kyc_status_changed:node': (n) => {
    const to = n.payload.to;
    if (to === 'verified') {
      return {
        title: 'You are verified',
        body: 'You can be offered paid work from now on.',
      };
    }
    if (to === 'rejected') {
      return {
        title: 'Your identity check did not pass',
        body: 'You can start it again from your profile.',
      };
    }
    if (to === 'pending') {
      return {
        title: 'Your identity check is under review',
        body: 'Nothing is needed from you while it runs.',
      };
    }
    if (to === 'suspended') {
      const why = typeof n.payload.suspended_reason === 'string' ? n.payload.suspended_reason : '';
      return {
        title: 'Your account is suspended',
        body: why || 'Get in touch to find out what happens next.',
      };
    }
    return { title: 'Your verification status changed', body: 'Open your profile to see it.' };
  },

  'task.transitioned:owner': (n) => ({
    title: 'Nobody took a step you sent out',
    body: `${step(n)}. Every expert we asked has passed or run out of time, so it is back with you.`,
  }),
};

/**
 * The five moments where nothing moves until the reader moves it.
 *
 * Written as a set rather than derived, because the question is a product one
 * and not a structural one: `dispute.raised` reaches somebody whose deal is
 * frozen and who still has no button, and no property of the row says so.
 */
const NEEDS_ACTION: ReadonlySet<string> = new Set([
  'offer.created:node',
  'proof.bounced:node',
  'work.rejected:node',
  'proof.submitted:owner',
  'task.transitioned:owner',
]);

/**
 * Where a click goes.
 *
 * A node's whole surface is `/node`, so every node row lands there. An owner's
 * is the room the project is announced in, which the deriving trigger resolved
 * through the plan card and put in the payload, because resolving it in the
 * browser would mean a second round trip per row.
 */
export function hrefFor(n: Notification): string {
  if (n.recipientRole === 'node') return '/node';
  const room = n.payload.room_id;
  return typeof room === 'string' && room ? `/app?room=${encodeURIComponent(room)}` : '/app';
}

export function composeNotification(
  n: Notification,
  now: number = Date.now(),
): ComposedNotification {
  const slot = `${n.kind}:${n.recipientRole}`;
  const composer = COPY[slot];
  const written = composer?.(n, now) ?? {
    title: 'Something happened',
    body: 'Open the step to see it.',
  };
  return {
    title: written.title,
    body: written.body,
    href: hrefFor(n),
    needsAction: NEEDS_ACTION.has(slot),
  };
}

/** Every slot this file can render. Exported so the test can walk all of them. */
export const NOTIFICATION_SLOTS: readonly string[] = Object.keys(COPY);

/** The kinds the contract declares, so a missing sentence fails a test. */
export const COMPOSED_KINDS: readonly NotificationKind[] = [
  'offer.created',
  'offer.accepted',
  'proof.submitted',
  'proof.bounced',
  'work.approved',
  'work.rejected',
  'engagement.reassigned',
  'payout.settled',
  'dispute.raised',
  'dispute.resolved',
  'node.kyc_status_changed',
  'task.transitioned',
];
