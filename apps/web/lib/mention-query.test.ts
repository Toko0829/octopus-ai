/**
 * Whether to offer the mention list while somebody is typing.
 *
 * Every case here is a boundary case, which is why the logic is a pure function
 * rather than inline in the composer: this project has no component-test runner,
 * so a regex living inside an event handler would be checked only by hand.
 */

import { describe, expect, it } from 'vitest';
import { mentionQuery } from './mention-query';

/** Caret at the end of the text, which is what typing normally means. */
const atEnd = (value: string) => mentionQuery(value, value.length);

describe('mentionQuery', () => {
  it('opens on a bare @ at the start', () => {
    expect(atEnd('@')).toEqual({ start: 0, query: '' });
  });

  it('opens on a partial name and reports what was typed', () => {
    expect(atEnd('@Ad')).toEqual({ start: 0, query: 'Ad' });
    expect(atEnd('please @Anal')).toEqual({ start: 7, query: 'Anal' });
  });

  it('does not open inside an email address', () => {
    // The case a regex written inline would get wrong first, and the one a
    // person hits by typing an ordinary sentence.
    expect(atEnd('write to someone@ads')).toBeNull();
    expect(atEnd('me@')).toBeNull();
  });

  it('does not open on a second @ typed straight after one', () => {
    expect(atEnd('@@')).toBeNull();
  });

  it('closes once the word ends', () => {
    // A space means the mention is finished, whether or not it named anybody.
    expect(atEnd('@Ads ')).toBeNull();
    expect(atEnd('@Ads move the budget')).toBeNull();
  });

  it('reads the word the caret is in, not the last one in the text', () => {
    // The caret sits after "@Ad" in "@Ad move"; the rest of the line is not the
    // query and offering a list based on it would be offering the wrong list.
    expect(mentionQuery('@Ad move the budget', 3)).toEqual({ start: 0, query: 'Ad' });
  });

  it('is null when the caret is nowhere near an @', () => {
    expect(atEnd('grow my newsletter')).toBeNull();
    expect(mentionQuery('@Ads', 0)).toBeNull();
  });

  it('is null for a caret outside the text', () => {
    expect(mentionQuery('@Ads', 99)).toBeNull();
    expect(mentionQuery('@Ads', -1)).toBeNull();
  });

  it('gives a start that replaces exactly the token', () => {
    const value = 'please @Anal';
    const q = mentionQuery(value, value.length)!;
    expect(value.slice(q.start, value.length)).toBe('@Anal');
  });
});
