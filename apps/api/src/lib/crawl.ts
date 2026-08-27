import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CADENCE_MS,
  CRAWLER_USER_AGENT,
  CRAWL_SOURCES,
  cadenceToInterval,
  type CrawlCadence,
  type CrawlSourceSpec,
} from './crawl-registry';
import { fetchPageText } from './fetch-url';
import { requestIngest } from './ai';

/**
 * The freshness pipeline: re-read the registry's pages on a cadence and ingest
 * the ones that changed.
 *
 * `rag.md` has called freshness a first-order feature since Phase 0 and shipped
 * three columns for it (`crawl_cadence`, `last_crawled`, `content_hash`) that
 * nothing read or wrote. This is their first writer.
 *
 * **Two hashes, doing two different jobs.** `knowledge_sources.content_hash` is a
 * hash of the page text, kept here, and it answers "did the page change" without
 * paying for an HTTP round trip's worth of embedding. `documents.content_hash`
 * lives in the Python ingester and folds in the chunker version and the embedding
 * model, so it answers a different question: "would we index this differently
 * now". Keeping both means an unchanged page costs one fetch, and a page that is
 * unchanged while our indexing has moved still gets re-embedded.
 *
 * The gap that leaves is worth naming rather than discovering: if the embedding
 * model changes and a page does not, this hash matches and the Python ingester is
 * never called, so that document keeps vectors from the old model. The remedy is
 * one statement, `update knowledge_sources set content_hash = null`, which makes
 * every source look changed and re-ingests the lot.
 *
 * **Where it runs.** Inside the ticker's pass, under the claim that pass already
 * holds (ADR-0010). Not `pg_cron`, which rag.md originally specified: pg_cron
 * runs SQL, and SQL cannot make an outbound HTTP request, so it would have to
 * signal something that could. That something is the ticker.
 */

/** Identifies a page's content. Compared against the last hash we stored for it. */
export function hashPageText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What the database knows about a registered source. */
export interface CrawlSourceRow {
  id: string;
  last_crawled: string | null;
  content_hash: string | null;
}

/**
 * Is this source due to be read again?
 *
 * A source never crawled is due. Otherwise it is due once its cadence has
 * elapsed since the last ATTEMPT, which is deliberately not the last success: a
 * page that is failing should be retried on its cadence, not on every pass. A
 * 404 that is retried every thirty seconds is a small denial of service aimed at
 * somebody who has done nothing wrong.
 */
export function isDue(lastCrawled: string | null, cadence: CrawlCadence, now: Date): boolean {
  if (!lastCrawled) return true;
  const last = new Date(lastCrawled).getTime();
  // An unparseable timestamp is treated as due rather than as never-due. The
  // failure mode of the other choice is a source that silently stops updating.
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= CADENCE_MS[cadence];
}

/**
 * Which sources this pass should fetch, oldest first, capped.
 *
 * Oldest first so a backlog drains in the order things went stale, and so the
 * cap can never starve one source: whatever is skipped this pass is the freshest
 * of the due set and will be the oldest soon enough.
 */
export function selectDueSources(
  specs: CrawlSourceSpec[],
  rows: Map<string, CrawlSourceRow>,
  now: Date,
  cap: number,
): CrawlSourceSpec[] {
  return specs
    .filter((spec) => isDue(rows.get(spec.url)?.last_crawled ?? null, spec.cadence, now))
    .sort((a, b) => {
      const at = rows.get(a.url)?.last_crawled;
      const bt = rows.get(b.url)?.last_crawled;
      // Never crawled sorts first: it is infinitely stale.
      if (!at && !bt) return 0;
      if (!at) return -1;
      if (!bt) return 1;
      return new Date(at).getTime() - new Date(bt).getTime();
    })
    .slice(0, cap);
}

export interface CrawlSweepDeps {
  admin: SupabaseClient;
  aiServiceUrl: string;
  aiTimeoutMs?: number;
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  /** Injected for tests. Production uses the guarded fetcher. */
  fetchPage?: typeof fetchPageText;
  now?: () => Date;
  specs?: CrawlSourceSpec[];
}

export interface CrawlSweepResult {
  attempted: number;
  changed: number;
  unchanged: number;
  failed: number;
}

/**
 * Make sure every registry entry has a `knowledge_sources` row, and return them.
 *
 * Select-then-write rather than an upsert, because `knowledge_sources_url_idx` is
 * a PARTIAL unique index (`where url is not null`) and PostgREST's upsert cannot
 * name the predicate it would need to infer the conflict target.
 *
 * The label, authority and cadence follow the registry, so correcting an entry in
 * the file is enough. This is the one writer of those columns; the Python
 * ingester finds the row and never updates it, deliberately, so the two cannot
 * disagree about a source's freshness state.
 *
 * **Written only when they actually differ.** A pass runs on the tick interval,
 * not on the crawl cadence, so rewriting every row each time would be thousands
 * of identical updates a day against a table that changes when somebody edits a
 * file. The comparison is what makes this cheap enough to run every pass, which
 * is what keeps a newly-added registry entry from waiting for anything.
 */
