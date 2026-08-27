/**
 * Fetching a page the user pointed us at, so its text can become a source.
 *
 * **This is the first outbound network call either service makes on a user's
 * instruction**, which is why it is guarded rather than a bare `fetch`. Every
 * other outbound call in this system goes to a provider we chose; this one goes
 * wherever somebody typed. That is server-side request forgery in its ordinary
 * form: the request originates inside our network, so it reaches things the
 * caller cannot, including cloud metadata endpoints and anything on localhost.
 *
 * It lives in Node rather than in `services/ai` deliberately. The Python service
 * talks to Postgres and to model providers and to nothing else, and adding a
 * general fetch to it would widen the component that holds the secret key.
 *
 * **What is guarded, and what is honestly not.** Protocol, host, size, time and
 * content type are checked. DNS rebinding is NOT defended against: the hostname
 * is resolved once by the guard and again by `fetch`, and a hostile resolver can
 * answer differently the second time. Closing that needs resolve-then-connect
 * against a pinned address, which Node's fetch does not expose. Recorded here as
 * a known limit rather than left for a reader to assume it was handled.
 */

/** Hosts that are never a customer's website, and are often somebody's secrets. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  // The AWS/GCP/Azure link-local metadata address. The single most common SSRF
  // target, and reachable from any container that can make an outbound request.
  '169.254.169.254',
  'metadata.google.internal',
]);

/** Private and link-local ranges, checked when the host is a bare IPv4 literal. */
const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export class UnsafeUrlError extends Error {}

/**
 * Parse and vet a URL the user supplied.
 *
 * Throws `UnsafeUrlError` with a sentence a person can act on, because this
 * message is posted into their room. "Invalid URL" tells them nothing; naming
 * the rule tells them what to change.
 */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError(
      'That does not look like a web address. Include https:// at the start.',
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, data: and gopher: are the classic escapes out of "it is just a URL".
    throw new UnsafeUrlError('Only http and https addresses can be read.');
  }

  const host = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('That address points inside a private network, so it cannot be read.');
  }

  if (PRIVATE_IPV4.test(host) || host.startsWith('[')) {
    // IPv6 literals are refused wholesale rather than range-checked. A public
    // site is reachable by name, and parsing IPv6 scopes correctly to admit a
    // rare case is more surface than the case is worth.
    throw new UnsafeUrlError('That address points inside a private network, so it cannot be read.');
  }

  return url;
}

/**
 * Turn a fetched HTML page into something worth embedding.
 *
 * Hand-rolled rather than pulled from a dependency, per rule 20. A parser would
 * do this better in the general case; what is needed here is narrow, and thirty
 * lines that can be read in full is a smaller liability than a transitive tree
 * for one call site. If pages start arriving mangled, that measurement is the
 * argument for a real parser, and it is not one worth pre-empting.
 */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]!).trim().slice(0, 140) : null;

  const text = decodeEntities(
    html
      // Script and style carry no prose and a great deal of noise, and their
      // contents would otherwise survive tag-stripping as raw code.
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Block-level boundaries become paragraph breaks so the chunker, which
      // splits on structure first, still has structure to work with.
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    // Spaces hugging a line break, which `<p>One.</p><p>Two.</p>` produces:
    // the closing tag becomes the break and the opening tag becomes a space
    // immediately after it. Left in, every paragraph starts with one.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

/** The handful of entities that actually appear in prose. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export interface FetchedPage {
  title: string | null;
  text: string;
  url: string;
}

export interface FetchPageOptions {
  /**
   * Identify the crawler to the site being read.
   *
   * Only the scheduled sweep sets this. A page a person pasted is one request
   * they asked for, and announcing ourselves there says nothing useful; a sweep
   * returning to the same host on a cadence is a crawler, and a crawler that
   * will not say who it is is one an operator can only block.
   */
  userAgent?: string;
}

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

/**
 * Fetch a page and return its readable text.
 *
 * Bounded on every axis that can be made unbounded by a hostile or merely large
 * target: time, size, and content type. The size cap is enforced while reading
 * rather than from `content-length`, because a server is free to lie about that
 * or omit it.
 */
export async function fetchPageText(
  raw: string,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const url = assertSafeUrl(raw);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // No credentials, and a redirect chain is followed by fetch but every hop
      // lands back here as the final URL, which is re-vetted below.
      redirect: 'follow',
      headers: {
        accept: 'text/html,text/plain',
        // Ask for English. Not cosmetic: a large site picks a language from the
        // requesting IP when nothing says otherwise, and the first crawl stored a
        // Facebook page as a menu in Georgian because that is where the machine
        // running it happened to be. A corpus whose language depends on where the
        // crawler sits is a corpus nobody can reason about, and the row would
        // still have claimed `lang: english`, so the sparse index would have been
        // built with the wrong text-search configuration on top of it.
        'accept-language': 'en',
        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
      },
    });

    if (!res.ok) {
      throw new UnsafeUrlError(`That page returned ${res.status}, so there was nothing to read.`);
    }

    // A redirect can leave the safe origin entirely, which is how a public
    // shortener becomes a request to localhost.
    assertSafeUrl(res.url || url.toString());

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new UnsafeUrlError(
        'That address is not a web page, so there is no text to read. A PDF or a document cannot be read yet.',
      );
    }

    const body = await readCapped(res);
    const isHtml = contentType.includes('text/html');
    const parsed = isHtml ? htmlToText(body) : { title: null, text: body.trim() };

    if (parsed.text.length < 200) {
      // Almost always a page that renders its content with JavaScript. Saying so
      // is more useful than storing three words and calling it a source.
      throw new UnsafeUrlError(
        'There was very little text on that page. If the site builds its content in the browser, paste the description instead.',
      );
    }

    return { title: parsed.title, text: parsed.text, url: res.url || url.toString() };
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new UnsafeUrlError('That page took too long to respond.');
    }
    throw new UnsafeUrlError('That page could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

/** Read the body, stopping at the cap rather than buffering whatever arrives. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new UnsafeUrlError('That page is too large to read.');
    }
    chunks.push(value);
  }

  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}
