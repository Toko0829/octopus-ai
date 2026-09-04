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

/**
 * One of the four agent voices, as the members panel renders it.
 *
 * **A separate type from `UiMember` on purpose.** A persona holds no
 * `room_members` row, has no user id, is never offline and never expires, so
 * widening `UiMember` would add fields that are meaningless for every person in
 * the list and force four literals elsewhere to carry them. The two lists sit
 * beside each other in the panel and neither pretends to be the other.
 */
export interface UiPersona {
  id: AgentPersona;
  name: string;
  initials: string;
  /** One line, for the panel and later for the composer's mention list. */
  summary: string;
  /** A step this voice owns is in the executor's hands right now. */
  working: boolean;
  /** What it is doing, in words, or null when it is not doing anything. */
  activity: string | null;
  /**
   * The model this voice's proposals are composed on, in words.
   *
   * Always a string, never null: a room that has routed nothing still runs on
   * something, and the honest answer there is the house default rather than a
   * blank. When even that is unknown (the AI service did not answer `/health`)
   * the phrase says a default exists without naming one, because naming one
   * would be inventing the fact this line reports.
   *
   * A voice can be busy on a model the owner did not choose. That is not a
   * contradiction: a route is a preference read when a proposal is composed, and
   * a run already in flight keeps the model it started on.
   */
  runsOn: string;
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
  /**
   * Which model wrote this, as the vendor's own id.
   *
   * Null for everything a person or a node said, for a system line, for every
   * agent message this side composed in TypeScript, and for every agent message
   * written before `20260913122000`. **Not an enum**: the id is rendered through
   * `labelForModel`, which returns an unrecognised id unchanged, because a build
   * shipped before a model existed should say the model's name rather than
   * nothing.
   */
  model: string | null;
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
