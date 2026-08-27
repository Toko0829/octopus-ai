import { describe, expect, it } from 'vitest';
import { assertSafeUrl } from './fetch-url';
import { CADENCE_MS, CRAWL_SOURCES, cadenceToInterval } from './crawl-registry';
import { hashPageText, isDue, selectDueSources, type CrawlSourceRow } from './crawl';
import type { CrawlSourceSpec } from './crawl-registry';

/**
 * The sweep's decisions, tested where they are decisions rather than IO.
 *
 * The registry check is the one worth reading twice. Every entry is fed through
 * the real SSRF guard, so a typo that lands on a private range fails in CI rather
 * than at 3am from inside our own network, where the whole point of that guard is
 * that requests originating here reach things a caller cannot.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z');

function spec(overrides: Partial<CrawlSourceSpec> = {}): CrawlSourceSpec {
  return {
    url: 'https://example.test/a',
    label: 'Example',
    authority: 'official',
    cadence: 'daily',
    market: 'US',
    businessType: 'digital-marketing > full-funnel',
    docType: 'ad-policy',
    title: 'Example policy',
    lang: 'english',
    ...overrides,
  };
}

function row(lastCrawled: string | null): CrawlSourceRow {
  return { id: 'source-1', last_crawled: lastCrawled, content_hash: null };
}

describe('when a source is due', () => {
  it('treats a source that has never been read as due', () => {
    expect(isDue(null, 'monthly', NOW)).toBe(true);
  });

  it('is not due before its cadence has elapsed', () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(isDue(anHourAgo, 'daily', NOW)).toBe(false);
  });

  it('is due once the cadence has elapsed exactly', () => {
    const exactly = new Date(NOW.getTime() - CADENCE_MS.daily).toISOString();
    expect(isDue(exactly, 'daily', NOW)).toBe(true);
  });

  it('measures from the last ATTEMPT, so a failing page is not retried every pass', () => {
    // The row records a crawl that failed, and the hash is still null. Due-ness
    // must not consult the hash: a 404 retried every thirty seconds is a small
    // denial of service pointed at somebody who has done nothing wrong.
    const justNow = new Date(NOW.getTime() - 1000).toISOString();
    expect(isDue(justNow, 'daily', NOW)).toBe(false);
  });

  it('treats an unreadable timestamp as due rather than as never due', () => {
    // Failing open here means one extra fetch. Failing closed means a source
    // silently stops updating, which is the failure nobody notices.
    expect(isDue('not a date', 'daily', NOW)).toBe(true);
  });
});

describe('choosing what to read this pass', () => {
  it('returns nothing when nothing is due', () => {
    const recent = new Date(NOW.getTime() - 1000).toISOString();
    const rows = new Map([['https://example.test/a', row(recent)]]);
    expect(selectDueSources([spec()], rows, NOW, 2)).toEqual([]);
  });

  it('caps how many are read at once', () => {
    const specs = [
      spec({ url: 'https://example.test/a' }),
      spec({ url: 'https://example.test/b' }),
      spec({ url: 'https://example.test/c' }),
    ];
    expect(selectDueSources(specs, new Map(), NOW, 2)).toHaveLength(2);
  });

  it('reads the stalest first, so a backlog drains in the order it went stale', () => {
    const specs = [
      spec({ url: 'https://example.test/fresh' }),
      spec({ url: 'https://example.test/stale' }),
    ];
    const rows = new Map([
      [
        'https://example.test/fresh',
        row(new Date(NOW.getTime() - CADENCE_MS.daily * 2).toISOString()),
      ],
      [
        'https://example.test/stale',
        row(new Date(NOW.getTime() - CADENCE_MS.daily * 9).toISOString()),
      ],
    ]);
    expect(selectDueSources(specs, rows, NOW, 1)[0]?.url).toBe('https://example.test/stale');
  });

  it('puts a never-read source ahead of every read one', () => {
    const specs = [
      spec({ url: 'https://example.test/old' }),
      spec({ url: 'https://example.test/new' }),
    ];
    const rows = new Map([
      [
        'https://example.test/old',
        row(new Date(NOW.getTime() - CADENCE_MS.daily * 30).toISOString()),
      ],
    ]);
    expect(selectDueSources(specs, rows, NOW, 1)[0]?.url).toBe('https://example.test/new');
  });

  it('treats a source with no row at all as due', () => {
    // This is a registry entry added since the last pass. It has no row yet, and
    // reading it as "not due" would mean a new source never gets fetched.
    expect(selectDueSources([spec()], new Map(), NOW, 5)).toHaveLength(1);
  });
});

describe('the page hash', () => {
  it('is stable for the same text', () => {
    expect(hashPageText('disclosure guidance')).toBe(hashPageText('disclosure guidance'));
  });

  it('changes when a single character does', () => {
    expect(hashPageText('a policy page')).not.toBe(hashPageText('a policy page.'));
  });

  it('is hex, so it fits the text column it is stored in', () => {
    expect(hashPageText('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the registry itself', () => {
  it('points every entry at an address the SSRF guard accepts', () => {
    // The real guard, not a copy of its rules. Nothing here is user-supplied, so
    // this catches our own typos rather than an attack, and a private address in
    // this file would be fetched from inside our network on a schedule.
    for (const source of CRAWL_SOURCES) {
      expect(() => assertSafeUrl(source.url), source.url).not.toThrow();
    }
  });

  it('uses https everywhere', () => {
    for (const source of CRAWL_SOURCES) {
      expect(source.url.startsWith('https://'), source.url).toBe(true);
    }
  });

  it('has a unique url per entry', () => {
    // knowledge_sources is unique on url, so a duplicate would have two registry
    // entries fighting over one row and superseding each other's documents.
    const urls = CRAWL_SOURCES.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('has a unique title per entry', () => {
    // A document is (source_id, title). Two entries sharing a title under the
    // same label would be one document flip-flopping between two pages.
    const titles = CRAWL_SOURCES.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('states a market, a doc type and a business type for every entry', () => {
    for (const source of CRAWL_SOURCES) {
      expect(source.market, source.title).toBeTruthy();
      expect(source.docType, source.title).toBeTruthy();
      expect(source.businessType, source.title).toBeTruthy();
    }
  });

  it('renders every cadence as a Postgres interval', () => {
    for (const source of CRAWL_SOURCES) {
      expect(cadenceToInterval(source.cadence)).toMatch(/^\d+ (day|days)$/);
    }
  });

  it('keeps UK guidance out of the EU market key', () => {
    // The ICO is not an EU authority and its guidance is PECR rather than
    // ePrivacy as a member state applies it. Filing it as EU is precisely the
    // jurisdiction bleed rag.md forbids.
    const ico = CRAWL_SOURCES.find((s) => s.url.includes('ico.org.uk'));
    expect(ico?.market).toBe('UK');
  });
});
