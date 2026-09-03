import type { SupabaseClient } from '@supabase/supabase-js';
import { decideRecovery, summarise, tick, type ReclaimedRun } from '@octopus/core';
import { randomUUID } from 'node:crypto';
import { createSchedulerPorts } from './scheduler';
import { crawlSweep } from './crawl';
import { publishSweep } from './publish';
import { metricsSweep } from './metrics';
import { optimizeSweep } from './optimize';
import { matcherSweep } from './match';
import { escrowReconcileSweep } from './escrow-reconcile';
import { noShowSweep } from './no-show';
import { payoutSweep } from './payout';
import { healSweep } from './heal';
import { notifyWaiting } from './waiting';
import { produceCampaignCards } from './campaign-cards';
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
  /**
   * Publish campaigns an owner has already approved. Absent means this deployment
   * does not publish, which is a supported configuration rather than an
   * oversight, exactly as `crawl` is. Unlike `crawl` it is on by default, because
   * a deployment that shows people a campaign card and then never publishes what
   * they approve is telling them something untrue (see `PUBLISH_ENABLED`).
   */
  publish?: { maxPerPass: number };
  /**
   * Record what live campaigns actually spent. Absent means this deployment does
   * not measure, which is supported and is not the default: a product that shows
   * somebody a campaign and never tells them what it did is the same untruth
   * `publish` describes, one step later (see `METRICS_ENABLED`).
   */
  metrics?: { maxPerPass: number };
  /**
   * Pause live campaigns that breach the CPA ceiling their owner typed. Absent
   * means this deployment does not enforce ceilings, which is supported and is
   * not the default: a ceiling somebody typed and nothing enforces is a promise
   * the product is quietly not keeping (see `OPTIMIZE_ENABLED`, ADR-0014).
   */
  optimize?: { maxPerPass: number };
  /**
   * Offer escalated steps to expert nodes, and cascade when one says no. Absent
   * means this deployment does not match, which is supported and is not the
   * default: the panel offers a button saying an expert will be found, and a
   * deployment that moves the step to `matching` and never looks again is the
   * same untruth the three flags above exist to avoid (see `MATCHER_ENABLED`).
   */
  matcher?: { maxPerPass: number };
  /**
   * Give back escrow held against steps that stopped before they were
   * delivered. Absent means this deployment does not reconcile, which is
   * supported and is not the default: a hold on a cancelled step pins part of
   * the owner's authorised budget forever and nothing else can release it (see
   * `ESCROW_RECONCILE_ENABLED`).
   */
  escrow?: { maxPerPass: number };
  /**
   * Return a step to the marketplace when the expert who took it missed the
   * agreed date, giving the owner their money back. Absent means this deployment
   * does not reassign, which is supported and is not the default: an abandoned
   * step then stays `escrow_funded` forever with its hold committing the ceiling,
   * which is precisely the dead end this slice closed (see `NO_SHOW_ENABLED`).
   */
  noShow?: { maxPerPass: number };
  /**
   * Pay the expert when the owner approves their work, releasing the escrow held
   * against that step. Absent means this deployment does not pay anybody, which
   * is supported and is not the default, and is the sharpest absence on this
   * list: an approved step then sits at `approved` holding its escrow forever,
   * the hold keeps committing the owner's ceiling, and somebody who did the work
   * is never paid. Nothing else produces `held -> released` (see
   * `PAYOUT_ENABLED`).
   */
  payout?: { maxPerPass: number };
  /**
   * Finish AI steps the executor left at `approved` when it died between its
   * two writes, and deliver the artifact it never announced. Absent means this
   * deployment does not heal, which is supported and is not the default: a
   * finished step then stays cancellable by any replan forever, and the work it
   * produced is never shown to anybody (see `HEAL_ENABLED`).
   */
  heal?: { maxPerPass: number };
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

      // The other thing a dead worker leaves behind: a step it approved and did
      // not finish. Directly after reclaiming lost runs and before the graph is
      // walked, so a dependent waiting on nothing but that second write moves in
      // this pass rather than the next. Its own try/catch, like every sweep
      // here, and unlike `reclaimLostRuns` it is optional because it delivers
      // into rooms, which a classify-only deployment should not do.
      if (opts.heal) {
        try {
          await healSweep({
            admin: opts.admin,
            maxPerPass: opts.heal.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'heal sweep failed');
        }
      }

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

          // A step that stopped specifically for an AUTHORISATION gets a card
          // the owner can act on, rather than only a line saying it needs them.
          // Without this a high-risk step is a dead end: `routeTask` parks it at
          // `needs_user` by design and there is no surface on which to say yes.
          //
          // Only when an executor is configured, because that is what carries the
          // reasoning core's address and the card is drafted there. A ticker
          // running without one still schedules and still announces; it just
          // cannot ask for a draft.
          if (opts.executor) {
            await produceCampaignCards(opts.admin, report, {
              aiServiceUrl: opts.executor.aiServiceUrl,
              aiTimeoutMs: opts.executor.aiTimeoutMs,
              log: opts.log,
            });
          }
        } catch (err) {
          opts.log.error({ err, projectId: project.id }, 'tick failed for a project');
        }
      }

      // Publishing goes after the graph and BEFORE the crawl, and the ordering
      // is a claim about who is waiting. A person who approved a campaign is
      // watching for it to go live; nobody is waiting on a regulator's page
      // being re-read. Its own try/catch for the reason every other sweep has
      // one: a failure here must not take the tick with it (rule 16).
      if (opts.publish) {
        try {
          await publishSweep({
            admin: opts.admin,
            maxPerPass: opts.publish.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'publish sweep failed');
        }
      }

      // Measuring goes after publishing and before the crawl, on the same claim
      // about who is waiting. Nobody is watching a number arrive the way they
      // watch a campaign go live, so it yields to publish; but it reads our own
      // customers' spend, which outranks re-reading a stranger's page, and unlike
      // the crawl it touches no remote host at all for the registered provider.
      // Its own try/catch, for the reason every sweep on this pass has one.
      if (opts.metrics) {
        try {
          await metricsSweep({
            admin: opts.admin,
            maxPerPass: opts.metrics.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'metrics sweep failed');
        }
      }

      // Enforcing ceilings goes directly after measuring, and the adjacency is
      // the point: it judges the whole days the metrics sweep may have just
      // written, so running it here means a breach is acted on in the same pass
      // that revealed it rather than one interval later. It stops money, which
      // outranks re-reading a stranger's page, so it stays ahead of the crawl.
      // Its own try/catch, for the reason every sweep on this pass has one.
      if (opts.optimize) {
        try {
          await optimizeSweep({
            admin: opts.admin,
            maxPerPass: opts.optimize.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'optimize sweep failed');
        }
      }

      // Unwinding escrow held against steps that stopped, after optimize and
      // before the matcher. The ordering rule on this pass is who is waiting,
      // and this one touches modelled money: an owner whose ceiling is pinned by
      // a cancelled step cannot authorise the campaign or the acceptance that
      // would replace it, so it outranks making a new offer. It yields to
      // optimize because that stops spend that is actually happening. Its own
      // try/catch, like every sweep here.
      if (opts.escrow) {
        try {
          await escrowReconcileSweep({
            admin: opts.admin,
            maxPerPass: opts.escrow.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'escrow reconcile sweep failed');
        }
      }

      // Steps somebody took and did not deliver, immediately after the refund
      // sweep and immediately before the matcher. The adjacency is the point, the
      // way optimize-after-metrics is: this sweep **produces** tasks at
      // `matching`, and the matcher picks them up in the same pass rather than a
      // tick later, so a person waiting on a replacement expert waits one
      // interval less for no extra work. It sits after the escrow reconcile
      // because both give money back and that one is unwinding work the owner has
      // already cancelled, which is the less ambiguous case. Its own try/catch,
      // like every sweep here.
      if (opts.noShow) {
        try {
          await noShowSweep({
            admin: opts.admin,
            maxPerPass: opts.noShow.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'no-show sweep failed');
        }
      }

      // Paying the expert for a step the owner approved, immediately after the
      // no-show sweep and before the matcher. **After** it, because both read
      // live engagements and the no-show sweep can refund a hold this one would
      // otherwise have paid against; running it first means this pass sees the
      // refund rather than racing it, and `settle_payout` refuses the case under
      // a lock either way. **Before** the matcher, on the ordering rule the whole
      // pass follows: somebody who has finished work and is owed money outranks
      // somebody who has not been offered any yet. Its own try/catch, like every
      // sweep here.
      if (opts.payout) {
        try {
          await payoutSweep({
            admin: opts.admin,
            maxPerPass: opts.payout.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'payout sweep failed');
        }
      }

      // Offering escalated steps, after the money sweeps and before the crawl.
      // The ordering rule on this pass is who is waiting: an owner who clicked
      // "Find an expert" and a node with nothing to do are both people, so this
      // outranks re-reading a stranger's page. It yields to the three above
      // because it moves no money at all, and a campaign spending past its
      // ceiling cannot wait behind a matching pass. Its own try/catch, like
      // every sweep here.
      if (opts.matcher) {
        try {
          await matcherSweep({
            admin: opts.admin,
            maxPerPass: opts.matcher.maxPerPass,
            log: opts.log,
          });
        } catch (err) {
          opts.log.error({ err, worker }, 'matcher sweep failed');
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
