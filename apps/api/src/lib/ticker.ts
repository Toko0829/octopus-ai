import type { SupabaseClient } from '@supabase/supabase-js';
import { decideRecovery, summarise, tick, type ReclaimedRun } from '@octopus/core';
import { randomUUID } from 'node:crypto';
import { createSchedulerPorts } from './scheduler';
import { crawlSweep } from './crawl';
import { notifyWaiting } from './waiting';
import type { ExecutorDeps } from './executor';

/**
 * The durable backbone, on the Postgres that already holds the state (ADR-0010).
 *
 * Trigger.dev was the Phase 0 pin and it has been blocked on credentials for the
 * length of the project. What changed is that two later decisions removed the
 * problem it solves: ADR-0006 left no continuation to preserve, since the
 * reasoning core is stateless and Node commits each step, and `20260813120000`
 * put the state machine under trigger enforcement in the database. A run's
 * progress is rows. A crash loses a worker, not a run.
 *
 * So what is actually needed is small, and it is this file: something that wakes
 * up, notices work whose worker died, and walks the graph.
 *
 * **A human waitpoint needs nothing here.** A task sitting in `escalated` or
 * `needs_user` is the waitpoint: it waits in a row, at zero compute, for as long
 * as it takes, and the next pass picks it up when something changes the state.
 * That is the property a durable execution engine sells, and this architecture
 * gets it by construction rather than by buying it.
 */

/** How often the graph is walked when nothing else prompts it. */
export const DEFAULT_TICK_INTERVAL_MS = 30_000;

export interface TickerOptions {
  admin: SupabaseClient;
  executor?: Omit<ExecutorDeps, 'admin'>;
  /** Bound on one Node/Python step, used to size the lease. */
  stepBudgetMs: number;
  intervalMs?: number;
  /**
   * Re-read the external source registry on a cadence. Absent means this
   * deployment does not crawl, which is the default: the registry names real
   * public pages, and every developer's laptop requesting them on boot would be
   * pointless traffic aimed at somebody else's servers.
   */
  crawl?: { aiServiceUrl: string; aiTimeoutMs?: number; maxPerPass: number };
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
}

/**
 * Fail attempts whose worker stopped extending its lease, and report them.
 *
 * The database call only marks the ATTEMPT failed; moving the task is this side's
 * job, because the state machine has one owner and it is the scheduler. Keeping
 * those separate is what stops a sweep from quietly resurrecting work the router
 * had deliberately escalated.
 */
export async function reclaimLostRuns(
  admin: SupabaseClient,
  log: TickerOptions['log'],
): Promise<number> {
  const { data, error } = await admin.rpc('reclaim_expired_runs');
  if (error) throw error;

  const lost = (data ?? []) as { task_id: string; run_id: string; attempt: number }[];
  if (lost.length === 0) return 0;

  for (const row of lost) {
    const run: ReclaimedRun = { taskId: row.task_id, runId: row.run_id, attempt: row.attempt };
    const decision = decideRecovery(run);

    // Conditional on the state the task was left in, so a worker that came back
    // and finished simply wins. Reading and then writing would be the race this
    // exists to survive rather than one to introduce.
    const { error: moveError } = await admin
      .from('tasks')
      .update({ state: decision.target })
      .eq('id', decision.taskId)
      .eq('state', 'ai_running');

    if (moveError) {
      // Never swallowed. The guard in Postgres is the authority, so a sweep that
      // hid its refusals would be a project quietly stuck (rule 16).
      log.error({ err: moveError, ...decision }, 'could not recover a lost run');
      continue;
    }
    log.warn(decision, 'recovered a run whose worker was lost');
  }
  return lost.length;
}

/**
 * Start walking the graph on an interval. Returns a function that stops it.
 *
 * **One pass at a time, and one instance at a time.** `try_claim_tick` is a lease
 * rather than an advisory lock because supabase-js speaks PostgREST, which offers
 * no session affinity, so a lock taken in one request is not held in the next.
 * Worth being precise about what it protects: it prevents duplicated *effort*.
 * Duplicated *execution* is prevented by the unique attempt row on `task_runs`,
 * which is the guard that actually protects correctness, and which would still
 * hold if this claim vanished entirely.
 *
 * A pass is best effort, exactly as one scheduler tick is: one project that fails
 * must not stop the others, or a single stuck graph freezes every other tenant's.
 */
