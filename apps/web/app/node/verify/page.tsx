import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { FakeVerification } from './FakeVerification';
import '../../connections/consent.css';
import { createClient } from '../../../lib/supabase/server';

export const metadata: Metadata = {
  title: 'Octopus · Identity check',
};

export const dynamic = 'force-dynamic';

/**
 * The built-in verifier's own screen.
 *
 * **This page stands in for a real identity provider's hosted flow**, and it is
 * the part that Persona or Stripe Identity replaces entirely. The precedent is
 * `/connections/fake-consent`, which exists so the whole OAuth round trip can be
 * exercised without an ad account, and it is here for the same reason plus one
 * more.
 *
 * The extra reason is that **every arc of the KYC lifecycle needs a writer**.
 * `20260902120000` lands five transitions, and three of them (`pending` to
 * `rejected`, `pending` back to `unverified`, and the resubmission out of
 * `rejected`) are only reachable if a check can come back as something other
 * than a pass. A fake that always passed would leave those as transitions
 * nothing could make, which is the exact defect the map was deferred to avoid.
 * So the outcome is a thing a person clicks, the way Cancel on the consent
 * screen is.
 *
 * It reuses `consent.css` deliberately: this is the same kind of trust surface,
 * quiet on purpose, and the moment somebody is handing over identity is not the
 * moment for an interface with opinions.
 */
export default async function NodeVerifyPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in?next=/node/verify');

  return <FakeVerification />;
}
