'use client';

import { useEffect, useState } from 'react';
import type { ProjectDetail, ProjectSummary, Task, TaskState } from '@octopus/contracts';
import { getProject, getProjects, requestReplan, resolveStep } from '../../lib/api-client';

/**
 * What happened after a plan was approved.
 *
 * The workflow engine had no surface at all before this. A person approved a
 * plan, the scheduler routed its steps, the executor wrote artifacts, and the
 * only evidence was a handful of cards scattered through a chat stream that
 * keeps scrolling. The artifact card fixed "this one step delivered something";
 * this fixes "where is the whole thing up to", which is the question people
 * actually ask and the one nothing could answer.
 *
 * Four rules, three of them inherited from the plan and artifact cards because
 * they are the same rules applied to a different view of the same work.
 *
 * **Every state is named in words.** Never colour alone (rule 15). A dot carries
 * the same meaning as the label beside it and is decoration, not information.
 *
 * **Waiting and escalated are separated, and the copy for escalated is honest.**
 * A step waiting on the person is something they can act on; a step escalated to
 * an expert is waiting on a marketplace that does not exist yet. Presenting the
 * second as work in progress would be a false statement on a surface built to be
 * trusted, so it says plainly that nobody can pick it up.
 *
 * **Nothing renders that the engine did not produce.** No percentages invented
 * from stage order, no estimated finish dates. Counts are counted.
 *
 * **An uncited deliverable is labelled.** Rule 10 again: uncited work must not
 * pass as grounded merely because it is displayed in the same place as work that
 * is grounded.
 */

interface Props {
  roomId: string;
  /**
   * Whether the viewer owns this workspace. Only the owner can resolve a step,
   * and hiding the controls from everyone else is presentation: the server
   * re-checks ownership on every call, so a forged one is simply refused.
   */
  canAct: boolean;
  onClose: () => void;
}

/**
 * How each state reads to a person, and whether it is finished.
 *
 * The marketplace states are here with no code behind them for the same reason
 * they are in the state machine: it is specified in full, and a view that shows
 * a raw enum value the day the matcher lands is a view nobody updated.
 */
const STATE_COPY: Record<
  TaskState,
  { label: string; tone: 'done' | 'active' | 'waiting' | 'stopped' }
> = {
  pending: { label: 'Not started', tone: 'active' },
  ready: { label: 'Ready to run', tone: 'active' },
  routing: { label: 'Being assigned', tone: 'active' },
  ai_running: { label: 'Octopus is working on it', tone: 'active' },
  ai_self_check: { label: 'Being checked', tone: 'active' },
  escalated: { label: 'Needs an expert', tone: 'waiting' },
  needs_user: { label: 'Waiting on you', tone: 'waiting' },
  matching: { label: 'Finding an expert', tone: 'waiting' },
  offered: { label: 'Offered to an expert', tone: 'waiting' },
  claimed: { label: 'An expert took it', tone: 'active' },
  escrow_funded: { label: 'Funded', tone: 'active' },
  in_progress: { label: 'An expert is working on it', tone: 'active' },
  proof_submitted: { label: 'Proof submitted', tone: 'active' },
  in_review: { label: 'Being reviewed', tone: 'active' },
  approved: { label: 'Done', tone: 'done' },
  payout_pending: { label: 'Done, payment pending', tone: 'done' },
  paid: { label: 'Done and paid', tone: 'done' },
  done: { label: 'Done', tone: 'done' },
  rejected: { label: 'Sent back', tone: 'stopped' },
  disputed: { label: 'Disputed', tone: 'stopped' },
  failed: { label: 'Failed', tone: 'stopped' },
  cancelled: { label: 'Cancelled', tone: 'stopped' },
  blocked: { label: 'Blocked', tone: 'stopped' },
};

const OWNER_COPY: Record<Task['ownerType'], string> = {
  ai: 'Octopus',
  human: 'An expert',
  user: 'You',
};

function describeState(state: TaskState) {
  return STATE_COPY[state] ?? { label: state.replace(/_/g, ' '), tone: 'active' as const };
}

