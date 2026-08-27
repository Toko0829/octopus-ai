/**
 * The external sources Octopus reads, declared rather than discovered.
 *
 * **Why a checked-in allow-list and not a table.** Every entry here is a claim
 * about provenance: that this page is a regulator's and that page is a vendor's,
 * that this one is US law and that one is UK guidance. Those are editorial
 * judgements, and the alternative, inferring authority from a hostname, is how a
 * vendor blog becomes a regulator. A file gets reviewed in a diff by a person;
 * a row does not.
 *
 * It is also the security boundary. `fetch-url.ts` exists because a URL a user
 * typed goes wherever they typed; nothing here is user-supplied, so the sweep
 * never fetches an address nobody reviewed. A test asserts every entry passes the
 * same SSRF guard anyway, because a typo that reaches a private range should fail
 * in CI rather than at 3am from inside our network.
 *
 * **Titles are identity.** A document is `(source_id, title)` in the database and
 * the eval golden set matches on the title string. Changing one here does not
 * rename a document, it orphans the old one as still-in-force and starts a new
 * lineage beside it. Treat them as fixed once live.
 *
 * **Every entry here was verified by reading what it stored, and then by what the
 * eval did with it.** The first run made that necessary rather than pedantic.
 * Nine pages were registered on reasonable-looking URLs, seven fetched, and three
 * of the seven were navigation chrome: a hub page listing links to the guidance
 * rather than the guidance, and in one case a page localised to the crawler's own
 * IP so the stored "source" was a Facebook menu in Georgian. A 200 says a server
 * answered. It says nothing about whether the answer is a document.
 *
 * A fourth was removed for a different reason worth keeping separate. Meta's
 * advertising standards fetched perfectly and read like exactly what we wanted,
 * and the retrieval eval removed it: a 25-chunk policy hub written in general
 * marketing vocabulary acts as a magnet, so it caused the gate's only leak and
 * crowded the document that answers an unrelated question out of that question's
 * own results. **Fetchability and usefulness are separate questions.**
 *
 * The removed entries are recorded in `docs/30-modules/rag-knowledge.md` with
 * what each produced, because "we tried that and it does not work" is worth more
 * to the next person than a shorter list.
 *
 * See that doc for what is measured about these pages and which families are
 * still uncovered.
 */

/** How often a source is worth re-reading. */
export type CrawlCadence = 'daily' | 'weekly' | 'monthly';

export interface CrawlSourceSpec {
  /** The page. Vetted by `assertSafeUrl` in a test, not only at fetch time. */
  url: string;
  /** Who publishes it. Becomes `knowledge_sources.label` and the citation's name. */
  label: string;
  /**
   * Mirrors `public.source_authority`. `official` is a regulator or the platform
   * stating its own rules; `vendor` is that platform's documentation of its own
   * product. The distinction matters when the two disagree.
   */
  authority: 'official' | 'vendor';
  cadence: CrawlCadence;
  /** Unambiguous market key. Never generalised across borders (rag.md). */
  market: string;
  businessType: string;
  docType: string;
  /** Stable across re-crawls: this is the document's identity. */
  title: string;
  lang: 'english';
}

const BUSINESS_TYPE = 'digital-marketing > full-funnel';

/**
 * Cadence is chosen from how fast the page actually changes, not from how much
 * we care about it. Format specs move whenever a platform ships; policy hubs
 * move in releases; a regulator's guidance note can sit unchanged for years.
 * Re-reading an unchanged page costs a request and nothing else, since the sweep
 * compares a hash before it calls the ingester, but it is still somebody's
 * bandwidth.
 */
export const CRAWL_SOURCES: CrawlSourceSpec[] = [
  {
    url: 'https://support.google.com/adspolicy/answer/6008942',
    label: 'Google Ads policy',
    authority: 'official',
    cadence: 'weekly',
    market: 'US',
    businessType: BUSINESS_TYPE,
    docType: 'ad-policy',
    title: 'Google Ads policies overview',
    lang: 'english',
  },
  {
    url: 'https://support.google.com/adspolicy/answer/143465',
    label: 'Google Ads policy',
    authority: 'official',
    cadence: 'weekly',
    market: 'US',
    businessType: BUSINESS_TYPE,
    docType: 'ad-policy',
    title: 'Google Ads personalized advertising policy',
    lang: 'english',
  },
  {
    url: 'https://support.google.com/google-ads/answer/7684791',
    label: 'Google Ads help',
    authority: 'vendor',
    cadence: 'daily',
    market: 'US',
    businessType: BUSINESS_TYPE,
    docType: 'format-spec',
    title: 'Google responsive search ad format spec',
    lang: 'english',
  },
  {
    // The guidance itself, not the section landing page above it. Registering the
    // landing page produced three chunks of site navigation, because that is
    // genuinely all it contains: it is a list of links to pages like this one.
    url: 'https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/electronic-and-telephone-marketing/',
    label: "Information Commissioner's Office",
    authority: 'official',
    cadence: 'monthly',
    // UK, not EU. The ICO is not an EU authority after Brexit and its guidance is
    // PECR rather than ePrivacy as applied by a member state. Filing it as EU
    // would be exactly the jurisdiction bleed rag.md forbids.
    market: 'UK',
    businessType: BUSINESS_TYPE,
    docType: 'privacy-guidance',
    title: 'ICO guide to PECR: electronic and telephone marketing',
    lang: 'english',
  },
];

/** Milliseconds per cadence, for the due check. */
export const CADENCE_MS: Record<CrawlCadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** The same cadence as a Postgres interval, for `knowledge_sources.crawl_cadence`. */
export function cadenceToInterval(cadence: CrawlCadence): string {
  return { daily: '1 day', weekly: '7 days', monthly: '30 days' }[cadence];
}

/**
 * How the crawler identifies itself.
 *
 * A contact address rather than a bare token, because the only thing an operator
 * can do with an anonymous crawler is block it.
 */
export const CRAWLER_USER_AGENT =
  'OctopusCrawler/0.1 (+https://github.com/octopus; marketing knowledge base)';
