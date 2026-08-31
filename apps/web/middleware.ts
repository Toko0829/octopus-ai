import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the Supabase session on every request and gates the workspace.
 *
 * Server Components cannot write cookies, so a rotated refresh token has to be
 * persisted here or the session silently expires mid-visit.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // getUser() revalidates against the auth server; getSession() alone trusts the
  // cookie and would happily accept a forged one.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const gated =
    request.nextUrl.pathname.startsWith('/app') || request.nextUrl.pathname.startsWith('/node');

  if (!user && gated) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = '/sign-in';
    signIn.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }

  if (user && request.nextUrl.pathname === '/sign-in') {
    const workspace = request.nextUrl.clone();
    workspace.pathname = '/app';
    workspace.search = '';
    return NextResponse.redirect(workspace);
  }

  return response;
}

export const config = {
  // `/node` is gated the same way `/app` is. It is a signed-in surface for a
  // person somebody invited, not a public sign-up: the invite is a row only an
  // operator can create, so there is nothing here for a stranger to reach.
  matcher: ['/app/:path*', '/node/:path*', '/sign-in', '/api/bff/:path*'],
};
