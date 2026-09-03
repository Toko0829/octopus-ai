/**
 * The mention grammar, and the sentence it becomes.
 *
 * The grammar itself lives in `packages/contracts`, because two independent
 * readers must agree on it: the composer decides what to highlight and offer in
 * the browser, and `startRun` decides what to route in Fastify. A second regex
 * in `apps/web` would disagree with this one at exactly the cases nobody thinks
 * to test, which is what most of this file is.
 *
 * It is tested from here because contracts has no test runner and core already
 * depends on it. `mentionReason` is core's own.
 */

import { describe, expect, it } from 'vitest';
import { mentionRegex, parseMention, stripMention } from '@octopus/contracts';
import { mentionReason } from './mention';
import { REPLAN_REASON_MAX } from './intake';

describe('parseMention', () => {
  it('finds a persona by name, whatever the case', () => {
    expect(parseMention('@Ads move the budget')).toBe('ads');
    expect(parseMention('hey @ads, do it')).toBe('ads');
    expect(parseMention('@ANALYST what happened')).toBe('analyst');
  });

  it('takes the first when a message names two', () => {
    // A message naming two specialists is one request, and asking the owner to
    // disambiguate would be a question about our data model rather than about
    // their business. The step that lands is a card they approve either way.
    expect(parseMention('@Content then @Ads')).toBe('content');
  });

  it('is not fooled by an email address', () => {
    // The case a second regex in the browser would get wrong first.
    expect(parseMention('write to someone@ads.com please')).toBeNull();
    expect(parseMention('cc me@content.io')).toBeNull();
  });

  it('does not match a longer word that starts with a name', () => {
    expect(parseMention('@Adsy is not a persona')).toBeNull();
    expect(parseMention('@Content-team please')).toBeNull();
  });

  it('does not match the product name', () => {
    // `@Octopus` addresses the whole thing, which is what every message already
    // does. Routing it as a specialist mention would silently change what a
    // plain goal does.
    expect(parseMention('@Octopus hello')).toBeNull();
  });

  it('matches a name followed by punctuation', () => {
    expect(parseMention('@Ads, please pause it')).toBe('ads');
    expect(parseMention('done, @Analyst?')).toBe('analyst');
  });

  it('returns null for a message with no mention', () => {
    expect(parseMention('grow my newsletter to 1000 subscribers')).toBeNull();
    expect(parseMention('')).toBeNull();
  });
});

describe('mentionRegex', () => {
  it('returns a fresh object each call', () => {
    // A shared `/g` regex carries `lastIndex` and silently skips matches on its
    // second use, which in the composer would mean a highlight that vanishes on
    // every other render.
    const a = mentionRegex();
    a.exec('@Ads');
    expect(mentionRegex().lastIndex).toBe(0);
  });

  it('finds every mention in a line, for highlighting', () => {
    const found = [...'@Ads and @Content'.matchAll(mentionRegex())].map((m) => m[1]);
    expect(found).toEqual(['Ads', 'Content']);
  });
});

describe('stripMention', () => {
  it('removes exactly one token and tidies the space', () => {
    expect(stripMention('@Ads move the budget to Meta', 'ads')).toBe('move the budget to Meta');
    expect(stripMention('please @Ads   pause it', 'ads')).toBe('please pause it');
  });

  it('leaves a second mention of the same name in place', () => {
    // One token, so a message that repeats a name stays legible rather than
    // being quietly rewritten.
    expect(stripMention('@Ads and @Ads again', 'ads')).toBe('and @Ads again');
  });

  it('leaves a message with nothing to strip alone', () => {
    expect(stripMention('grow my newsletter', 'ads')).toBe('grow my newsletter');
  });
});

describe('mentionReason', () => {
  it('names the voice and its single stage', () => {
    const reason = mentionReason('ads', '@Ads move the budget to Meta');
    expect(reason).toContain('The owner asked Ads, who owns the channels stage, to:');
    expect(reason).toContain('move the budget to Meta');
    expect(reason).toContain('Change only the steps in that stage');
  });

  it('names all three of a voice that owns several', () => {
    const reason = mentionReason('content', '@Content rewrite the welcome email');
    expect(reason).toContain('who owns the content, creative and conversion stages');
    expect(reason).toContain('Change only the steps in those stages');
  });

  it('quotes the request without its mention token', () => {
    // The planner is told who was asked in the sentence above; leaving the token
    // in the quoted text invites it to treat "@Ads" as part of the ask.
    expect(mentionReason('ads', '@Ads pause everything')).not.toContain('@Ads');
  });

  it('says so when the message was only a mention', () => {
    const reason = mentionReason('analyst', '@Analyst');
    expect(reason).toContain('nothing beyond the mention itself');
  });

  it('stays inside the reason limit for a very long request', () => {
    // The cap is the reasoning core's, mirrored in `intake.ts`. Over it is a 422
    // in the middle of somebody's request.
    const reason = mentionReason('ads', `@Ads ${'x'.repeat(5000)}`);
    expect(reason.length).toBeLessThanOrEqual(REPLAN_REASON_MAX);
    expect(reason).toContain('Change only the steps in that stage');
  });

  it('writes no em dash, for any voice', () => {
    // AGENTS.md rule 22. This sentence reaches the reasoning core rather than a
    // person, but it is quoted back onto the card the owner reads.
    for (const persona of ['strategist', 'content', 'ads', 'analyst'] as const) {
      expect(mentionReason(persona, `@X do the thing`)).not.toContain('—');
    }
  });
});
