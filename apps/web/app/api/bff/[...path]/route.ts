import { NextResponse, type NextRequest } from 'next/server';
import { getAccessToken } from '../../../../lib/supabase/server';

/**
 * The thin BFF. Forwards /api/bff/* to Fastify with the caller's access token
 * attached from their httpOnly session cookie.
 *
 * This exists so the browser never holds a bearer token and never talks to
 * Fastify directly (docs/10-architecture/architecture.md: "reads/aggregates ·
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

  const init: RequestInit = {
    method: request.method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // Streaming a body would need duplex: 'half'; these payloads are small.
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
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
