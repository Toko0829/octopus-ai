/**
 * The `@word` the caret is sitting in, if it is sitting in one.
 *
 * Split out of the composer and pure, because the interesting cases are all
 * boundary cases and none of them are visible in a component test this project
 * has no runner for: a caret in the middle of a word, an `@` inside an email
 * address, and a second `@` typed after a completed mention.
 *
 * **Deliberately looser than `mentionRegex`.** That one decides what counts as a
 * mention in a finished message and is shared with the server. This one decides
 * whether to offer a list while somebody is still typing, so it matches a bare
 * `@` and a partial name, which are not mentions and never will be. The two
 * answer different questions and would be wrong as one function.
 */
export interface MentionQuery {
  /** Index of the `@`, so the caller can replace from there to the caret. */
  start: number;
  /** What has been typed after it, possibly empty. */
  query: string;
}

export function mentionQuery(value: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > value.length) return null;

  const before = value.slice(0, caret);
  // The `@` must open a word: preceded by nothing, whitespace or punctuation,
  // and never by a word character, which is what keeps `someone@ads.com` from
  // opening a list on the third keystroke of a domain.
  const match = /(?<![\w@])@(\w*)$/.exec(before);
  if (!match) return null;

  return { start: caret - match[0].length, query: match[1] ?? '' };
}
