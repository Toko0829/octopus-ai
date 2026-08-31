/**
 * What a node may claim to be good at, declared rather than typed in.
 *
 * `20260831121000:22-27` deferred this file and said exactly where it would
 * land: "`skill_tag` is text with a shape check, **not an enum and not a
 * taxonomy table**. The curated taxonomy is the `adapter-registry.ts` stance -- a
 * file gets reviewed in a diff by a person and a row does not -- but that
 * registry is code and belongs with its reader in slice 3."
 *
 * So the database owns the **shape** and this file owns the **vocabulary**, and
 * the split is load-bearing in both directions. A regex cannot tell `paid-ads`
 * from `paid-adz`, and neither can a matcher: two nodes who mean the same thing
 * and spell it differently are two nodes who never appear in the same result.
 * Free text would have made that failure invisible until somebody wondered why a
 * search returned one person. Equally, an enum would need a migration per skill,
 * which is why the column is text.
 *
 * **Unknown tags are refused, not stored.** The alternative -- accept anything
 * matching the regex and let the matcher sort it out -- moves an editorial
 * decision into a place nobody reviews. Adding a skill is a change to this file.
 */

/** Whether a claim in this category means anything without a place attached. */
export interface SkillEntry {
  /** The base tag, matching the lowercase-kebab half of the column's regex. */
  readonly tag: string;
  /** What a person reads on their own surface. Sentence case, no jargon. */
  readonly label: string;
  /** One line, shown beside the label so a claim is made knowingly. */
  readonly description: string;
  /**
   * True where the skill is only meaningful somewhere in particular. A notary is
   * commissioned by a jurisdiction and is not a notary outside it; a copywriter
   * is a copywriter anywhere. The matcher's containment test (ADR-0015) reads
   * this to decide whether the absence of a suffix is a wildcard or a mistake.
   */
  readonly requiresJurisdiction: boolean;
}

/**
 * The marketing wedge first, because that is the work that exists: every task
 * routed to `escalated` today came out of a full-funnel plan. The three
 * jurisdictional entries at the end match `credential_kind`, so a claim can line
 * up with a licence somebody eventually verifies.
 */
export const SKILL_TAXONOMY: readonly SkillEntry[] = Object.freeze([
  {
    tag: 'paid-ads',
    label: 'Paid advertising',
    description: 'Building, launching and tuning paid campaigns on ad platforms.',
    requiresJurisdiction: false,
  },
  {
    tag: 'seo',
    label: 'Search optimisation',
    description: 'Technical and on-page work to earn organic search traffic.',
    requiresJurisdiction: false,
  },
  {
    tag: 'copywriting',
    label: 'Copywriting',
    description: 'Landing pages, ad copy and long-form writing that has to convert.',
    requiresJurisdiction: false,
  },
  {
    tag: 'creative-video',
    label: 'Video and creative',
    description: 'Shooting, editing and cutting creative for paid and organic placement.',
    requiresJurisdiction: false,
  },
  {
    tag: 'email-lifecycle',
    label: 'Email and lifecycle',
    description: 'Welcome, nurture and retention sequences, and the tooling behind them.',
    requiresJurisdiction: false,
  },
  {
    tag: 'outreach',
    label: 'Outreach and partnerships',
    description: 'Finding partners and creators, and running the conversation with them.',
    requiresJurisdiction: false,
  },
  {
    tag: 'analytics',
    label: 'Measurement',
    description: 'Tracking, attribution and reporting that a decision can rest on.',
    requiresJurisdiction: false,
  },
  {
    tag: 'notary',
    label: 'Notary',
    description: 'Witnessing and certifying signatures where a commission is required.',
    requiresJurisdiction: true,
  },
  {
    tag: 'legal-filing',
    label: 'Legal filing',
    description: 'Preparing and lodging filings with a regulator or registry.',
    requiresJurisdiction: true,
  },
  {
    tag: 'bookkeeping',
    label: 'Bookkeeping',
    description: 'Ledgers, reconciliation and the returns a jurisdiction expects.',
    requiresJurisdiction: true,
  },
]);

const BY_TAG: ReadonlyMap<string, SkillEntry> = new Map(SKILL_TAXONOMY.map((s) => [s.tag, s]));

/**
 * The column's own regex, restated so a tag can be refused with a sentence
 * before Postgres refuses it with a `23514`.
 *
 * Two copies of a rule can disagree, which this repository normally refuses. It
 * is taken here because the copies fail in the same direction: anything this
 * accepts and the constraint rejects is a failed write, never a bad row. The
 * constraint remains the one that cannot be bypassed.
 */
const SKILL_TAG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*(:[A-Z]{2}(-[A-Za-z0-9]+){0,2})?$/;

export interface ParsedSkillTag {
  /** The part before the colon. */
  readonly base: string;
  /** The part after it, or null where none was given. */
  readonly jurisdiction: string | null;
}

/**
 * Splits a tag into its two halves without judging either.
 *
 * Returns null on anything the column would refuse, so a caller cannot go on to
 * ask questions about a tag that was never well formed.
 */
export function parseSkillTag(tag: string): ParsedSkillTag | null {
  if (!SKILL_TAG_SHAPE.test(tag)) return null;
  const colon = tag.indexOf(':');
  if (colon === -1) return { base: tag, jurisdiction: null };
  return { base: tag.slice(0, colon), jurisdiction: tag.slice(colon + 1) };
}

export function skillEntry(baseTag: string): SkillEntry | null {
  return BY_TAG.get(baseTag) ?? null;
}

/**
 * Whether a full tag is one a node may claim.
 *
 * Fails closed on every unknown, and refuses two shapes that would otherwise
 * pass silently: a jurisdictional skill claimed with no place, which is a claim
 * to be a notary everywhere, and a non-jurisdictional skill carrying one, which
 * would split `copywriting` into as many tags as there are territories and make
 * the matcher miss all of them.
 */
export function isKnownSkill(tag: string): boolean {
  const parsed = parseSkillTag(tag);
  if (parsed === null) return false;
  const entry = BY_TAG.get(parsed.base);
  if (entry === undefined) return false;
  return entry.requiresJurisdiction === (parsed.jurisdiction !== null);
}

/**
 * Why a tag was refused, in a sentence a person can act on.
 *
 * Separate from `isKnownSkill` because a boolean is what a guard wants and a
 * reason is what a surface owes somebody who just typed something.
 */
export function skillRejectionReason(tag: string): string | null {
  const parsed = parseSkillTag(tag);
  if (parsed === null) {
    return 'A skill tag is lowercase words joined by hyphens, optionally followed by a jurisdiction, for example notary:US-TX.';
  }
  const entry = BY_TAG.get(parsed.base);
  if (entry === undefined) {
    return `"${parsed.base}" is not a skill Octopus recognises. Adding one is a reviewed change to the taxonomy.`;
  }
  if (entry.requiresJurisdiction && parsed.jurisdiction === null) {
    return `${entry.label} only means something somewhere in particular. Add a jurisdiction, for example ${entry.tag}:US-TX.`;
  }
  if (!entry.requiresJurisdiction && parsed.jurisdiction !== null) {
    return `${entry.label} applies everywhere, so it takes no jurisdiction. Claim it as ${entry.tag}.`;
  }
  return null;
}
