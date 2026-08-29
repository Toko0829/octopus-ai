import { FakeConsent } from './FakeConsent';
import '../consent.css';

/**
 * The fake provider's consent screen.
 *
 * **This page stands in for somebody else's authorization server**, and it is
 * the only part of the connect flow that a real provider replaces entirely. It
 * exists so the whole three-legged round trip can be exercised without an ad
 * account anywhere: a person is sent away, decides, and comes back with a code
 * or with a refusal.
 *
 * The refusal is the reason it is a real screen rather than an immediate
 * redirect. `access_denied` is the arm that never gets written and never gets
 * tested, and the cheapest way to make sure it works is to make it something a
 * person can actually click.
 *
 * Scopes are tickable for the same reason: `granted_scopes` exists because a
 * platform grants what it chooses rather than what was asked, and a fake that
 * always granted everything would leave `checkScopes` exercised only by unit
 * tests.
 *
 * A server component reading `searchParams`, handing them to a client island,
 * so nothing here needs `useSearchParams` or a Suspense boundary around it.
 */
export default async function FakeConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  return (
    <FakeConsent
      state={one('state') ?? ''}
      redirectUri={one('redirect_uri') ?? ''}
      scopes={(one('scope') ?? '').split(',').filter(Boolean)}
    />
  );
}
