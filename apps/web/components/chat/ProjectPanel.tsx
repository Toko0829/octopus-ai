'use client';

import { useEffect, useState } from 'react';
import type {
  CampaignSummary,
  ProjectDetail,
  ProjectSummary,
  Task,
  TaskState,
} from '@octopus/contracts';
import {
  getArtifactFileUrl,
  getProject,
  getProjects,
  requestReplan,
  resolveStep,
  resumeCampaign,
  setCampaignCpaCeiling,
  setProjectBudget,
} from '../../lib/api-client';

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

/**
 * How a campaign's state reads to the person paying for it.
 *
 * All eight, including the ones only a later slice can reach, on `STATE_COPY`'s
 * reasoning: the machine is specified in full in Postgres, and a view that shows
 * a raw enum value the day something first reaches `completed` is a view nobody
 * updated.
 *
 * **`publishing` deliberately does not say "live".** The campaign machine keeps
 * the two apart because claiming a platform confirmed something it has not is an
 * untrue sentence in the audit trail, and it would be the same untrue sentence
 * here, on the surface where somebody decides whether their money is moving.
 */
const CAMPAIGN_STATE_COPY: Record<
  CampaignSummary['state'],
  { label: string; tone: 'done' | 'active' | 'waiting' | 'stopped' }
> = {
  draft: { label: 'Not authorised yet', tone: 'waiting' },
  ready: { label: 'Approved, publishing shortly', tone: 'active' },
  publishing: { label: 'Being sent to the platform', tone: 'active' },
  live: { label: 'Live', tone: 'done' },
  paused: { label: 'Paused', tone: 'waiting' },
  completed: { label: 'Finished', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'stopped' },
  failed: { label: 'Could not be published', tone: 'stopped' },
};

const CHANNEL_COPY: Record<CampaignSummary['channel'], string> = {
  meta: 'Meta',
  google: 'Google',
  email: 'Email',
  organic_social: 'Organic social',
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
                      <span className="work-flag escalated">{p.escalated} needs an expert</span>
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
                      <Budget
                        detail={detail}
                        canAct={canAct}
                        onChanged={() => setRefresh((n) => n + 1)}
                      />
                      <Campaigns
                        campaigns={detail.campaigns}
                        currency={detail.currency}
                        projectId={detail.id}
                        canAct={canAct}
                        onChanged={() => setRefresh((n) => n + 1)}
                      />
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

/**
 * What the owner has authorised, what is committed against it, and what is left.
 *
 * **This exists because the number had no writer.** `projects.budget_ceiling` was
 * added with the workflow schema and nothing in the product ever set it, so
 * `checkSpendCap` would have refused every campaign forever with
 * `no_ceiling_authorised`. A guard whose input nothing supplies is the defect this
 * repository has now paid for twice.
 *
 * **Null is shown as "nothing authorised", never as "no limit".** That is the
 * column's documented stance and the one the spend check enforces. A panel
 * rendering an empty ceiling as unlimited would describe an open account.
 *
 * The three figures are the same arithmetic the approval performs: committed
 * counts non-terminal campaigns with a cap, so what a person reads here is what
 * the check will do rather than a friendlier version of it.
 */
function Budget({
  detail,
  canAct,
  onChanged,
}: {
  detail: ProjectDetail;
  canAct: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ceiling = detail.budgetCeiling;
  const available = ceiling === null ? null : ceiling - detail.committedBudget;

  async function save(next: number | null) {
    setBusy(true);
    setError(null);
    try {
      await setProjectBudget(detail.id, next);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the budget.');
    } finally {
      setBusy(false);
    }
  }

  const typed = value.trim();
  const parsed = typed === '' ? Number.NaN : Number(typed);
  const valid = Number.isFinite(parsed) && parsed >= 0;

  return (
    <div className="work-budget">
      <div className="work-budget-figures">
        <span className="work-budget-figure">
          <span className="work-budget-label">Authorised</span>
          <span className="mono">
            {ceiling === null ? 'Nothing yet' : `${ceiling} ${detail.currency}`}
          </span>
        </span>
        <span className="work-budget-figure">
          <span className="work-budget-label">Committed</span>
          <span className="mono">
            {detail.committedBudget} {detail.currency}
          </span>
          {/* Broken out rather than folded away, because the two halves settle
              on different clocks: a campaign cap frees up when the campaign
              ends, and a hold frees up when the step is finished or stopped.
              An owner looking at a number they cannot reduce needs to know
              which half is which (ADR-0020). */}
          {detail.escrowHeld > 0 && (
            <span className="work-budget-sub">
              of which <span className="mono">{detail.escrowHeld}</span> held in escrow
            </span>
          )}
        </span>
        <span className="work-budget-figure">
          <span className="work-budget-label">Available</span>
          <span className="mono">
            {available === null ? 'Nothing yet' : `${available} ${detail.currency}`}
          </span>
        </span>
      </div>

      {ceiling === null && (
        <p className="work-empty">
          No campaign can be approved until you authorise a budget for this project.
        </p>
      )}

      {canAct &&
        (editing ? (
          <div className="plan-note">
            <label className="auth-label" htmlFor={`budget-${detail.id}`}>
              Authorised ceiling for the whole project ({detail.currency})
            </label>
            <input
              id={`budget-${detail.id}`}
              className="auth-input mono"
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.00"
            />
            <div className="plan-actions">
              <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={() => save(parsed)}
                disabled={busy || !valid}
              >
                Authorise
              </button>
            </div>
            {/* Clearing is a separate act with its own button, because it is not
                the same decision as lowering a number and should not be reachable
                by emptying a field. It stops new campaigns and deliberately does
                not touch one already authorised. */}
            {ceiling !== null && (
              <button className="btn btn-ghost" onClick={() => save(null)} disabled={busy}>
                Clear the ceiling, blocking new campaigns
              </button>
            )}
            {error ? <div className="auth-error">{error}</div> : null}
          </div>
        ) : (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setValue(ceiling === null ? '' : String(ceiling));
              setEditing(true);
            }}
          >
            {ceiling === null ? 'Authorise a budget' : 'Change the budget'}
          </button>
        ))}
    </div>
  );
}

