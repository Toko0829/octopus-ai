import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import './ops.css';
import { OpsConsole } from './OpsConsole';
import { createClient } from '../../lib/supabase/server';
import { fetchOpsDisputes, fetchOpsIdentity } from '../../lib/api-server';

export const metadata: Metadata = {
  title: 'Octopus · Dispute console',
};

export const dynamic = 'force-dynamic';

/**
 * The dispute console, and the first ops surface in this system.
 *
 * **A third surface rather than a section of either existing one**, on `/node`'s
 * reasoning taken one step further. `/app` is a workspace owner's room and
 * `/node` is an expert's own record; both render things about the person looking
 * at them. This renders other people's money, and the person looking at it is a
 * party to none of it. Putting it inside either shell would mean that shell
 * sometimes showed a third party's escrow, which is exactly the disclosure
 * boundary the rest of this repository spends its policies maintaining.
 *
 * ---------- Gated twice, differently, and neither is redundant ----------
 *
 * `middleware.ts` checks there is a session, because a signed-out visitor should
 * be sent to sign in rather than be told an ops surface exists and refused.
 *
 * This page then asks the API, because **being an operator is `profiles.role`
 * and nothing reaching the browser knows it**. The JWT does not carry it: the
 * verifier maps an unrecognised claim to `'user'` and Supabase mints
 * `role = 'authenticated'`, so a check written against the token would refuse
 * everybody and look like it worked. `/api/ops/me` reads the column with the
 * service key behind its own copy of this check, which is the one that actually
 * binds — every ops route re-checks, so a bug here leaks a page frame and no
 * data.
 *
 * A non-operator is **redirected to `/app` rather than shown a refusal**,
 * diverging from `/node`'s "you have not been invited yet" page. The difference
 * is what the two absences mean. Not being a node is a fact about somebody's
 * relationship with the marketplace that they may be waiting on, so it is worth
 * a sentence. Not being an operator is not something anybody is waiting on, and
 * a page explaining that staff tooling exists here is an invitation to try.
 */
export default async function OpsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in?next=/ops');

  // Null covers both "not an operator" (403) and a failed read, and deliberately
  // does not distinguish them: `get` folds a 403 into null the way it folds a
  // 404, and a page that said "we could not check" would be telling a stranger
  // there is something here to check.
  const identity = await fetchOpsIdentity();
  if (!identity) redirect('/app');

  // Fetched only once the caller is known to be an operator, so a stranger's
  // page load never reaches the queue at all. Empty rather than null on failure:
  // the console is worth rendering with its own empty state, which says the
  // queue could not be read rather than that there is nothing in it.
  const queue = await fetchOpsDisputes('open');

  return (
    <OpsConsole
      role={identity.role}
      email={user.email ?? null}
      initialDisputes={queue?.disputes ?? null}
    />
  );
}
