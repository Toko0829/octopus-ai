import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import './node.css';
import { NodeConsole } from './NodeConsole';
import { createClient } from '../../lib/supabase/server';
import { fetchNode, fetchNodeEngagements, fetchNodeOffers } from '../../lib/api-server';

export const metadata: Metadata = {
  title: 'Octopus · Your node profile',
};

export const dynamic = 'force-dynamic';

/**
 * Where an invited expert manages their own record.
 *
 * **A separate surface from `/app` rather than a panel inside it**, because the
 * two answer to different people. `/app` is a workspace owner's room: a project
 * DAG, a budget, campaigns, the conversation with the AI. A node is admitted to
 * a task thread and to nothing else, and `20260901122000` spent four migrations
 * making sure of it. Putting their profile inside the owner's shell would have
 * meant rendering that shell for somebody who can see almost none of it.
 *
 * **There is no sign-up here and no route that could create one.** A node exists
 * because an operator ran `scripts/invite-node.mjs`, which is the cold-start
 * decision in docs/30-modules/human-nodes-marketplace.md: "an empty marketplace
 * with three invited notaries is a decision; an empty marketplace with a public
 * sign-up form is a dead end." So a signed-in person with no record is told
 * plainly that they have not been invited, rather than being offered a form that
 * would strand them.
 */
export default async function NodePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/sign-in?next=/node');

  const result = await fetchNode();

  // Null covers two cases and deliberately does not distinguish them: the API
  // answers 404 both to somebody who was never invited and to a caller whose
  // read failed. Whether a person is a node is not something a page should
  // speculate about out loud.
  if (!result) {
    return (
      <main className="node">
        <p className="node-eyebrow">Octopus marketplace</p>
        <h1 className="node-title">You have not been invited yet</h1>
        <p className="node-body">
          Expert accounts are opened by the Octopus team, one at a time, while the marketplace is
          being built. There is nothing to fill in here.
        </p>
        <p className="node-body">
          If you are expecting an invitation, reply to whoever contacted you. If you are here to run
          your own business on Octopus, your workspace is at <a href="/app">the app</a>.
        </p>
      </main>
    );
  }

  // Fetched only once the caller is known to be a node, so a stranger's page
  // load never reaches the offers route at all. Null on failure rather than a
  // thrown error: a console that cannot list offers is still worth rendering,
  // because the profile it also shows is what most visits are for.
  // Both lists, in parallel, for the same reason and with the same fallback: a
  // console that cannot list one of them is still worth rendering.
  const [offerResult, engagementResult] = await Promise.all([
    fetchNodeOffers(),
    fetchNodeEngagements(),
  ]);
  const offers = offerResult?.offers ?? [];
  const engagements = engagementResult?.engagements ?? [];

  return (
    <NodeConsole
      initial={result.node}
      initialOffers={offers}
      initialEngagements={engagements}
      email={user.email ?? null}
    />
  );
}