/**
 * What each campaign is doing, and what it has actually spent.
 *
 * **This is the first surface for `campaign_outcomes`.** The metrics sweep is its
 * first writer, and shipping the writer without a reader would extend the defect
 * class this repository keeps recording: a column with nobody reading it, or a
 * number recorded where only a developer with SQL can see it. `detail.campaigns`
 * was itself an instance of that until now, fetched by the API on every open and
 * rendered nowhere.
 *
 * The panel's own rules apply unchanged.
 *
 * **A state is named in words**, with the dot as decoration rather than as the
 * carrier (rule 15).
 *
 * **Nothing renders that the engine did not produce.** No cost per acquisition,
 * no click-through rate, no projected finish: those are derived numbers, and this
 * is the surface whose whole claim is that the figures are the ones that were
 * measured. Counts are counted.
 *
 * **Null is "No numbers yet", never zero.** A zero on a spend figure claims a day
 * was measured and found to have none, which is a different sentence from "this
 * has not been read yet" and the wrong one to show somebody wondering whether
 * their money is moving.
 *
 * Money is `mono` for its tabular numerics (rule 14), because these figures are
 * read against the budget block directly above them.
 *
 * **The ceiling is the one figure here a person can write**, and writing it is
 * the authorisation for the automatic pause (ADR-0014): the model never
 * proposes it and the campaign card has no field for it, so this control is the
 * column's only writer. Null renders as "None set", which abstains rather than
 * blocks; that is the documented inversion of the budget's null and the copy
 * says what it means instead of assuming the reader knows.
 *
 * A campaign paused for a ceiling breach explains itself and, for the owner,
 * carries the resume button beside a warning that resume does not clear the
 * breach: a still-breached ceiling re-pauses it on the next check, and the
 * honest place to say so is before the click rather than after the surprise.
 */
