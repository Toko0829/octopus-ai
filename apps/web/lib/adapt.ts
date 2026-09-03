import { AgentPersona } from '@octopus/contracts';
import type { Channel, Message, Room, RoomMember } from '@octopus/contracts';
import type { Presence, Role, UiBusiness, UiChannel, UiMember, UiMessage } from './types';

/** Wire shape -> presentation shape. Kept in one place so no component invents its own. */

/**
 * Per-business accent (the "chromatophore" idea in design-system.md). Picked
 * deterministically from the room id so a business keeps its colour across
 * sessions and devices without needing a stored preference.
 */
const ACCENTS = ['var(--teal-500)', 'var(--coral-500)', 'var(--role-pro)'] as const;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '··';
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? '';
  const second = parts[1]?.[0] ?? '';
  return (first + second).toUpperCase();
}

export function toBusiness(room: Room): UiBusiness {
  const name = room.name || 'Untitled';
  return {
    id: room.id,
    name,
    mark: (name[0] ?? '?').toUpperCase(),
    accent: ACCENTS[hash(room.id) % ACCENTS.length] as string,
  };
}

export function toChannel(c: Channel): UiChannel {
  return { id: c.id, name: c.name, section: c.section, kind: c.kind };
}

/**
 * A member's visual role. `viewerId` is what makes "you" resolvable; without it
 * the viewer would render as just another member.
 */
export function toMember(
  m: RoomMember,
  viewerId: string,
  presence: Presence = 'offline',
): UiMember {
  const name = m.displayName?.trim() || 'Unnamed member';
  let role: Role;
  if (m.userId === viewerId) role = 'you';
  else if (m.role === 'human_node') role = 'node';
  else if (m.role === 'verified_pro') role = 'pro';
  else if (m.role === 'admin' || m.role === 'ops') role = 'admin';
  else role = 'member';

  return { id: m.userId, name, role, presence, initials: initialsOf(name), expiresAt: m.expiresAt };
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A Realtime broadcast payload carries the raw Postgres row (snake_case), not the
 * API's camelCase shape, so it needs its own mapping. Returns null for anything
 * unrecognisable rather than rendering a half-built message.
 */
export function fromBroadcastRecord(record: unknown): UiMessage | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string') return null;

  const kind = r.author_kind;
  return {
    id: r.id,
    authorId: typeof r.author_id === 'string' ? r.author_id : null,
    authorKind:
      kind === 'agent' || kind === 'node' || kind === 'system' || kind === 'user' ? kind : 'user',
    // Parsed rather than cast. The broadcast is the one path into this client
    // that no route validated, so a persona the client does not know becomes
    // null and renders under the legacy name, instead of indexing a registry
    // with a string nobody checked.
    persona: AgentPersona.safeParse(r.persona).data ?? null,
    body: typeof r.body === 'string' ? r.body : '',
    seq: r.seq === null || r.seq === undefined ? null : Number(r.seq),
    ts: typeof r.created_at === 'string' ? formatTime(r.created_at) : '',
    // The broadcast trigger sends the whole NEW row, so `thread_id` has been
    // travelling on every payload since `20260901121000` with nobody reading it.
    threadId: typeof r.thread_id === 'string' ? r.thread_id : null,
  };
}

export function toMessage(m: Message): UiMessage {
  return {
    id: m.id,
    authorId: m.authorId,
    authorKind: m.authorKind,
    persona: m.persona,
    body: m.body ?? '',
    seq: m.seq,
    ts: formatTime(m.createdAt),
    threadId: m.threadId,
    embed: m.embed ?? null,
  };
}

/**
 * Merge server messages into the local list, de-duplicating by id.
 *
 * Both the POST response and the Realtime broadcast deliver the same row, and a
 * reconnect replays history, so "insert if new" has to be the rule. An optimistic
 * message is matched on its client id and replaced wholesale by the server copy,
 * which is what gives it a real `seq` to sort by.
 */
export function mergeMessages(current: UiMessage[], incoming: UiMessage[]): UiMessage[] {
  const byId = new Map(current.map((m) => [m.id, m] as const));
  for (const m of incoming) {
    // A Realtime broadcast carries the `messages` row only, so its copy of a
    // message always has `embed: null` even when a card exists. Letting it
    // overwrite a version that already has one would make a rendered plan card
    // vanish on the next broadcast. Absence of an embed here means "not
    // included", never "there is none".
    const existing = byId.get(m.id);
    byId.set(m.id, existing?.embed && !m.embed ? { ...m, embed: existing.embed } : m);
  }

  // A plan that replaces another names it, and the old card was moved to
  // `expired` server-side. Nothing broadcasts that change, so the old card on
  // screen would keep offering its buttons until a reload; the reference on the
  // new card is what lets it be marked here, on every path a card arrives by.
  const superseded = new Set<string>();
  for (const m of byId.values()) {
    if (m.embed?.component === 'plan' && m.embed.payload.supersedes) {
      superseded.add(m.embed.payload.supersedes);
    }
  }
  if (superseded.size > 0) {
    for (const [id, m] of byId) {
      if (m.embed && superseded.has(m.embed.id) && m.embed.state === 'pending') {
        byId.set(id, { ...m, embed: { ...m.embed, state: 'expired' } });
      }
    }
  }

  return [...byId.values()].sort((a, b) => {
    // Unconfirmed sends have no seq and belong at the end, in arrival order.
    if (a.seq === null && b.seq === null) return 0;
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return a.seq - b.seq;
  });
}
