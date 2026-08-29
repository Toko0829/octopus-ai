import { ConnectionCallback } from './ConnectionCallback';
import '../consent.css';

/**
 * Where a platform sends the browser back.
 *
 * **This lands on the web origin rather than on the API, and that is
 * [ADR-0012](../../../../../docs/40-adr/0012-oauth-callback-on-the-web-origin.md).**
 * A platform redirects a browser, and this browser is carrying the person's
 * session cookie, so terminating here means the party finishing the flow is
 * provably the signed-in user and the API can bind the signed `state` to them.
 * Terminating at Fastify would have created the only unauthenticated mutating
 * route in the system, holding nothing but the state parameter.
 *
 * It is also the half that is hard to change later: a registered redirect URI
 * lives in a provider's dashboard, so choosing the wrong origin now is a
 * migration through somebody else's console.
 */
export default async function ConnectionCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return <ConnectionCallback state={one('state') ?? ''} code={one('code')} error={one('error')} />;
}
