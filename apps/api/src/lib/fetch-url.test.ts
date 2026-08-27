/**
 * Guarding the one outbound call a user gets to aim.
 *
 * Every other network call this system makes goes to a provider we chose. This
 * one goes wherever somebody typed, from inside our network, which means it can
 * reach things the person typing cannot: localhost, private ranges, and the
 * cloud metadata endpoint that hands out instance credentials.
 *
 * The asymmetry decides the close calls. Refusing a legitimate page costs one
 * message telling the person to paste the text instead. Allowing a hostile one
 * costs credentials. So the guard errs toward refusing, and these tests pin the
 * cases where that trade was made on purpose rather than by accident.
 */

import { describe, expect, it } from 'vitest';
import { UnsafeUrlError, assertSafeUrl, htmlToText } from './fetch-url';

describe('addresses the fetcher must refuse', () => {
  it.each([
    ['http://localhost:3000/', 'localhost by name'],
    ['http://127.0.0.1/', 'loopback by address'],
    ['http://0.0.0.0/', 'the unspecified address'],
    ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata endpoint'],
    ['http://metadata.google.internal/', 'the same thing by name'],
    ['http://10.0.0.5/', 'a private class A address'],
    ['http://192.168.1.1/', 'a home router'],
    ['http://172.16.0.9/', 'the bottom of the private class B range'],
    ['http://172.31.255.1/', 'the top of it'],
    ['http://printer.local/', 'an mDNS name'],
    ['http://vault.internal/', 'an internal name'],
    ['http://[::1]/', 'IPv6 loopback'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError);
  });

  it.each([
    ['file:///etc/passwd', 'the file protocol'],
    ['data:text/html,<h1>hi</h1>', 'a data URL'],
    ['gopher://example.com/', 'a protocol nobody meant to allow'],
    ['javascript:alert(1)', 'a script URL'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertSafeUrl(url)).toThrow(UnsafeUrlError);
  });

  it('refuses something that is not a URL at all, and says what to do', () => {
    // The message reaches a person in their room, so it has to be actionable.
    expect(() => assertSafeUrl('bluelly.com')).toThrow(/https:\/\//);
  });

  it('does not admit 172.32, which is outside the private range', () => {
    // The boundary either side of a range is where an off-by-one lives, and
    // being wrong in this direction refuses a real customer's site.
    expect(assertSafeUrl('https://172.32.0.1/').hostname).toBe('172.32.0.1');
  });
});

describe('addresses it must allow', () => {
  it.each(['https://bluelly.com', 'https://www.bluelly.com/about', 'http://example.org/page?a=1'])(
    'allows %s',
    (url) => {
      expect(assertSafeUrl(url).protocol).toMatch(/^https?:$/);
    },
  );

  it('tolerates surrounding whitespace, because people paste', () => {
    expect(assertSafeUrl('  https://bluelly.com  ').hostname).toBe('bluelly.com');
  });
});

describe('turning a page into text worth embedding', () => {
  it('takes the title and drops the markup', () => {
    const { title, text } = htmlToText(
      '<html><head><title>Bluelly</title></head><body><h1>Flashcards</h1><p>From your notes.</p></body></html>',
    );
    expect(title).toBe('Bluelly');
    expect(text).toContain('Flashcards');
    expect(text).toContain('From your notes.');
    expect(text).not.toContain('<');
  });

  it('drops script and style contents entirely', () => {
    // Otherwise the code survives tag-stripping and gets embedded as prose,
    // which is both useless and the bulk of a modern page.
    const { text } = htmlToText(
      '<body><script>var a = "buy now";</script><style>.x{color:red}</style><p>Real words.</p></body>',
    );
    expect(text).toBe('Real words.');
  });

  it('keeps block boundaries as paragraph breaks', () => {
    // The chunker splits on structure first, so flattening everything to one
    // line would hand it a single 2000-character blob to cut arbitrarily.
    const { text } = htmlToText('<p>One.</p><p>Two.</p>');
    expect(text).toBe('One.\n\nTwo.');
  });

  it('decodes the entities that appear in real prose', () => {
    const { text } = htmlToText('<p>Notes &amp; decks &mdash; it&#39;s &quot;fast&quot;</p>');
    expect(text).toContain('Notes & decks');
    expect(text).toContain("it's");
    expect(text).toContain('"fast"');
  });

  it('collapses the whitespace that indented markup leaves behind', () => {
    const { text } = htmlToText('<p>One.</p>\n\n\n\n   \n<p>Two.</p>');
    expect(text).toBe('One.\n\nTwo.');
  });

  it('returns a null title rather than inventing one', () => {
    expect(htmlToText('<body><p>No title here.</p></body>').title).toBeNull();
  });
});
