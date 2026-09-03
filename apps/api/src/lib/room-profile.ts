import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BudgetBand,
  Timeline,
  type IntakeSlot,
  type PutRoomProfileBody,
  type RoomProfile,
} from '@octopus/contracts';
import type { RoomProfileFields } from '@octopus/core';

/**
 * What a workspace knows about its own business, read and written as facts.
 *
 * Three writers and one rule. The panel writes what the owner typed, the
 * question card writes what the owner answered, and the agent run writes what
 * intake finished with. All three go through `writeProfileFields`, which writes
 * **only the keys it is given**: an upsert of a whole row would let an intake
 * that established a budget band erase an audience the owner typed on the
 * panel a minute earlier.
 *
 * **The chip slots are canonical or nothing.** The panel and the card store
 * `budget_band` and `timeline` as members of the contract's enums, so the panel
 * can select a chip from what is stored. Intake's model returns free text for
 * the same slots ("2000 a month"), which is a fine value for a plan and a
 * useless one for a chip group, so from intake those two are persisted only
 * when they happen to be canonical. The audience and the offer are text on
 * every path.
 */

export const BUSINESS_SLOT_KEYS = ['icp', 'offer', 'budget_band', 'timeline'] as const;

export interface RoomProfileRow {
  room_id: string;
  icp: string | null;
  offer: string | null;
  budget_band: string | null;
  timeline: string | null;
  updated_at: string | null;
}

export async function readProfile(
  admin: SupabaseClient,
  roomId: string,
): Promise<RoomProfileRow | null> {
  const { data, error } = await admin
    .from('room_profiles')
    .select('room_id, icp, offer, budget_band, timeline, updated_at')
    .eq('room_id', roomId)
    .maybeSingle();
  if (error) throw error;
  return (data as RoomProfileRow | null) ?? null;
}

/** The wire shape. Non-canonical chip values are shown as nothing rather than as a chip nobody can select. */
export function toRoomProfile(row: RoomProfileRow | null, roomId: string): RoomProfile {
  const band = BudgetBand.safeParse(row?.budget_band);
  const timeline = Timeline.safeParse(row?.timeline);
  return {
    roomId,
    icp: row?.icp ?? null,
    offer: row?.offer ?? null,
    budgetBand: band.success ? band.data : null,
    timeline: timeline.success ? timeline.data : null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * The fields intake's stated slots may persist. Inferred slots never reach
 * the profile: a guess about somebody's business must not become a fact they
 * are later shown as their own.
 */
export function profileFieldsFromSlots(slots: IntakeSlot[]): RoomProfileFields {
  const fields: RoomProfileFields = {};
  for (const slot of slots) {
    if (slot.source !== 'stated') continue;
    const value = slot.value.trim();
    if (!value) continue;
    if (slot.key === 'icp') fields.icp = value.slice(0, 400);
    else if (slot.key === 'offer') fields.offer = value.slice(0, 400);
    else if (slot.key === 'budget_band' && BudgetBand.safeParse(value).success) {
      fields.budget_band = value;
    } else if (slot.key === 'timeline' && Timeline.safeParse(value).success) {
      fields.timeline = value;
    }
  }
  return fields;
}

/** The panel's body, in the database's names. Absent keys stay absent. */
export function profileFieldsFromBody(body: PutRoomProfileBody): RoomProfileFields {
  const fields: RoomProfileFields = {};
  if (body.icp !== undefined) fields.icp = body.icp;
  if (body.offer !== undefined) fields.offer = body.offer;
  if (body.budgetBand !== undefined) fields.budget_band = body.budgetBand;
  if (body.timeline !== undefined) fields.timeline = body.timeline;
  return fields;
}

/**
 * Write the given fields and nothing else. An upsert sends only the columns it
 * is handed, so on conflict the others are untouched; on a first write they
 * take the table's defaults, which is null.
 */
export async function writeProfileFields(
  admin: SupabaseClient,
  roomId: string,
  fields: RoomProfileFields,
  updatedBy: string | null,
): Promise<RoomProfileRow | null> {
  if (Object.keys(fields).length === 0) return readProfile(admin, roomId);
  const { data, error } = await admin
    .from('room_profiles')
    .upsert(
      {
        room_id: roomId,
        ...fields,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy,
      },
      { onConflict: 'room_id' },
    )
    .select('room_id, icp, offer, budget_band, timeline, updated_at')
    .maybeSingle();
  if (error) throw error;
  return (data as RoomProfileRow | null) ?? null;
}
