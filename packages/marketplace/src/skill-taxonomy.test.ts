/**
 * The taxonomy's job is to refuse, so the refusals are what is pinned.
 *
 * One property is asserted against the database's own regex rather than against
 * a hand-written list: every tag this file blesses has to be a tag the column
 * will accept, because a taxonomy that offers a person a skill Postgres then
 * rejects turns an editorial choice into a 500.
 */

import { describe, expect, it } from 'vitest';
import {
  SKILL_TAXONOMY,
  isKnownSkill,
  parseSkillTag,
  skillEntry,
  skillRejectionReason,
} from './skill-taxonomy';

/** Copied from `20260831121000_marketplace_node_skills.sql:32`. */
const COLUMN_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*(:[A-Z]{2}(-[A-Za-z0-9]+){0,2})?$/;

describe('the taxonomy and the column agree', () => {
  it('offers no base tag the column would refuse', () => {
    for (const entry of SKILL_TAXONOMY) {
      expect(COLUMN_SHAPE.test(entry.tag), entry.tag).toBe(true);
    }
  });

  it('offers no jurisdictional tag whose worked example the column would refuse', () => {
    for (const entry of SKILL_TAXONOMY.filter((s) => s.requiresJurisdiction)) {
      expect(COLUMN_SHAPE.test(`${entry.tag}:US-TX`), entry.tag).toBe(true);
    }
  });

  it('has no duplicate tags, since the primary key would silently absorb one', () => {
    const tags = SKILL_TAXONOMY.map((s) => s.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe('parseSkillTag', () => {
  it('splits a jurisdictional tag', () => {
    expect(parseSkillTag('notary:US-TX')).toEqual({ base: 'notary', jurisdiction: 'US-TX' });
  });

  it('reports no jurisdiction rather than an empty one', () => {
    expect(parseSkillTag('paid-ads')).toEqual({ base: 'paid-ads', jurisdiction: null });
  });

  it('returns null for anything the column would refuse', () => {
    expect(parseSkillTag('Paid Ads')).toBeNull();
    expect(parseSkillTag('SEO')).toBeNull();
    expect(parseSkillTag('notary:texas')).toBeNull();
    expect(parseSkillTag('')).toBeNull();
  });
});

describe('isKnownSkill fails closed', () => {
  it('accepts a plain skill and a placed one', () => {
    expect(isKnownSkill('paid-ads')).toBe(true);
    expect(isKnownSkill('notary:US-TX')).toBe(true);
    expect(isKnownSkill('legal-filing:US')).toBe(true);
  });

  it('refuses a well-shaped tag nobody registered', () => {
    // The case free text would have let through, and the reason the matcher
    // would then return one person for a skill two people have.
    expect(isKnownSkill('paid-adz')).toBe(false);
    expect(isKnownSkill('growth-hacking')).toBe(false);
  });

  it('refuses a jurisdictional skill claimed everywhere', () => {
    // A claim to be a notary in every territory at once.
    expect(isKnownSkill('notary')).toBe(false);
  });

  it('refuses a universal skill claimed somewhere in particular', () => {
    // Would split one tag into as many as there are territories.
    expect(isKnownSkill('copywriting:US-TX')).toBe(false);
  });

  it('does not resolve through the prototype chain', () => {
    expect(isKnownSkill('constructor')).toBe(false);
    expect(isKnownSkill('tostring')).toBe(false);
  });
});

describe('skillRejectionReason', () => {
  it('says nothing when there is nothing to say', () => {
    expect(skillRejectionReason('seo')).toBeNull();
    expect(skillRejectionReason('bookkeeping:US-TX')).toBeNull();
  });

  it('names the missing jurisdiction rather than restating the shape', () => {
    expect(skillRejectionReason('notary')).toContain('notary:US-TX');
  });

  it('names the surplus jurisdiction', () => {
    expect(skillRejectionReason('seo:US-TX')).toContain('seo');
  });

  it('explains an unregistered skill without blaming the shape', () => {
    expect(skillRejectionReason('growth-hacking')).toContain('not a skill');
  });

  it('explains a malformed tag as a shape problem', () => {
    expect(skillRejectionReason('Paid Ads')).toContain('lowercase');
  });
});

describe('skillEntry', () => {
  it('is keyed on the base tag, not the full one', () => {
    expect(skillEntry('notary')?.requiresJurisdiction).toBe(true);
    expect(skillEntry('notary:US-TX')).toBeNull();
  });
});
