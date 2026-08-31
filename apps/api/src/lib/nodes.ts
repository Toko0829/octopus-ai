import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NodeCredential, NodeProfile, NodeSkill } from '@octopus/contracts';
import { carriesRealPii, type VerificationCheck } from '@octopus/marketplace';

/**
 * The IO half of a node's own record.
 *
 * **The posture here is the opposite of `connections.ts` on the read side and
 * the same on the write side**, and both halves are deliberate.
 *
 * Reads go through a **user client**, because the three tables carry
 * `select`-own policies keyed on `auth.uid()` and a grant to `authenticated`.
 * RLS row visibility therefore *is* the authorization: a caller who is not a
 * node sees no rows, and the route turns that into a 404 rather than asking a
 * second question it could get wrong.
 *
 * Writes go through the **service client**, because none of the four tables has
 * an INSERT or UPDATE grant to `authenticated` and
 * `supabase/tests/marketplace_rls.sql:232-241` pins that as a property rather
 * than an omission: "registering as a node is a server decision". So for writes
 * the route is the entire control, exactly as it is for connections, and every
 * write function below takes the subject's id as an argument and constrains on
 * it. A missing `.eq('node_id', userId)` here is a cross-tenant write, which is
 * why every one of them has one and why the tests assert refusals rather than
 * successes.
 *
 * **`node_verifications` is not read anywhere in this file**, and its absence is
 * the security property. The table has no policy and no client grant at all, and
 * refuses `permission denied` to the *subject of the record*
 * (`20260831123000:104-119`), because a face-search result names a third party
 * the node may be a duplicate of and carries scores used to decide against them.
 * Projecting it through a service client would hand back exactly what the grant
 * was withheld to prevent.
 */

/* ------------------------------------------------------------------ reads */

/**
 * Everything a node may see about themselves.
 *
 * `suspended_reason` is deliberately absent. Nothing can write it in this slice
 * (no arc reaches `suspended`), and when something can, the text a moderator
 * records is a moderation note rather than a sentence addressed to the person.
 * Adding it here would be shipping a reader for a column with no writer, which
 * is the defect this whole ordering exists to avoid.
 */
export const NODE_COLUMNS =
  'user_id, kyc_status, availability, trust_score, completed_engagements, ' +
  'service_jurisdictions, languages, rate, rate_period, currency';

export const NodeRow = z.object({
  user_id: z.string(),
  kyc_status: z.string(),
  availability: z.string(),
  // numeric(5,4) and numeric(12,2) arrive as a number or a string depending on
  // the driver's mood, which is the `6fcd0d6` shape: coerce once, here.
  trust_score: z.union([z.number(), z.string()]).nullable(),
  completed_engagements: z.union([z.number(), z.string()]),
  service_jurisdictions: z.array(z.string()).nullable(),
  languages: z.array(z.string()).nullable(),
  rate: z.union([z.number(), z.string()]).nullable(),
  rate_period: z.string().nullable(),
  currency: z.string(),
});
export type NodeRow = z.infer<typeof NodeRow>;

export const SKILL_COLUMNS = 'skill_tag, verified, verified_at';

export const SkillRow = z.object({
  skill_tag: z.string(),
  verified: z.boolean(),
  verified_at: z.string().nullable(),
});
export type SkillRow = z.infer<typeof SkillRow>;

/**
 * `evidence_path` is absent, and that is a projection control rather than an
 * oversight. Nothing writes it in this slice, and when something does it will
 * hold a storage key for a stranger's identity document. The same reasoning
 * `SELECTED_COLUMNS` carries in `connections.ts`: name the list once so "does
 * this leak" is a question about a constant.
 */
export const CREDENTIAL_COLUMNS =
  'id, kind, jurisdiction, issuer, licence_number, verified, revoked_at';

export const CredentialRow = z.object({
  id: z.string(),
  kind: z.string(),
  jurisdiction: z.string(),
  issuer: z.string().nullable(),
  licence_number: z.string().nullable(),
  verified: z.boolean(),
  revoked_at: z.string().nullable(),
});
export type CredentialRow = z.infer<typeof CredentialRow>;

