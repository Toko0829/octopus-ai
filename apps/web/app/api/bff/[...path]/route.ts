import { NextResponse, type NextRequest } from 'next/server';
import { getAccessToken } from '../../../../lib/supabase/server';

/**
 * The thin BFF. Forwards /api/bff/* to Fastify with the caller's access token
 * attached server-side from their session cookie.
 *
 * The cookies are not `httpOnly` (docs/30-modules/auth-identity.md), so this is not
 * about hiding the token from page scripts. It exists so the token is attached in
 * exactly one place, the browser never talks to Fastify directly, and the API origin
 * stays unexposed (docs/10-architecture/architecture.md: "reads/aggregates ·
 * PROXIES mutations"). It deliberately does no business logic: it adds auth and
 * relays. Anything heavier belongs in Fastify, and anything long-running belongs
 * in a durable task returning 202 + runId (AGENTS.md rule 4).
 */

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function proxy(request: NextRequest, path: string[]) {
  const token = await getAccessToken();
  if (!token) {
    return NextResponse.json({ error: 'unauthorized', message: 'Not signed in.' }, { status: 401 });
  }

  const target = new URL(`${API_URL}/api/${path.join('/')}`);
  request.nextUrl.searchParams.forEach((v, k) => target.searchParams.set(k, v));

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  /**
   * **The caller's own `Content-Type` is forwarded, not replaced.**
   *
   * This hardcoded `application/json` until slice 6, which was right while every
   * payload was JSON and became a silent corruption the moment one was not: a
   * multipart body carries its boundary **in the header**, so overwriting it
   * hands Fastify a body it cannot parse and a node's proof upload fails with a
   * parser error that names nothing about uploads. Defaulting to JSON when the
   * header is absent keeps every existing caller identical.
   */
  const contentType = request.headers.get('content-type');

  // Buffered rather than streamed: streaming needs `duplex: 'half'` and the caps
  // that make buffering safe are enforced upstream, where the refusal can be a
  // sentence (`MAX_PROOF_FILE_BYTES` in `apps/api/src/lib/proof.ts`).
  // `arrayBuffer` rather than `text` so bytes survive exactly, which is what a
  // multipart boundary needs and what `text` would have mangled.
  const raw = hasBody ? await request.arrayBuffer() : undefined;

  /**
   * **A verb that permits a body is not the same as a request that has one**, and
   * conflating them is what made every bodyless POST in this app fail.
   *
   * Deciding from the method alone forwards a zero-length body with a
   * `Content-Type` header, and Fastify refuses that combination before the
   * handler ever runs: `FST_ERR_CTP_EMPTY_JSON_BODY`. Several routes are written
   * to take no body at all and check `request.body !== undefined` themselves;
   * they never got the chance.
   *
   * Deciding from the payload means an empty POST forwards neither a body nor a
   * content-type, the parser is skipped, and those handlers see exactly the
   * `undefined` they were written against.
   */
  const hasPayload = raw !== undefined && raw.byteLength > 0;

  const init: RequestInit = {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      // The caller's own type, never one invented here: a multipart body carries
      // its boundary in this header, so overwriting it corrupts the request.
      ...(hasPayload && contentType ? { 'Content-Type': contentType } : {}),
    },
    body: hasPayload ? raw : undefined,
    cache: 'no-store',
  };

  try {
    const upstream = await fetch(target, init);
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json' },
    });
  } catch (err) {
    // The API being down must not surface as an opaque 500 with no trace.
    console.error('[bff] upstream request failed', { target: target.pathname, err });
    return NextResponse.json(
      { error: 'upstream_unavailable', message: 'The API is not reachable.' },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

/**
 * Setting a project's budget ceiling is the first PATCH this proxy carries.
 *
 * Exported explicitly rather than by widening `proxy`, because a Next route
 * handler answers 405 for any verb it does not export: adding the method to the
 * contract and the client without this line produces a failure in the browser
 * that names nothing on the server, which is a long afternoon.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}

/**
 * Disconnecting a channel account is the first DELETE, and it walked straight
 * into the trap the note above describes.
 *
 * Worth keeping both lines rather than merging them into one comment about
 * verbs: the PATCH note was written as a warning and this is the warning coming
 * true one slice later, which is a better argument for reading it than the
 * warning was.
 */
export async function DELETE(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  return proxy(request, (await ctx.params).path);
}
