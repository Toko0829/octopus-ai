import { OctopusMark } from './icons';
import { SignOutButton } from './SignOutButton';
import { CreateRoom } from './CreateRoom';

/**
 * Shown when the signed-in account belongs to no rooms. Creating a room is the
 * orchestrator's job when a goal is posted (docs/00-overview/core-loop.md step 3),
 * and that lands in Phase 2, so this state is honest about where things stand
 * instead of faking a workspace.
 */
export function EmptyWorkspace({
  reachedApi,
  email,
  apiUrl,
}: {
  reachedApi: boolean;
  email: string | null;
  /** Where the server actually looked. Naming a fixed port here misleads whenever
      API_URL is overridden, which is exactly when this message gets read. */
  apiUrl: string;
}) {
  return (
    <main className="empty-wrap">
      <div className="empty-card">
        <OctopusMark width={30} height={30} />
        <h1 className="empty-title">{reachedApi ? 'No workspaces yet' : 'Cannot reach the API'}</h1>
        <p className="empty-body">
          {reachedApi ? (
            <>
              You are signed in{email ? ` as ${email}` : ''}, and this account is not in any
              workspace yet. Create one to start. The agent will create these for you once the
              orchestrator lands in Phase 2.
            </>
          ) : (
            <>
              The workspace could not load because the API at <code>{apiUrl}</code> did not respond.
              Start it with <code>pnpm --filter @octopus/api dev</code>. If that port is taken by
              something else, set <code>API_PORT</code> in <code>apps/api/.env</code> and a matching{' '}
              <code>API_URL</code> in <code>apps/web/.env.local</code>, then restart both.
            </>
          )}
        </p>
        {reachedApi && <CreateRoom />}
        <SignOutButton />
      </div>
    </main>
  );
}
