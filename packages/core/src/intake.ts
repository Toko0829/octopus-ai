/**
 * What a question card means, decided without IO.
 *
 * A question card used to decide what the room's next chat message MEANT: an
 * answer to it, or a fresh goal. That decision lived here as `decideIntakeTurn`,
 * and it was the mechanism by which an open card claimed every message the owner
 * wrote for two hours. Answers now arrive on the card itself, one slot at a time
 * through the embed action route, so a chat message is always a goal and the
 * decisions that remain are smaller: what a card still needs, whether a new goal
 * should close it, what a finished card says to a running plan, and what a
 * workspace already knows before the first question is asked.
 *
 * Pure, so `apps/api` fetches and writes while what any of it means is checkable
 * without a database.
 */

import {
  BUDGET_BAND_LABELS,
  REQUIRED_INTAKE_SLOTS,
  TIMELINE_LABELS,
  type BudgetBand,
  type IntakeSlot,
  type IntakeSlotKey,
  type QuestionEmbedPayload,
  type Timeline,
} from '@octopus/contracts';

/**
 * Write one stated answer into a card's slots, replacing whatever was there for
 * that key.
 *
 * The database does this too, in `answer_question_slot`, and that copy is the
 * one that runs. This one exists so a client can render the card as it will be
 * before the round trip returns, and so the rule "a person's answer replaces a
 * model's inference and an earlier answer alike" is stated once in code a test
 * can read.
 */
export function applyAnswer(
  payload: QuestionEmbedPayload,
  slot: IntakeSlotKey,
  value: string,
): QuestionEmbedPayload {
  const trimmed = value.trim();
  const kept = payload.slots.filter((s) => s.key !== slot);
  const stated: IntakeSlot = { key: slot, value: trimmed, source: 'stated' };
  return { ...payload, slots: [...kept, stated] };
}

/**
 * The required slots a card is still missing.
 *
 * Only the slots the card actually asked about count as missing. Intake asks
 * for what it needs and nothing else, so a card that asked two questions is
 * finished when those two are answered, even though four slots are required for
 * a whole-funnel request: the other two were already known. `timeline` is never
 * required and is never returned here.
 *
 * A filled slot is filled whatever its source. A model's inference counts, on
 * the same reasoning `completeness` in `intake.py` uses: the card exists to fill
 * gaps, and a slot the model already filled is not a gap. The person can still
 * correct it, which is why the card renders an inferred value as a guess.
 */
export function remainingRequiredSlots(payload: QuestionEmbedPayload): IntakeSlotKey[] {
  const asked = new Set(payload.questions.map((q) => q.slot));
  const filled = new Set(payload.slots.map((s) => s.key));
  return REQUIRED_INTAKE_SLOTS.filter((key) => asked.has(key) && !filled.has(key));
}

/**
 * Whether a new goal from the owner should close this card.
 *
 * An intake card is about the goal that produced it, so a new goal makes it
 * moot: the questions it asked were sharpening a plan the person has now moved
 * on from. A task-answers card is different. It belongs to a plan that already
 * exists and is still running, and the steps it names still need answers
 * whatever the person types next, so it stays open.
 *
 * A card waiting for a goal is a leftover of the chat-answer path and is closed
 * too, because nothing can ever answer it now.
 */
export function dismissableQuestion(payload: QuestionEmbedPayload): boolean {
  return payload.awaiting !== 'task_answers';
}

/** What each slot is called in a sentence. */
const SLOT_WORDS: Record<IntakeSlotKey, string> = {
  icp: 'the audience is',
  offer: 'the offer is',
  target_metric: 'the target is',
  budget_band: 'the budget is',
  timeline: 'the timeline is',
};

/** A stored chip value in its own words; anything else as itself. */
function slotValue(slot: IntakeSlot): string {
  if (slot.key === 'budget_band' && slot.value in BUDGET_BAND_LABELS) {
    return BUDGET_BAND_LABELS[slot.value as BudgetBand].toLowerCase();
  }
  if (slot.key === 'timeline' && slot.value in TIMELINE_LABELS) {
    return TIMELINE_LABELS[slot.value as Timeline].toLowerCase();
  }
  return slot.value.trim().replace(/\s+/g, ' ');
}

/**
 * The reason field's limit, mirroring `ReplanRequest.reason` in
 * `services/ai/src/octopus_ai/schemas.py`. Exported because `mentionReason`
 * builds the same field from different words and must cap it the same way; two
 * numbers here would be two limits that can disagree, and the one that loses is
 * a 422 from the reasoning core in the middle of somebody's request.
 */
export const REPLAN_REASON_MAX = 1000;

/**
 * The reason a finished question card gives to the replan path.
 *
 * When the plan was approved before the card was finished, the card's answers
 * reach the project as a replan diff, and a diff needs a reason in words the
 * owner would recognise on the card. Templated rather than generated, for the
 * reason every sentence on a trust surface is: brand voice is a rule (no em
 * dashes, rule 22) and a generated one is one prompt drift away from breaking
 * it. Only stated slots are named, because a model's inference is not something
 * the owner added, and the whole thing stays inside the replan body's limit.
 */
export function replanReason(slots: IntakeSlot[]): string {
  const stated = slots.filter((s) => s.source === 'stated');
  const parts = stated.map((s) => `${SLOT_WORDS[s.key]} ${slotValue(s)}`);
  const head = 'The owner answered the questions beside the plan:';
  const tail = 'Adjust the steps to fit what they said.';
  let body = parts.join('; ');
  const room = REPLAN_REASON_MAX - head.length - tail.length - 3;
  if (body.length > room) body = `${body.slice(0, room - 3).trimEnd()}...`;
  return parts.length === 0 ? `${head} nothing new. ${tail}` : `${head} ${body}. ${tail}`;
}

/** The fields a workspace profile holds, as the database names them. */
export interface RoomProfileFields {
  icp?: string | null;
  offer?: string | null;
  budget_band?: string | null;
  timeline?: string | null;
}

/**
 * What a workspace already knows, as stated slots for intake's first round.
 *
 * Stated rather than inferred, because the owner typed or confirmed each one.
 * Empty fields are skipped rather than passed as empty strings, which the slot
 * contract refuses, and `target_metric` is never produced because a profile
 * never holds one: it belongs to a goal.
 */
export function profileSlots(profile: RoomProfileFields | null | undefined): IntakeSlot[] {
  if (!profile) return [];
  const out: IntakeSlot[] = [];
  const push = (key: IntakeSlotKey, value: string | null | undefined) => {
    const trimmed = value?.trim() ?? '';
    if (trimmed) out.push({ key, value: trimmed.slice(0, 400), source: 'stated' });
  };
  push('icp', profile.icp);
  push('offer', profile.offer);
  push('budget_band', profile.budget_band);
  push('timeline', profile.timeline);
  return out;
}
