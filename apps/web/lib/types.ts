import type {
  ActionEmbed,
  AgentPersona,
  AuthorKind,
  Channel,
  Message,
  Room,
  RoomMember,
} from '@octopus/contracts';

/**
 * UI types for the chat shell. Wire shapes come from @octopus/contracts; these are
 * the *presentation* shapes the components render, produced by lib/adapt.ts.
 *
 * Anything not backed by the API is deliberately absent. There is no budget
 * or unread count here yet, because nothing produces them (the planner and the
 * agent land in Phase 2 — see docs/10-architecture/roadmap.md).
 */

/** Visual role. `member` is another ordinary person in the room; `you` is the viewer. */
export type Role = 'you' | 'member' | 'agent' | 'node' | 'pro' | 'admin';

/** Derived from Realtime Presence. `offline` means "not currently subscribed". */
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export interface UiMember {
  id: string;
  name: string;
  role: Role;
  presence: Presence;
  initials: string;
  /** Time-boxed node access, surfaced so scope is visible rather than implicit. */
  expiresAt: string | null;
}

export interface UiChannel {
  id: string;
  name: string;
  section: string;
  kind: 'text' | 'topic';
}

/** A room, rendered as an entry in the guild rail. */
export interface UiBusiness {
  id: string;
  name: string;
  mark: string;
  accent: string;
}

export interface UiMessage {
  id: string;
  authorId: string | null;
  authorKind: AuthorKind;
  /**
   * Which of the four agent voices wrote this.
   *
   * Null for everything a person or a node said, for a system line, and for
   * every agent message written before `20260912120000`. The stream renders
   * that last group under the single legacy name rather than guessing which
   * specialist it would have been.
   */
  persona: AgentPersona | null;
  body: string;
  /** Ordering cursor from Postgres. Null only for a not-yet-confirmed local send. */
  seq: number | null;
  ts: string;
  /** True between optimistic render and server confirmation. */
  pending?: boolean;
  /** Set when a send failed, so the UI can show it rather than dropping the text. */
  failed?: boolean;
  /**
   * The thread this message belongs to, or null for the room stream.
   *
   * The owner's stream interleaves both since slice 5, because a node admitted
   * to a task thread posts into the same room. Marked rather than filtered: the
   * owner may read these rows and hiding them would be the fetched-never-rendered
   * defect this repository has recorded twice.
   */
  threadId?: string | null;
  /**
   * The interactive card attached to this message, when there is one.
   *
   * Null for a message that arrived over Realtime: the broadcast carries the
   * `messages` row only, and the embed lives in another table the trigger does
   * not see. The card therefore appears on the next fetch rather than instantly,
   * which is a visible delay but never a wrong render.
   */
  embed?: ActionEmbed | null;
}

export type { ActionEmbed, AgentPersona, Channel, Message, Room, RoomMember };