function toSkill(row: SkillRow): NodeSkill {
  return { tag: row.skill_tag, verified: row.verified, verifiedAt: row.verified_at };
}

function toCredential(row: CredentialRow): NodeCredential {
  return {
    id: row.id,
    kind: row.kind as NodeCredential['kind'],
    jurisdiction: row.jurisdiction,
    issuer: row.issuer,
    licenceNumber: row.licence_number,
    verified: row.verified,
    revokedAt: row.revoked_at,
  };
}

function toProfile(row: NodeRow, skills: NodeSkill[], credentials: NodeCredential[]): NodeProfile {
  return {
    userId: row.user_id,
    kycStatus: row.kyc_status as NodeProfile['kycStatus'],
    availability: row.availability as NodeProfile['availability'],
    trustScore: row.trust_score === null ? null : Number(row.trust_score),
    completedEngagements: Number(row.completed_engagements),
    serviceJurisdictions: row.service_jurisdictions ?? [],
    languages: row.languages ?? [],
    rate: row.rate === null ? null : Number(row.rate),
    ratePeriod: row.rate_period as NodeProfile['ratePeriod'],
    currency: row.currency,
    skills,
    credentials,
  };
}

/**
 * A node's whole record, read **as the caller**.
 *
 * Three queries rather than one embedded select, because RLS applies per table
 * and three plain reads make that obvious to somebody auditing this file. The
 * volume is one person's own rows.
 *
 * Returns null when the caller is not a node, which is what a non-node and a
 * stranger both see: the select-own policy answers zero rows either way, so this
 * function never has to distinguish "no such node" from "not your node".
 */