export function ProjectPanel({ roomId, canAct, onClose }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getProjects(roomId)
      .then((res) => {
        if (!live) return;
        setProjects(res.projects);
        // One project is the common case, so open it rather than making somebody
        // click through a list of one.
        const only = res.projects.length === 1 ? res.projects[0] : undefined;
        if (only) setOpenId(only.id);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'Could not load the work.');
      });
    return () => {
      live = false;
    };
  }, [roomId]);

  /**
   * Bumped after a step is resolved, to re-read the project.
   *
   * The whole panel is re-fetched rather than the one row patched in place,
   * because resolving a step can move others: an approved step satisfies its
   * dependents, and a retry can run the executor and produce an artifact. Patching
   * the row that was clicked would leave every consequence of the click stale,
   * which on a progress view is the same defect as showing nothing.
   */
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let live = true;
    getProject(openId)
      .then((res) => {
        if (live) setDetail(res);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load that project.');
      });
    return () => {
      live = false;
    };
  }, [openId, refresh]);

  return (
    <div className="cmdk-scrim" role="dialog" aria-modal="true" aria-label="Work in this workspace">
      <div className="work-panel">
        <header className="work-head">
          <h2 className="work-title">The work</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        {error && (
          <p className="work-error" role="alert">
            {error}
          </p>
        )}

        {/* Loading and empty are different answers and are never collapsed into
            one. "Nothing here" while a request is still in flight is a false
            statement, and this whole panel exists because an absent surface was
            indistinguishable from an idle system. */}
        {!error && projects === null && <p className="work-empty">Loading.</p>}

        {!error && projects !== null && projects.length === 0 && (
          <p className="work-empty">
            No plans have been approved here yet. Post a goal in the chat, then approve the plan
            Octopus comes back with, and the steps will show up here.
          </p>
        )}

        {projects !== null && projects.length > 0 && (
          <ul className="work-projects">
            {projects.map((p) => {
              const open = p.id === openId;
              return (
                <li key={p.id} className={open ? 'work-project open' : 'work-project'}>
                  <button
                    type="button"
                    className="work-project-head"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : p.id)}
                  >
                    <span className="work-goal">{p.goal}</span>
                    <span className="work-counts mono">
                      {p.doneCount} of {p.taskCount} done
                    </span>
                  </button>

                  <p className="work-flags">
                    {p.waitingOnYou > 0 && (
                      <span className="work-flag waiting">{p.waitingOnYou} waiting on you</span>
                    )}
                    {p.escalated > 0 && (
                      <span className="work-flag escalated">
                        {p.escalated} needs an expert, and none can be brought in yet
                      </span>
                    )}
                    {p.artifactCount > 0 && (
                      <span className="work-flag delivered">
                        {p.artifactCount} {p.artifactCount === 1 ? 'deliverable' : 'deliverables'}
                      </span>
                    )}
                  </p>

                  {open && detail === null && <p className="work-empty">Loading the steps.</p>}
                  {open && detail !== null && detail.id === p.id && (
                    <>
                      <TaskList
                        tasks={detail.tasks}
                        projectId={detail.id}
                        canAct={canAct}
                        onResolved={() => setRefresh((n) => n + 1)}
                      />
                      {canAct && <RequestReplan projectId={detail.id} />}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function TaskList({
  tasks,
  projectId,
  canAct,
  onResolved,
}: {
  tasks: Task[];
  projectId: string;
  canAct: boolean;
  onResolved: () => void;
}) {
  if (tasks.length === 0) {
    // A project whose plan was approved but whose first tick has not run yet.
    // Saying so beats an empty box that reads as a failure.
    return <p className="work-empty">The steps have not been created yet.</p>;
  }
  return (
    <ol className="work-tasks">
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          projectId={projectId}
          canAct={canAct}
          onResolved={onResolved}
        />
      ))}
    </ol>
  );
}

function TaskRow({
  task,
  projectId,
  canAct,
  onResolved,
}: {
  task: Task;
  projectId: string;
  canAct: boolean;
  onResolved: () => void;
}) {
  const [showWork, setShowWork] = useState(false);
  const state = describeState(task.state);
  const delivered = task.artifacts.length > 0;
  const stuck = task.state === 'needs_user' || task.state === 'escalated';

  return (
    <li className="work-task">
      <div className="work-task-head">
        <span className={`work-state ${state.tone}`}>
          {/* Decoration only. The label beside it carries the meaning, so a
              reader who cannot distinguish the colours loses nothing. */}
          <span className="work-dot" aria-hidden />
          {state.label}
        </span>
        {task.stage && <span className="work-stage">{task.stage}</span>}
      </div>

      <p className="work-task-title">{task.title}</p>

      <p className="work-task-meta mono">
        {OWNER_COPY[task.ownerType]}
        {task.riskTier === 'high_risk' && <span className="work-risk"> · Needs your approval</span>}
        {task.riskTier === 'external' && (
          <span className="work-risk"> · Uses an outside service</span>
        )}
      </p>

      {canAct && stuck && <ResolveStep task={task} projectId={projectId} onResolved={onResolved} />}

      {delivered && (
        <>
          <button
            type="button"
            className="work-toggle"
            aria-expanded={showWork}
            onClick={() => setShowWork((v) => !v)}
          >
            {showWork ? 'Hide what it produced' : 'Show what it produced'}
          </button>
          {showWork &&
            task.artifacts.map((artifact) => (
              <article key={artifact.id} className="work-artifact">
                {artifact.title && <h4 className="work-artifact-title">{artifact.title}</h4>}
                {artifact.body && (
                  <div className="work-artifact-body">
                    {artifact.body.split(/\n{2,}/).map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                )}
                {artifact.storagePath && !artifact.body && (
                  <p className="work-empty">This one is a file rather than text.</p>
                )}
                {artifact.citations.length > 0 ? (
                  <p className="work-artifact-sources">
                    <span className="work-artifact-sources-label">Sources</span>
                    {/* Deduplicated: citations are per chunk and one document
                        usually contributes several, so listing them raw shows
                        one source three times and reads as three sources
                        agreeing. */}
                    {[...new Set(artifact.citations)].join(' · ')}
                  </p>
                ) : (
                  <p className="work-artifact-unverified">
                    No sources are cited for this, so treat it as unverified.
                  </p>
                )}
              </article>
            ))}
        </>
      )}
    </li>
  );
}

/**
 * Doing a stuck step yourself, or asking for another attempt.
 *
 * The two states differ in what is on offer, and the copy says why rather than
 * presenting one generic control:
 *
 * **`needs_user`** is the plan asking a question only this person can answer, so
 * the only thing to do is answer it.
 *
 * **`escalated`** is work the plan assigned to an expert. There is no marketplace,
 * so the honest offer is "do it yourself" plus "try again", and the second is
 * worth taking only when something changed, such as a source that was missing.
 * The copy says that plainly instead of implying a retry is itself the fix, and
 * it does not pretend an expert is coming.
 */
function ResolveStep({
  task,
  projectId,
  onResolved,
}: {
  task: Task;
  projectId: string;
  onResolved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'answer' | 'retry'>(null);
  const [error, setError] = useState<string | null>(null);
  const escalated = task.state === 'escalated';

  async function run(action: 'answer' | 'retry') {
    setBusy(action);
    setError(null);
    try {
      await resolveStep(projectId, task.id, action === 'answer' ? { action, text } : { action });
      onResolved();
    } catch (err) {
      // Kept on screen with their text intact. A failed submit that discards what
      // somebody wrote is the fastest way to lose their trust in the button.
      setError(err instanceof Error ? err.message : 'That did not go through.');
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="work-resolve">
        <button type="button" className="work-action" onClick={() => setOpen(true)}>
          {escalated ? 'I will do this one' : 'Answer this'}
        </button>
        {escalated && (
          <button
            type="button"
            className="work-action quiet"
            disabled={busy !== null}
            onClick={() => void run('retry')}
          >
            {busy === 'retry' ? 'Trying again' : 'Try again'}
          </button>
        )}
        {error && (
          <p className="work-resolve-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="work-resolve">
      <label className="work-resolve-label" htmlFor={`resolve-${task.id}`}>
        {escalated
          ? 'What did you do? I will record it against this step and carry on with what it unblocks.'
          : 'Your answer. I will record it against this step and carry on with what it unblocks.'}
      </label>
      <textarea
        id={`resolve-${task.id}`}
        className="work-resolve-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        disabled={busy !== null}
      />
      {error && (
        <p className="work-resolve-error" role="alert">
          {error}
        </p>
      )}
      <div className="work-resolve-actions">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setOpen(false)}
          disabled={busy !== null}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void run('answer')}
          disabled={busy !== null || text.trim().length === 0}
        >
          {busy === 'answer' ? 'Recording' : 'Record it'}
        </button>
      </div>
    </div>
  );
}

/**
 * Asking for the plan itself to be changed.
 *
 * The panel could already unstick one step; nothing could say "this plan is
 * wrong". Without it the only way to change direction was to abandon the project
 * and post a new goal, which throws away every deliverable already produced.
 *
 * **It produces a card, and the card is where the change happens.** This button
 * asks; approving the diff in the chat is what applies it, through the same
 * embed-action route a plan approval goes through. So the copy promises a
 * proposal rather than an edit, because that is what it does.
 */
function RequestReplan({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await requestReplan(projectId, reason.trim());
      setSent(true);
      setOpen(false);
    } catch (err) {
      // The reason stays on screen. It is the person's writing, and a failed
      // submit that discards it is the fastest way to lose trust in the button.
      setError(err instanceof Error ? err.message : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="work-resolve-label">
        Working out what to change. The suggestion will arrive in the chat as a card, and nothing
        changes until you approve it.
      </p>
    );
  }

  if (!open) {
    return (
      <div className="work-resolve">
        <button type="button" className="work-action" onClick={() => setOpen(true)}>
          Change this plan
        </button>
        {error && (
          <p className="work-resolve-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="work-resolve">
      <label className="work-resolve-label" htmlFor={`replan-${projectId}`}>
        What should change, and why? I will come back with a specific set of changes for you to
        approve. Nothing is altered until you do.
      </label>
      <textarea
        id={`replan-${projectId}`}
        className="work-resolve-input"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        disabled={busy}
        placeholder="I do not want to run paid ads. Focus on SEO and email instead."
      />
      {error && (
        <p className="work-resolve-error" role="alert">
          {error}
        </p>
      )}
      <div className="work-resolve-actions">
        <button type="button" className="btn-ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void send()}
          disabled={busy || reason.trim().length === 0}
        >
          {busy ? 'Working it out' : 'Suggest changes'}
        </button>
      </div>
    </div>
  );
}