export function startTicker(opts: TickerOptions): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;

  // Sized to a PASS, not to a step, and the difference cost a debugging session.
  // `leaseDurationMs(stepBudgetMs)` is right for `task_runs.lease_until`, which
  // must outlive a slow execute or a healthy worker gets reclaimed mid-flight.
  // Applying it here meant a 15 minute claim, so every restart locked the ticker
  // out for a quarter of an hour: the dead process still held the lease, the new
  // one could not take it, and nothing ran.
  //
  // It deliberately does NOT try to cover a long pass either. A pass that
  // executes several AI tasks can run for tens of minutes, and stretching the
  // claim to fit would reintroduce the same lockout. What makes a shorter claim
  // safe is that it protects duplicated EFFORT rather than correctness: the
  // unique attempt row on `task_runs` is what refuses a second worker on the same
  // task, and that holds whatever this lease says.
  const claimMs = Math.max(intervalMs * 3, 90_000);
  // Per process, so a restarted instance does not inherit its own previous claim
  // and is treated as the contender it is.
  const worker = `api:${randomUUID()}`;

  let running = false;
  let stopped = false;

  async function pass(): Promise<void> {
    // A pass that overruns the interval must not stack. The lease would refuse a
    // second one anyway, since it is scoped to this worker, but not queuing the
    // work is cheaper than discovering that at the database.
    if (running || stopped) return;
    running = true;

    try {
      const { data: claimed, error: claimError } = await opts.admin.rpc('try_claim_tick', {
        p_worker: worker,
        p_lease_seconds: Math.ceil(claimMs / 1000),
      });
      if (claimError) throw claimError;
      if (claimed !== true) {
        // Never silent. "Another instance is ticking" and "the ticker is broken"
        // look identical from the outside, and this exact silence is what made a
        // stale claim from a killed process look like a dead feature (rule 16).
        opts.log.info({ worker }, 'another worker holds the tick claim; skipping this pass');
        return;
      }

      const recovered = await reclaimLostRuns(opts.admin, opts.log);

      const { data: projects, error: projectError } = await opts.admin
        .from('projects')
        .select('id')
        .in('status', ['active', 'planning']);
      if (projectError) throw projectError;

      const ports = createSchedulerPorts(opts.admin, opts.executor);
      let moved = 0;
      let failed = 0;
      for (const project of (projects ?? []) as { id: string }[]) {
        try {
          const report = await tick(project.id, ports);

          // Counted by OUTCOME, not by how many tasks were looked at. Reporting
          // `results.length` as "moved" was a false log line of exactly the kind
          // rule 16 forbids: a tick that refused all sixteen transitions printed
          // `moved: 16` every thirty seconds while the project never advanced,
          // and the errors sat unread inside the report.
          const counts = summarise(report);
          moved += report.results.length - counts.failed;
          failed += counts.failed;

          for (const result of report.results) {
            if (result.outcome !== 'failed') continue;
            opts.log.error(
              { projectId: project.id, taskId: result.taskId, reason: result.error },
              'a task could not be transitioned',
            );
          }
          // A task that reaches `needs_user` or `escalated` is waiting on a
          // person, and until this existed nobody told them. Announced after the
          // tick rather than inside it: the transitions are committed and the
          // digest is a projection of them, so a failure to speak cannot undo
          // work that already landed.
          await notifyWaiting(opts.admin, report, opts.log);
        } catch (err) {
          opts.log.error({ err, projectId: project.id }, 'tick failed for a project');
        }
      }

      // The freshness pipeline, after the graph rather than before it. Walking
      // the DAG is what a person is waiting on; re-reading a regulator's page is
      // not, and it can involve a slow or hanging remote host. Its own try/catch
      // for the same reason each project has one: a sweep that throws must not
      // take the tick with it (ADR-0010, rule 16).
      if (opts.crawl) {
        try {
          await crawlSweep({
            admin: opts.admin,
            aiServiceUrl: opts.crawl.aiServiceUrl,
            aiTimeoutMs: opts.crawl.aiTimeoutMs,
            maxPerPass: opts.crawl.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'crawl sweep failed');
        }
      }

      if (recovered || moved || failed) {
        opts.log.info({ recovered, moved, failed, worker }, 'tick complete');
      }
    } catch (err) {
      // The ticker must outlive its own failures. A pass that throws and takes
      // the interval with it turns one bad read into a system that stopped
      // working and never said so.
      opts.log.error({ err, worker }, 'tick pass failed');
    } finally {
      running = false;
    }
  }

  const handle = setInterval(() => void pass(), intervalMs);
  // Does not hold the process open. A ticker that kept a CLI or a test runner
  // alive would be a background job nobody asked for.
  handle.unref?.();

  void pass();

  return () => {
    stopped = true;
    clearInterval(handle);
    void opts.admin.rpc('release_tick_claim', { p_worker: worker });
  };
}
