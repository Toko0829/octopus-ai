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
}: {
  reachedApi: boolean;
  email: string | null;
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
              The workspace could not load because the API did not respond. Check that it is running
              on port 3001, then reload.
            </>
          )}
        </p>
        {reachedApi && <CreateRoom />}
        <SignOutButton />
      </div>
    </main>
  );
}