export async function readNodeProfile(
  db: SupabaseClient,
  userId: string,
): Promise<NodeProfile | null> {
  const { data: profile, error } = await db
    .from('node_profiles')
    .select(NODE_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return null;

  const [skills, credentials] = await Promise.all([
    db.from('node_skills').select(SKILL_COLUMNS).eq('node_id', userId).order('skill_tag'),
    db
      .from('node_credentials')
      .select(CREDENTIAL_COLUMNS)
      .eq('node_id', userId)
      .order('created_at'),
  ]);
  if (skills.error) throw skills.error;
  if (credentials.error) throw credentials.error;

  return toProfile(
    NodeRow.parse(profile),
    (skills.data ?? []).map((r) => toSkill(SkillRow.parse(r))),
    (credentials.data ?? []).map((r) => toCredential(CredentialRow.parse(r))),
  );
}

/* ----------------------------------------------------------------- writes */

export interface NodePatch {
  serviceJurisdictions?: string[];
  languages?: string[];
  rate?: number | null;
  ratePeriod?: 'hour' | 'task' | null;
  currency?: string;
  availability?: 'available' | 'paused' | 'offboarded';
}

/**
 * Apply a node's own edits.
 *
 * The column map is written out rather than spread from the patch, so a field
 * added to `PatchNodeBody` does not silently become writable here. `updated_at`
 * is stamped explicitly because `node_profiles` has no generic touch trigger:
 * its only trigger fires on a KYC transition (`20260831120000:311-314`), so an
 * ordinary edit would otherwise leave the column reading as the invite date.
 */
export async function patchNodeProfile(
  admin: SupabaseClient,
  userId: string,
  patch: NodePatch,
  now: Date,
): Promise<NodeProfile | null> {
  const update: Record<string, unknown> = { updated_at: now.toISOString() };
  if (patch.serviceJurisdictions !== undefined)
    update.service_jurisdictions = patch.serviceJurisdictions;
  if (patch.languages !== undefined) update.languages = patch.languages;
  if (patch.rate !== undefined) update.rate = patch.rate;
  if (patch.ratePeriod !== undefined) update.rate_period = patch.ratePeriod;
  if (patch.currency !== undefined) update.currency = patch.currency;
  if (patch.availability !== undefined) update.availability = patch.availability;

  const { error } = await admin.from('node_profiles').update(update).eq('user_id', userId);
  if (error) throw error;

  return readNodeProfile(admin, userId);
}

/**
 * Claim a skill.
 *
 * `insert` rather than `upsert`, so a repeat claim collides on the composite
 * primary key and the route can answer 200 with the row that already exists.
 * `upsert` would have rewritten `verified` and `verified_at` back to their
 * defaults, which is a node un-verifying their own confirmed skill by claiming
 * it twice.
 */
export async function addNodeSkill(
  admin: SupabaseClient,
  userId: string,
  tag: string,
): Promise<NodeSkill> {
  const { data, error } = await admin
    .from('node_skills')
    .insert({ node_id: userId, skill_tag: tag })
    .select(SKILL_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('skill insert returned no row');
  return toSkill(SkillRow.parse(data));
}

export async function readNodeSkill(
  db: SupabaseClient,
  userId: string,
  tag: string,
): Promise<NodeSkill | null> {
  const { data, error } = await db
    .from('node_skills')
    .select(SKILL_COLUMNS)
    .eq('node_id', userId)
    .eq('skill_tag', tag)
    .maybeSingle();
  if (error) throw error;
  return data ? toSkill(SkillRow.parse(data)) : null;
}

/**
 * Drop a claim.
 *
 * A delete rather than a flag, and the distinction from a credential is the
 * point: a skill is a claim about what somebody can do today, where a licence is
 * a dated assertion we once made about them. Retracting the first leaves nothing
 * worth keeping; retracting the second has to leave a trail, which is why
 * `revokeNodeCredential` below writes a date instead.
 */
export async function removeNodeSkill(
  admin: SupabaseClient,
  userId: string,
  tag: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('node_skills')
    .delete()
    .eq('node_id', userId)
    .eq('skill_tag', tag)
    .select('skill_tag');
  if (error) throw error;
  return (data ?? []).length > 0;
}

export interface CredentialInput {
  kind: 'lawyer' | 'accountant' | 'notary';
  jurisdiction: string;
  issuer?: string;
  licenceNumber?: string;
}

/**
 * Is there already a claim this one would duplicate?
 *
 * The table's unique key is `(node_id, kind, jurisdiction, licence_number)` and
 * `licence_number` is nullable, so under Postgres's default `NULLS DISTINCT` two
 * claims to be a Texas notary with no number given **both insert**. The
 * constraint is doing what it was declared to do; it simply cannot express this
 * case. So the check lives here, before the insert, and it is stated in the
 * module doc rather than left for somebody to find as two identical rows.
 */
export async function findDuplicateCredential(
  db: SupabaseClient,
  userId: string,
  input: CredentialInput,
): Promise<NodeCredential | null> {
  let query = db
    .from('node_credentials')
    .select(CREDENTIAL_COLUMNS)
    .eq('node_id', userId)
    .eq('kind', input.kind)
    .eq('jurisdiction', input.jurisdiction)
    .is('revoked_at', null);

  query =
    input.licenceNumber === undefined
      ? query.is('licence_number', null)
      : query.eq('licence_number', input.licenceNumber);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ? toCredential(CredentialRow.parse(data)) : null;
}

/**
 * Record a claimed licence. **Never a verified one.**
 *
 * `verified` is left at its default of false and is not writable from here at
 * all. Marking it true requires `verified_at` and `evidence_path`
 * (`node_credentials_verified_has_evidence`), which requires a storage bucket
 * that does not exist, and it is write-once by trigger: a licence we once
 * asserted is **revoked** with a date, never un-verified. Verifying one needs a
 * real registry we cannot call, so this slice claims and does not confirm.
 */
export async function addNodeCredential(
  admin: SupabaseClient,
  userId: string,
  input: CredentialInput,
): Promise<NodeCredential> {
  const { data, error } = await admin
    .from('node_credentials')
    .insert({
      node_id: userId,
      kind: input.kind,
      jurisdiction: input.jurisdiction,
      issuer: input.issuer ?? null,
      licence_number: input.licenceNumber ?? null,
    })
    .select(CREDENTIAL_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('credential insert returned no row');
  return toCredential(CredentialRow.parse(data));
}

/** Conditional on not already being revoked, so a double click is one revocation. */
export async function revokeNodeCredential(
  admin: SupabaseClient,
  userId: string,
  credentialId: string,
  now: Date,
): Promise<NodeCredential | null> {
  const { data, error } = await admin
    .from('node_credentials')
    .update({ revoked_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', credentialId)
    .eq('node_id', userId)
    .is('revoked_at', null)
    .select(CREDENTIAL_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? toCredential(CredentialRow.parse(data)) : null;
}

/* ---------------------------------------------------------- verification */

/**
 * Hand a provider's checks to Postgres, which decides the status.
 *
 * **The refusal comes first, and it is why this is a function rather than three
 * lines in the route.** `carriesRealPii` raises on an unregistered provider
 * rather than answering false, and refuses a registered one that collects real
 * documents, because today's posture is accepted in
 * security-compliance.md only while the sole provider is the in-repo fake. That
 * is the `writeConnection` pattern, applied to a heavier accepted risk: there, a
 * plaintext token; here, a stranger's identity documents existing at all.
 *
 * The verdict is not computed here. `decide_node_kyc` derives it from the rows
 * it can see after an append-only insert, in the same transaction as the status
 * change, and refuses an illegal arc through the lifecycle map. Computing it in
 * Node would mean deciding from the payload, which a replay makes wrong.
 */
export async function decideNodeKyc(
  admin: SupabaseClient,
  input: {
    nodeId: string;
    provider: string;
    checks: VerificationCheck[];
    idempotencyPrefix: string;
  },
): Promise<string> {
  if (carriesRealPii(input.provider)) {
    throw new Error(
      `Refusing to record checks from "${input.provider}": it collects real identity documents, ` +
        'and no data-processing agreement, retention schedule or deletion path is wired. ' +
        'Those land in the same change as the first real verifier, per the accepted risk in ' +
        'docs/10-architecture/security-compliance.md.',
    );
  }

  const { data, error } = await admin.rpc('decide_node_kyc', {
    p_node_id: input.nodeId,
    p_provider: input.provider,
    p_checks: input.checks.map((c) => ({
      kind: c.kind,
      result: c.result,
      provider_ref: c.providerRef,
      detail: c.detail,
    })),
    p_idempotency_prefix: input.idempotencyPrefix,
  });
  if (error) throw error;
  return data as string;
}

/**
 * Record what happened, because none of these tables audits an ordinary edit.
 *
 * `node_profiles` writes an event on a KYC transition and on nothing else, and
 * the skills and credentials tables have no trigger at all, so claiming a licence
 * would otherwise be the only assertion in this domain with no record behind it.
 *
 * **`actor_id` is explicit**, because every write in this file runs under the
 * service key and the `auth.uid()` idiom the SQL writers use reads null there,
 * which would file a person's claim as the system's.
 *
 * Never throws: an event that failed to write must not undo the act it describes.
 */
export async function auditNode(
  admin: SupabaseClient,
  event: {
    verb:
      | 'node.profile_updated'
      | 'node.skill_claimed'
      | 'node.skill_dropped'
      | 'node.credential_claimed'
      | 'node.credential_revoked'
      | 'node.verification_submitted';
    actorId: string;
    nodeId: string;
    payload: Record<string, unknown>;
  },
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<void> {
  const { error } = await admin.from('events').insert({
    project_id: null,
    actor_id: event.actorId,
    actor_kind: 'user',
    verb: event.verb,
    subject_type: 'node',
    subject_id: event.nodeId,
    payload: event.payload,
  });
  if (error) log?.error({ err: error, verb: event.verb }, 'node event not recorded');
}