function Campaigns({
  campaigns,
  currency,
  projectId,
  canAct,
  onChanged,
}: {
  campaigns: CampaignSummary[];
  currency: string;
  projectId: string;
  canAct: boolean;
  onChanged: () => void;
}) {
  if (campaigns.length === 0) return null;

  return (
    <div className="work-campaigns">
      <p className="work-campaigns-head">
        {campaigns.length === 1 ? '1 campaign' : `${campaigns.length} campaigns`}
      </p>
      <ul className="work-campaign-list">
        {campaigns.map((c) => {
          const state = CAMPAIGN_STATE_COPY[c.state] ?? {
            label: c.state.replace(/_/g, ' '),
            tone: 'active' as const,
          };
          return (
            <li key={c.id} className="work-campaign">
              <p className="work-campaign-name">{c.name}</p>
              <p className="work-campaign-meta">
                <span className="work-chip">{CHANNEL_COPY[c.channel] ?? c.channel}</span>
                <span className={`work-state ${state.tone}`}>
                  <span className="work-dot" aria-hidden />
                  {state.label}
                </span>
              </p>
              <p className="work-campaign-figures mono">
                <span className="work-campaign-figure">
                  <span className="work-budget-label">Authorised</span>
                  {c.budgetCap === null
                    ? 'Nothing yet'
                    : `${c.budgetCap} ${c.currency || currency}`}
                </span>
                <span className="work-campaign-figure">
                  <span className="work-budget-label">Spent</span>
                  {c.spendToDate === null
                    ? 'No numbers yet'
                    : `${c.spendToDate} ${c.currency || currency}`}
                </span>
                {c.clicksToDate !== null && (
                  <span className="work-campaign-figure">
                    <span className="work-budget-label">Clicks</span>
                    {c.clicksToDate}
                  </span>
                )}
                {c.conversionsToDate !== null && (
                  <span className="work-campaign-figure">
                    <span className="work-budget-label">Conversions</span>
                    {c.conversionsToDate}
                  </span>
                )}
                <span className="work-campaign-figure">
                  <span className="work-budget-label">Ceiling</span>
                  {c.cpaCeiling === null
                    ? 'None set'
                    : `${c.cpaCeiling} ${c.currency || currency} per conversion`}
                </span>
              </p>
              {c.lastMeasuredAt !== null && (
                <p className="work-campaign-measured">
                  Measured through {formatMeasuredThrough(c.lastMeasuredAt)}
                </p>
              )}
              {c.state === 'paused' && c.pauseReason === 'cpa_breach' && (
                <p className="work-campaign-reason">
                  Paused because it crossed the cost per conversion ceiling set for it. The spend
                  and the ceiling it was judged against are in the room message.
                </p>
              )}
              {canAct && (
                <CampaignCeiling
                  projectId={projectId}
                  campaign={c}
                  currency={currency}
                  onChanged={onChanged}
                />
              )}
              {canAct && c.state === 'paused' && (
                <ResumeCampaign projectId={projectId} campaignId={c.id} onChanged={onChanged} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The ceiling's only writer, on the budget control's exact shape: seed from the
 * current value, a separate explicit clear button, save then refetch the whole
 * project. Positive-only where the budget allows zero, because a ceiling of 0
 * would pause on the first cent and is refused by the contract and the table.
 */
function CampaignCeiling({
  projectId,
  campaign,
  currency,
  onChanged,
}: {
  projectId: string;
  campaign: CampaignSummary;
  currency: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ceiling = campaign.cpaCeiling;

  async function save(next: number | null) {
    setBusy(true);
    setError(null);
    try {
      await setCampaignCpaCeiling(projectId, campaign.id, next);
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the ceiling.');
    } finally {
      setBusy(false);
    }
  }

  const typed = value.trim();
  const parsed = typed === '' ? Number.NaN : Number(typed);
  const valid = Number.isFinite(parsed) && parsed > 0;

  if (!editing) {
    return (
      <div className="work-campaign-actions">
        <button
          className="btn btn-ghost"
          onClick={() => {
            setValue(ceiling === null ? '' : String(ceiling));
            setEditing(true);
          }}
        >
          {ceiling === null ? 'Set a cost per conversion ceiling' : 'Change the ceiling'}
        </button>
      </div>
    );
  }

  return (
    <div className="plan-note">
      <label className="auth-label" htmlFor={`ceiling-${campaign.id}`}>
        Most a conversion may cost before Octopus pauses this campaign (
        {campaign.currency || currency})
      </label>
      <input
        id={`ceiling-${campaign.id}`}
        className="auth-input mono"
        type="number"
        min="0.01"
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0.00"
      />
      <div className="plan-actions">
        <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => save(parsed)} disabled={busy || !valid}>
          Set the ceiling
        </button>
      </div>
      {/* Clearing is its own act, on the budget control's reasoning: it must not
          be reachable by emptying the field. Here it withdraws the instruction
          to judge, and the copy says what that abstention means. */}
      {ceiling !== null && (
        <button className="btn btn-ghost" onClick={() => save(null)} disabled={busy}>
          Clear the ceiling, Octopus stops judging this campaign
        </button>
      )}
      {error ? <div className="auth-error">{error}</div> : null}
    </div>
  );
}

/**
 * The other half of the automatic pause: a stopped campaign with no way back
 * would be a dead-end surface, and this product has shipped that shape three
 * times before noticing. The warning sits before the click because resuming
 * does not clear the breach; a still-breached ceiling re-pauses on the next
 * check, and learning that from the button would read as the product fighting
 * the person.
 */
function ResumeCampaign({
  projectId,
  campaignId,
  onChanged,
}: {
  projectId: string;
  campaignId: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resume() {
    setBusy(true);
    setError(null);
    try {
      await resumeCampaign(projectId, campaignId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume the campaign.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="work-campaign-actions">
      <button className="btn btn-ghost" onClick={resume} disabled={busy}>
        Resume the campaign
      </button>
      <p className="work-campaign-reason">
        If the ceiling is still crossed, Octopus will pause it again on the next check. Raise or
        clear the ceiling first if you want it to keep running.
      </p>
      {error ? <div className="auth-error">{error}</div> : null}
    </div>
  );
}

/**
 * The last whole day a campaign has numbers for.
 *
 * `period_end` is the exclusive end of a closed UTC day, so the day it describes
 * is the one before it. Rendering the boundary itself would tell somebody their
 * campaign was measured through tomorrow.
 */
function formatMeasuredThrough(periodEnd: string): string {
  const end = new Date(periodEnd);
  if (Number.isNaN(end.getTime())) return periodEnd;
  const lastDay = new Date(end.getTime() - 86_400_000);
  return lastDay.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
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

/**
 * A date rendered on the client only.
 *
 * Formatting during a server render produces the server's locale and time zone,
 * which then differs from what the browser renders and trips a hydration
 * mismatch. The same treatment the node console gives an expiry.
 */
function AcceptedDate({ value }: { value: string }) {
  const [text, setText] = useState(value.slice(0, 10));
  useEffect(() => {
    setText(new Date(value).toLocaleDateString());
  }, [value]);
  return <>{text}</>;
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
  // An expert handed something over and it is waiting on this person. A separate
  // predicate from `stuck` rather than a third member of it, because the two ask
  // different questions: `stuck` means the plan cannot continue without you,
  // this means somebody is waiting to be paid.
  const reviewable = task.state === 'proof_submitted';

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

      {/* Who took this step, at what price, when.

          **This is the counterparty pair opening in one direction**, and it is
          the only place the owner learns who is doing their work. `offers` stays
          closed to them, because an offer names every expert who was ASKED,
          including the ones who said no. An engagement names the one who took it
          and is being paid from this project's authorised budget.

          Tabular numerics on the money (rule 14), and the price is the frozen
          one: an expert who raises their rate later has not re-priced work
          already agreed. */}
      {task.engagement && (
        <p className="work-engagement">
          <span className="work-engagement-who">
            {task.engagement.nodeDisplayName ?? 'An expert'}
          </span>
          <span className="work-engagement-price mono">
            {task.engagement.agreedPrice.toFixed(2)} {task.engagement.currency}
          </span>
          <span className="work-engagement-when mono">
            Accepted <AcceptedDate value={task.engagement.acceptedAt} />
          </span>
        </p>
      )}

      {canAct && stuck && <ResolveStep task={task} projectId={projectId} onResolved={onResolved} />}
      {canAct && reviewable && (
        <ReviewWork task={task} projectId={projectId} onResolved={onResolved} />
      )}

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
                  <ArtifactFile artifact={artifact} projectId={projectId} />
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
 * A deliverable that is a file.
 *
 * This arm used to read "This one is a file rather than text." and that was the
 * whole feature: a sentence describing something nobody could open. It was also
 * unreachable, since there was no bucket and no writer, so the copy described a
 * state the product could not produce.
 *
 * **The link is fetched on click, never with the project.** It is a bearer
 * capability, good for ten minutes without signing in, so putting one in the
 * project payload would mint a download credential for every file the moment the
 * panel opened and keep it in memory for as long as it stayed open. One click,
 * one link, and it expires whether or not it was used.
 *
 * **The link is offered rather than followed when the browser refuses to open
 * it.** A pop-up blocker can stop `window.open` after an await, and a button
 * that appears to do nothing is worse than a link somebody has to click twice.
 * Which of the two happened is visible, rather than being guessed at.
 */
function ArtifactFile({
  artifact,
  projectId,
}: {
  artifact: ProjectDetail['tasks'][number]['artifacts'][number];
  projectId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const { url } = await getArtifactFileUrl(projectId, artifact.id);
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (!opened) setLink(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="work-artifact-file">
      <p className="work-empty">This one is a file rather than text.</p>
      {link ? (
        // Reached only when the browser blocked the tab. The person clicks this
        // one themselves, which no blocker interferes with.
        <a className="work-action" href={link} target="_blank" rel="noopener noreferrer">
          Open the file
        </a>
      ) : (
        <button type="button" className="work-action" onClick={download} disabled={busy}>
          {busy ? 'Preparing the link' : 'Download'}
        </button>
      )}
      {error && <p className="work-error">{error}</p>}
    </div>
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
 * **`escalated`** is work the plan assigned to an expert, and it now has three
 * ways forward rather than two. "Find an expert" sends it to the marketplace,
 * which offers it to one ranked node at a time; "I will do this one" records the
 * owner's own work as the deliverable; "Try again" is worth taking only when
 * something changed, such as a source that was missing.
 *
 * **Sending it is a click rather than something that happens by itself**, which
 * is the whole reason this button exists instead of a sweep over `escalated`.
 * Twelve steps sit in that state on the live database, and a sweep claiming them
 * on deploy would push a dozen at a cold-start pool while taking these controls
 * away. Both refusals happen before the step moves, so a stage nobody can staff
 * leaves all three buttons intact and says why.
 *
 * Once dispatched the step reads "Finding an expert" and has no controls, which
 * is accepted rather than overlooked: there is nothing useful to offer while a
 * stranger is deciding, and the cascade returns it within 48 hours per candidate
 * if nobody takes it.
 */
/**
 * The owner's verdict on what an expert handed over.
 *
 * **A separate control from `ResolveStep`, deliberately.** That one is about a
 * step the plan cannot continue without you; this one is about work somebody has
 * already done and is waiting to be paid for, and the two read differently
 * because they are different asks. Sharing a component would mean a `stuck ||
 * reviewable` predicate and four buttons whose meaning depends on which arm
 * matched.
 *
 * **The proof is already on screen.** It renders in the deliverables disclosure
 * below this, because a node's proof is an `artifacts` row on the same task and
 * the owner is a project member ([ADR-0022](../../../docs/40-adr/0022-proof-is-an-artifact.md)).
 * So this control does not fetch or repeat it: it sits above the thing it is a
 * verdict on.
 *
 * **Sending back requires a note and approving does not.** The node reads that
 * note and works from it; sending work back with no reason leaves them guessing
 * while their fee sits in escrow. The API refuses an empty one too, so this is
 * the readable half of a rule enforced in both places.
 */
function ReviewWork({
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
  const [busy, setBusy] = useState<null | 'approve_work' | 'reject_work'>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'approve_work' | 'reject_work') {
    setBusy(action);
    setError(null);
    try {
      await resolveStep(
        projectId,
        task.id,
        action === 'reject_work' ? { action, text } : { action },
      );
      onResolved();
    } catch (err) {
      // Their writing stays on screen, for `ResolveStep`'s reason.
      setError(err instanceof Error ? err.message : 'That did not go through.');
      setBusy(null);
    }
  }

  if (!open) {
    return (
      <div className="work-resolve">
        <button
          type="button"
          className="work-action"
          disabled={busy !== null}
          onClick={() => void run('approve_work')}
        >
          {busy === 'approve_work' ? 'Approving' : 'Approve this work'}
        </button>
        <button type="button" className="work-action quiet" onClick={() => setOpen(true)}>
          Send it back
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
      <label className="work-resolve-label" htmlFor={`review-${task.id}`}>
        What needs to change? The expert reads this and picks the step back up.
      </label>
      <textarea
        id={`review-${task.id}`}
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
          onClick={() => void run('reject_work')}
          disabled={busy !== null || text.trim().length === 0}
        >
          {busy === 'reject_work' ? 'Sending back' : 'Send it back'}
        </button>
      </div>
    </div>
  );
}

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
  const [busy, setBusy] = useState<null | 'answer' | 'retry' | 'find_expert'>(null);
  const [error, setError] = useState<string | null>(null);
  const escalated = task.state === 'escalated';

  async function run(action: 'answer' | 'retry' | 'find_expert') {
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
            className="work-action"
            disabled={busy !== null}
            onClick={() => void run('find_expert')}
          >
            {busy === 'find_expert' ? 'Searching' : 'Find an expert'}
          </button>
        )}
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