async function ensureSourceRows(
  deps: CrawlSweepDeps,
  specs: CrawlSourceSpec[],
): Promise<Map<string, CrawlSourceRow>> {
  // An empty registry is a legitimate configuration (every entry removed while
  // a replacement is found), and `.in('url', [])` renders as `url=in.()`, which
  // PostgREST rejects. Returning early keeps "no sources" a quiet no-op rather
  // than an error the sweep would report as a fault.
  if (specs.length === 0) return new Map();

  const { data, error } = await deps.admin
    .from('knowledge_sources')
    .select('id, url, label, authority, crawl_cadence, last_crawled, content_hash')
    .in(
      'url',
      specs.map((s) => s.url),
    );
  if (error) throw error;

  type StoredRow = CrawlSourceRow & {
    url: string;
    label: string;
    authority: string;
    crawl_cadence: string | null;
  };

  const rows = new Map<string, CrawlSourceRow>();
  const stored = new Map<string, StoredRow>();
  for (const row of (data ?? []) as StoredRow[]) {
    stored.set(row.url, row);
    rows.set(row.url, {
      id: row.id,
      last_crawled: row.last_crawled,
      content_hash: row.content_hash,
    });
  }

  for (const spec of specs) {
    const existing = stored.get(spec.url);
    if (existing) {
      const cadence = cadenceToInterval(spec.cadence);
      const drifted =
        existing.label !== spec.label ||
        existing.authority !== spec.authority ||
        // Postgres renders an interval its own way ('7 days', '1 day'), so this
        // compares the rendered forms rather than assuming ours round-trips. A
        // mismatch in formatting costs one redundant update, never a wrong value.
        existing.crawl_cadence !== cadence;
      if (!drifted) continue;

      const { error: updateError } = await deps.admin
        .from('knowledge_sources')
        .update({ label: spec.label, authority: spec.authority, crawl_cadence: cadence })
        .eq('id', existing.id);
      if (updateError) {
        deps.log.error({ err: updateError, url: spec.url }, 'could not refresh a crawl source row');
      }
      continue;
    }

    const { data: created, error: insertError } = await deps.admin
      .from('knowledge_sources')
      .insert({
        url: spec.url,
        label: spec.label,
        authority: spec.authority,
        crawl_cadence: cadenceToInterval(spec.cadence),
      })
      .select('id')
      .single();
    if (insertError) {
      // Not fatal to the sweep. One source we cannot register must not stop the
      // others, and the next pass tries again.
      deps.log.error({ err: insertError, url: spec.url }, 'could not register a crawl source');
      continue;
    }
    rows.set(spec.url, {
      id: (created as { id: string }).id,
      last_crawled: null,
      content_hash: null,
    });
  }

  return rows;
}

/**
 * Read the due sources once.
 *
 * Best effort per source, exactly as a scheduler tick is per project: a page that
 * is blocked, moved, or rendered entirely in JavaScript must not stop the others,
 * and several of the registry's entries are expected to be exactly that. Every
 * failure is logged with its URL rather than swallowed (rule 16), because a
 * corpus that silently stopped growing looks identical to one that is up to date.
 */
export async function crawlSweep(deps: CrawlSweepDeps): Promise<CrawlSweepResult> {
  const specs = deps.specs ?? CRAWL_SOURCES;
  const fetchPage = deps.fetchPage ?? fetchPageText;
  const now = deps.now?.() ?? new Date();

  const rows = await ensureSourceRows(deps, specs);
  const due = selectDueSources(specs, rows, now, deps.maxPerPass);
  const result: CrawlSweepResult = { attempted: 0, changed: 0, unchanged: 0, failed: 0 };
  if (due.length === 0) return result;

  // The date we read the page. The honest claim a citation can make is when we
  // saw it, not when its publisher wrote it, which we do not reliably know.
  const readOn = now.toISOString().slice(0, 10);

  for (const spec of due) {
    const row = rows.get(spec.url);
    if (!row) continue;
    result.attempted += 1;

    try {
      const page = await fetchPage(spec.url, { userAgent: CRAWLER_USER_AGENT });
      const digest = hashPageText(page.text);

      if (digest === row.content_hash) {
        result.unchanged += 1;
        await stampAttempt(deps, row.id, null);
        continue;
      }

      const ingested = await requestIngest(
        deps.aiServiceUrl,
        {
          title: spec.title,
          text: page.text,
          sourceLabel: spec.label,
          sourceUrl: spec.url,
          authority: spec.authority,
          market: spec.market,
          businessType: spec.businessType,
          docType: spec.docType,
          effectiveDate: readOn,
          lang: spec.lang,
          agentRunId: `crawl:${spec.url}`,
        },
        deps.aiTimeoutMs,
      );

      // The hash is stored only after the ingest succeeded. Storing it first
      // would mean a failed ingest looks unchanged forever after, which is the
      // quietest possible way for a source to stop updating.
      await stampAttempt(deps, row.id, digest);
      result.changed += 1;
      deps.log.info(
        {
          url: spec.url,
          title: spec.title,
          chunks: ingested.chunks_written,
          superseded: ingested.superseded,
        },
        'crawled source ingested',
      );
    } catch (err) {
      result.failed += 1;
      // Stamped as attempted even though it failed, so a page that is blocked or
      // gone is retried on its cadence rather than on every pass.
      await stampAttempt(deps, row.id, null);
      deps.log.error({ err, url: spec.url, title: spec.title }, 'could not crawl a source');
    }
  }

  deps.log.info(result, 'crawl sweep complete');
  return result;
}

/** Record that we tried, and what we saw if we saw anything. */
async function stampAttempt(
  deps: CrawlSweepDeps,
  sourceId: string,
  contentHash: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { last_crawled: new Date().toISOString() };
  if (contentHash) patch.content_hash = contentHash;

  const { error } = await deps.admin.from('knowledge_sources').update(patch).eq('id', sourceId);
  if (error) {
    // Loud, because the consequence is specific: a source whose attempt was not
    // recorded is due again immediately, so this failing quietly turns the
    // cadence off for that page and points a tight retry loop at somebody.
    deps.log.error({ err: error, sourceId }, 'could not record a crawl attempt');
  }
}
