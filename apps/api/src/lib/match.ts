import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decideOfferSettlement,
  nextCandidate,
  offerExpiresAt,
  WORK_TTL_HOURS,
  rankCandidates,
  skillsForStage,
  type CandidateNode,
} from '@octopus/marketplace';
import { postSystemMessage } from './system-message';
import { roomForProject } from './room-for-project';

/**
 * The matcher: the first exit `escalated` has ever had that is not the owner
 * giving up and doing the step themselves.
 *
 * `packages/core/src/router.ts:93` has sent every human-owned step to
 * `escalated` since the router landed, with the reason "Needs expert human
 * judgement, so it goes to the marketplace", and the marketplace did not exist.
 * `20260827120000` measured seventeen such tasks on the live database, gave the
 * owner a way to unstick their own project, and stated in its header that it
 * "is not the marketplace and must not be dressed up as one." This is.
 *
 * **Nothing here decides that a step should go to the marketplace.** An owner
 * does, by clicking on the panel, and `apps/api/src/routes/task-actions.ts` is
 * where that authorisation lives. This sweep only acts on tasks already in
 * `matching` or `offered`. That is why it needs no project filter, no
 * `escalated` scan and no heuristic about which escalations are marketplace
 * work: a sweep that decided for itself would have pushed all twelve live
 * escalated tasks into a cold-start pool the moment it deployed.
 *
 * **This sweep is the clock's side of the domain, and `accept_offer` is the
 * person's side.** That sentence replaces the one this comment used to carry,
 * which said the sweep was the only writer of `tasks.state` here. It was true
 * while a node could only decline: the decline route settles the offer row and
 * stops, and the sweep does every task move. Acceptance changed it. Accepting
 * and funding are inseparable, so `accept_offer` moves the task itself, twice,
 * `offered -> claimed -> escrow_funded`, inside one transaction. Leaving the old
 * sentence in place would have shipped a comment that lies about who writes what.
 *
 * **What actually keeps the two apart is not a single writer, it is that every
 * move on both sides is a conditional UPDATE on the row it read**, so a loser
 * performs nothing rather than overwriting a winner. Written out, because a race
 * described in the abstract is a race nobody checked:
 *
 *   * **Sweep first, accept second.** `settleOffered` expires the offer and
 *     moves the task back to `matching`. `accept_offer`'s `status = 'open'`
 *     conditional then matches zero rows, it raises, and the **whole transaction
 *     unwinds**: no engagement, no hold, no ledger row, no membership.
 *   * **Accept first, sweep second.** The offer is `accepted` and the task is
 *     `escrow_funded`. `settleOffered` reads only tasks at `offered`;
 *     `offerMatching` reads only tasks at `matching`; `withdrawOrphans` reads
 *     only `open` offers and skips the two market states. All three miss it.
 *   * **They cannot interleave past each other**, because `settleOffered` only
 *     cascades a task whose latest offer is already settled. It cannot move a
 *     task out from under a live offer somebody is in the middle of accepting.
 *   * **No crash window exposes `claimed`**, because both task moves are in one
 *     transaction. That is the premise ADR-0019 rests on, and the reason
 *     `claimed -> matching` stays a dropped arc rather than being restored here.
 *
 * The owner can also take the step themselves through `task-actions.ts` at any
 * moment, and that route is equally conditional. That is the same idiom
 * `reclaimLostRuns` uses against a worker that turns out to be alive.
 */

/** How many rows one read may consider, per state. Bounds the read, not the work. */
const CANDIDATE_READ_LIMIT = 200;

/** How many nodes the pool query may return before ranking. */
const POOL_READ_LIMIT = 200;

interface MarketTask {
  id: string;
  project_id: string;
  title: string;
  stage: string | null;
  state: string;
}

interface OfferRow {
  id: string;
  task_id: string;
  project_id: string;
  node_id: string;
  round: number;
  status: 'open' | 'declined' | 'expired' | 'withdrawn' | 'accepted';
  expires_at: string;
}

export interface MatcherSweepDeps {
  admin: SupabaseClient;
  /** Bounds offers CREATED, not tasks examined. Settling and cascading are free. */
  maxPerPass: number;
  log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  now?: () => Date;
}

export interface MatcherSweepResult {
  /** Offers created and the task moved to `offered`. */
  offered: number;
  /** Settled offers whose task went back to `matching` for the next candidate. */
  cascaded: number;
  /** Open offers that ran out of time. Settled here, cascaded next pass. */
  expired: number;
  /** Offers whose task left the market underneath them. */
  withdrawn: number;
  /** Nobody left to ask. The step went back to its owner, who was told. */
  exhausted: number;
  /** A stage this build has no skill map for. Defensive: the route prechecks. */
  unmatchable: number;
  /** An insert collided on (task_id, round): an earlier pass had already made it. */
  replayed: number;
  /** Could not act this pass. Retried next pass, nothing moved. */
  waiting: number;
}

export async function matcherSweep(deps: MatcherSweepDeps): Promise<MatcherSweepResult> {
  const result: MatcherSweepResult = {
    offered: 0,
    cascaded: 0,
    expired: 0,
    withdrawn: 0,
    exhausted: 0,
    unmatchable: 0,
    replayed: 0,
    waiting: 0,
  };

  await withdrawOrphans(deps, result);
  await settleOffered(deps, result);
  await offerMatching(deps, result);

  deps.log.info(result, 'matcher sweep complete');
  return result;
}

/* ------------------------------------------------------ 1. orphaned offers */

/**
 * Close offers whose task is no longer in the market.
 *
 * This is `withdrawn`'s only producer, and it exists because the task can leave
 * `offered` without the offer knowing: the owner cancels the step, blocks it, or
 * takes it on themselves while somebody is still deciding. Both of those are
 * legal task arcs that no code here mediates.
 *
 * Left alone, such an offer stays `open` forever, keeps holding the
 * `offers_one_open_idx` slot against a later re-dispatch, and shows a node work
 * they can no longer do. Closing it first, before anything else in the pass,
 * means the cascade below never reads a row about a task that has moved on.
 */
async function withdrawOrphans(deps: MatcherSweepDeps, result: MatcherSweepResult): Promise<void> {
  const { data: openRows, error } = await deps.admin
    .from('offers')
    .select('id, task_id, project_id, node_id, round, status, expires_at')
    .eq('status', 'open')
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const offers = (openRows ?? []) as OfferRow[];
  if (offers.length === 0) return;

  const { data: taskRows, error: taskError } = await deps.admin
    .from('tasks')
    .select('id, state')
    .in(
      'id',
      offers.map((o) => o.task_id),
    );
  if (taskError) throw taskError;

  const stateById = new Map((taskRows ?? []).map((t) => [t.id as string, t.state as string]));

  for (const offer of offers) {
    // A task the read did not return has been deleted, and the offer went with
    // it by cascade, so there is nothing to withdraw.
    const state = stateById.get(offer.task_id);
    if (state === undefined) continue;

    // **Both market states count as still in the market, and `matching` is the
    // one that is easy to get wrong.** A task in `offered` obviously still has a
    // live offer. A task in `matching` with an open offer is the half-finished
    // pass: the row was inserted and the process died before the task moved.
    // Withdrawing there would destroy an offer somebody is holding and hand the
    // step back to its owner as though nobody wanted it, so the resume in
    // `offerOne` is what handles that state instead.
    if (state === 'offered' || state === 'matching') continue;

    try {
      const { data: moved, error: updateError } = await deps.admin
        .from('offers')
        .update({ status: 'withdrawn' })
        .eq('id', offer.id)
        .eq('status', 'open')
        .select('id');
      if (updateError) throw updateError;
      if ((moved ?? []).length > 0) result.withdrawn += 1;
    } catch (err) {
      result.waiting += 1;
      deps.log.error(
        { err, offerId: offer.id, taskId: offer.task_id, taskState: state },
        'could not withdraw an offer whose task left the market',
      );
    }
  }
}

/* --------------------------------------------- 2. tasks holding an offer */

/**
 * Expire what has run out, and send a settled task back for its next candidate.
 *
 * Expiry and cascade are two passes rather than one act, deliberately. Settling
 * the row first means the trail says the offer expired, and the cascade that
 * follows reads exactly like the cascade after a decline, so a crash between the
 * two leaves a settled offer and a task still in `offered`, which the next pass
 * resolves by the same path a decline takes. Doing both at once would make the
 * crash window the one where an offer is settled, the task has moved, and
 * nothing recorded why.
 */
async function settleOffered(deps: MatcherSweepDeps, result: MatcherSweepResult): Promise<void> {
  const now = deps.now?.() ?? new Date();

  const { data: taskRows, error } = await deps.admin
    .from('tasks')
    .select('id, project_id, title, stage, state')
    .eq('state', 'offered')
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const tasks = (taskRows ?? []) as MarketTask[];
  if (tasks.length === 0) return;

  const { data: offerRows, error: offerError } = await deps.admin
    .from('offers')
    .select('id, task_id, project_id, node_id, round, status, expires_at')
    .in(
      'task_id',
      tasks.map((t) => t.id),
    )
    .order('round', { ascending: false });
  if (offerError) throw offerError;

  const latestByTask = new Map<string, OfferRow>();
  for (const offer of (offerRows ?? []) as OfferRow[]) {
    if (!latestByTask.has(offer.task_id)) latestByTask.set(offer.task_id, offer);
  }

  for (const task of tasks) {
    const offer = latestByTask.get(task.id);
    if (!offer) {
      // A task in `offered` with no offer row at all. Nothing here created it,
      // so nothing here will guess: sending it back to `matching` would be this
      // sweep inventing an act, and the state is visible to the owner.
      result.waiting += 1;
      deps.log.error(
        { taskId: task.id, projectId: task.project_id },
        'a task is offered but has no offer row, so the sweep left it alone',
      );
      continue;
    }

    try {
      const settlement = decideOfferSettlement(
        { status: offer.status, expiresAt: new Date(offer.expires_at) },
        now,
      );
      if (settlement === 'wait') continue;

      if (settlement === 'expire') {
        const { data: moved, error: expireError } = await deps.admin
          .from('offers')
          .update({ status: 'expired' })
          .eq('id', offer.id)
          .eq('status', 'open')
          .select('id');
        if (expireError) throw expireError;
        if ((moved ?? []).length > 0) result.expired += 1;
        continue;
      }

      // Settled: back to `matching` so the next pass offers the next candidate.
      const { data: movedTask, error: taskError } = await deps.admin
        .from('tasks')
        .update({ state: 'matching' })
        .eq('id', task.id)
        .eq('state', 'offered')
        .select('id');
      if (taskError) throw taskError;
      if ((movedTask ?? []).length > 0) result.cascaded += 1;
    } catch (err) {
      result.waiting += 1;
      deps.log.error(
        { err, taskId: task.id, offerId: offer.id },
        'could not settle an offered task this pass',
      );
    }
  }
}

/* ------------------------------------------- 3. tasks waiting for an offer */

async function offerMatching(deps: MatcherSweepDeps, result: MatcherSweepResult): Promise<void> {
  const { data: taskRows, error } = await deps.admin
    .from('tasks')
    .select('id, project_id, title, stage, state')
    .eq('state', 'matching')
    .limit(CANDIDATE_READ_LIMIT);
  if (error) throw error;

  const tasks = (taskRows ?? []) as MarketTask[];

  for (const task of tasks) {
    if (result.offered >= deps.maxPerPass) break;

    try {
      await offerOne(deps, task, result);
    } catch (err) {
      result.waiting += 1;
      deps.log.error(
        { err, taskId: task.id, projectId: task.project_id },
        'could not offer a matching task this pass',
      );
    }
  }
}

async function offerOne(
  deps: MatcherSweepDeps,
  task: MarketTask,
  result: MatcherSweepResult,
): Promise<void> {
  const now = deps.now?.() ?? new Date();

  const skills = skillsForStage(task.stage);
  if (skills.length === 0) {
    // Defensive. The dispatch route refuses an unmappable stage before the task
    // ever reaches `matching`, so arriving here means a row was written by
    // something else: an older planner, a hand edit, or a future vertical. Send
    // it back rather than leave it circling.
    result.unmatchable += 1;
    await returnToOwner(
      deps,
      task,
      `I could not work out what kind of expert the step "${task.title}" needs, so it is back ` +
        `with you. You can do it yourself or try again.`,
    );
    return;
  }

  const priorOffers = await offersForTask(deps, task.id);

  // **The crash-resume path, and it has to come before the pool is read.**
  //
  // A pass that inserted an offer and died before moving the task leaves the
  // task in `matching` with an open offer against it. The skip set below would
  // then exclude the very node who is holding that offer, so a single-node pool
  // would look exhausted and this step would go back to its owner while somebody
  // was still holding an offer they had never been given a chance to answer.
  // Finishing the move is the only correct reading of that state.
  const openOffer = priorOffers.find((o) => o.status === 'open');
  if (openOffer) {
    const { data: resumed, error: resumeError } = await deps.admin
      .from('tasks')
      .update({ state: 'offered' })
      .eq('id', task.id)
      .eq('state', 'matching')
      .select('id');
    if (resumeError) throw resumeError;
    if ((resumed ?? []).length > 0) {
      result.replayed += 1;
      result.offered += 1;
      deps.log.info(
        { taskId: task.id, offerId: openOffer.id, round: openOffer.round },
        'finished a move an earlier pass left half done',
      );
    } else {
      result.waiting += 1;
    }
    return;
  }

  const alreadyOffered = new Set(priorOffers.map((o) => o.node_id));
  const pool = await readEligiblePool(deps.admin, skills);
  const ranked = rankCandidates(pool);
  const candidate = nextCandidate(ranked, alreadyOffered);

  if (!candidate) {
    result.exhausted += 1;
    await returnToOwner(
      deps,
      task,
      `No expert took the step "${task.title}", so it is back with you. You can do it ` +
        `yourself, try again, or search for an expert later.`,
    );
    return;
  }

  const round = await cascadeRound(deps, task.id);
  const expiresAt = offerExpiresAt(now);

  const { data: inserted, error: insertError } = await deps.admin
    .from('offers')
    .insert({
      task_id: task.id,
      project_id: task.project_id,
      node_id: candidate.nodeId,
      round,
      expires_at: expiresAt.toISOString(),
      // **Frozen onto the offer so the node sees it before they agree**, and so
      // that changing the constant later cannot shorten a deadline on work
      // already taken. `accept_offer` reads this column and stamps
      // `engagements.deadline_at`; it never takes the number as an argument,
      // because the caller of the accept route is the node.
      work_deadline_hours: WORK_TTL_HOURS,
    })
    .select('id')
    .maybeSingle();

  let offerId: string | null = inserted?.id ?? null;

  if (insertError) {
    if (insertError.code !== '23505') throw insertError;

    // An earlier pass created this round's offer and died before moving the
    // task. Read it back and finish the move: the unique key on (task_id, round)
    // is what makes the retry converge instead of opening a second offer.
    result.replayed += 1;
    const { data: existing, error: readError } = await deps.admin
      .from('offers')
      .select('id')
      .eq('task_id', task.id)
      .eq('round', round)
      .maybeSingle();
    if (readError) throw readError;
    offerId = existing?.id ?? null;
    if (!offerId) {
      // The collision was on (task_id, node_id) instead: this node has been
      // offered this task in an earlier round. The skip set should have caught
      // it, so this is a defect rather than a race. Leave it for the next pass
      // rather than guessing at a different candidate mid-write.
      result.waiting += 1;
      deps.log.error(
        { taskId: task.id, nodeId: candidate.nodeId, round },
        'offer insert collided but no offer exists for this round',
      );
      return;
    }
  }

  const { data: movedTask, error: taskError } = await deps.admin
    .from('tasks')
    .update({ state: 'offered' })
    .eq('id', task.id)
    .eq('state', 'matching')
    .select('id');
  if (taskError) throw taskError;

  if ((movedTask ?? []).length === 0) {
    // The owner took the step, or cancelled it, between the pool read and here.
    // The offer row exists and the next pass withdraws it, which is exactly what
    // `withdrawOrphans` is for.
    result.waiting += 1;
    deps.log.info(
      { taskId: task.id, offerId },
      'a task left matching while its offer was being written; the next pass withdraws it',
    );
    return;
  }

  result.offered += 1;

  // Written only after the task actually moved, because `events` has no unique
  // key and a replay writing it again would put two offers in the trail where
  // one was made. The trigger's `offer.transitioned` covers settlements; an
  // insert fires no trigger, so this is the only record that the offer was made.
  await writeOfferEvent(deps, {
    project_id: task.project_id,
    verb: 'offer.created',
    subject_id: offerId ?? task.id,
    payload: {
      task_id: task.id,
      node_id: candidate.nodeId,
      round,
      expires_at: expiresAt.toISOString(),
      skills,
      rate: candidate.rate,
    },
  });
}

/**
 * Send a step back to the owner, with a sentence saying why.
 *
 * `matching -> escalated` rather than `matching -> failed`, and that is the
 * decision [ADR-0018](docs/40-adr/0018-offer-exhaustion-returns-the-step-to-its-owner.md)
 * exists to record. `failed` is terminal: it would block every dependent step
 * and strand work the owner can still do with the three buttons already on their
 * panel. Exhaustion is not a failure of the step, it is the absence of a
 * counterparty, and the right place for it is back with the person who has one.
 */
async function returnToOwner(
  deps: MatcherSweepDeps,
  task: MarketTask,
  body: string,
): Promise<void> {
  const { data: moved, error } = await deps.admin
    .from('tasks')
    .update({ state: 'escalated' })
    .eq('id', task.id)
    .eq('state', 'matching')
    .select('id');
  if (error) throw error;
  if ((moved ?? []).length === 0) return;

  const roomId = await roomForProject(deps.admin, task.project_id);
  if (!roomId) {
    deps.log.warn(
      { taskId: task.id, projectId: task.project_id },
      'a step came back from the marketplace but its project has no room to say so in',
    );
    return;
  }

  // The epoch counts prior returns, so a re-dispatch that exhausts again is
  // announced again rather than colliding with the first announcement's key and
  // leaving the owner wondering why nothing happened.
  const epoch = await returnEpoch(deps, task.id);
  await postSystemMessage(
    deps.admin,
    deps.log,
    roomId,
    `match-exhausted:${task.id}:${epoch}`,
    body,
  );
}

/* ------------------------------------------------------------ reads */

/**
 * The eligible pool for a set of skills.
 *
 * Five filters, and every one of them is a rule stated somewhere else:
 * `kyc_status = 'verified'` and `availability = 'available'` mirror
 * `node_profiles_available_requires_kyc`, the one eligibility constraint with no
 * second layer; a non-null `rate` is what an offer would be measured against;
 * and the skill filter is the union the stage map produces.
 *
 * **`rate_period = 'task'` is the fifth, added in slice 5, and it excludes
 * hourly nodes from the pool entirely.** An hourly rate is a price per hour and
 * `escrow_holds.amount` is a total, so there is no honest way to fund one: there
 * is no hours field anywhere to multiply by, and inventing an estimate at
 * acceptance would be guessing at a number that decides what a person is paid.
 * The alternative was to keep offering hourly nodes work they would then be
 * refused at the last step, which is the dead-end shape this repository keeps
 * recording, so the filter is here rather than only in the refusal.
 *
 * `accept_offer` re-checks it anyway, as defense in depth: a node can change
 * their rate period between being offered a step and accepting it.
 *
 * `offerabilityGap` in `packages/marketplace` is where a node is told this about
 * themselves, beside the no-rate sentence it already carried.
 *
 * **It matches claims, not verified skills.** The module doc's algorithm says
 * "verified skills cover `required_skills`", and `node_skills.verified` is false
 * on every row in existence with nothing able to set it true, because credential
 * verification needs an evidence bucket and a licence registry that do not
 * exist. A verified-only filter would therefore match nobody, forever. Matching
 * claims is the honest posture while nothing can be confirmed, and it is safe
 * here in a way it would not be for a regulated act: these are marketing steps,
 * the owner reviews the work, and no money moves in this slice.
 *
 * The partial index `node_skills_tag_idx` is `where verified`, so this query
 * cannot use it. At a cold-start pool that is a sequential scan over a handful
 * of rows; it earns a second index when the pool is measured in hundreds.
 */
export async function readEligiblePool(
  admin: SupabaseClient,
  skills: readonly string[],
): Promise<CandidateNode[]> {
  if (skills.length === 0) return [];

  const { data: skillRows, error: skillError } = await admin
    .from('node_skills')
    .select('node_id')
    .in('skill_tag', [...skills]);
  if (skillError) throw skillError;

  const claimantIds = [...new Set((skillRows ?? []).map((r) => r.node_id as string))];
  if (claimantIds.length === 0) return [];

  const { data: nodeRows, error: nodeError } = await admin
    .from('node_profiles')
    .select('user_id, rate, service_jurisdictions')
    .in('user_id', claimantIds)
    .eq('kyc_status', 'verified')
    .eq('availability', 'available')
    .not('rate', 'is', null)
    .eq('rate_period', 'task')
    .limit(POOL_READ_LIMIT);
  if (nodeError) throw nodeError;

  const pool: CandidateNode[] = [];
  for (const row of nodeRows ?? []) {
    // PostgREST returns `numeric` as a string, and a string sort would place
    // "9.00" above "10.00". Parsed here so ranking never sees anything else.
    const rate = typeof row.rate === 'number' ? row.rate : Number(row.rate);
    if (!Number.isFinite(rate)) continue;
    pool.push({
      nodeId: row.user_id as string,
      rate,
      jurisdictions: (row.service_jurisdictions as string[] | null) ?? [],
    });
  }
  return pool;
}

/**
 * Every offer ever made for this task.
 *
 * The cascade's durable memory, read from rows rather than tracked in the sweep
 * so it survives a crash and a redeploy. Two callers want two different things
 * from it: who has already been asked (so nobody is asked twice, which
 * `offers_task_node_idx` also enforces), and whether one of them is still open
 * (which means an earlier pass stopped halfway).
 */
async function offersForTask(
  deps: MatcherSweepDeps,
  taskId: string,
): Promise<{ id: string; node_id: string; status: string; round: number }[]> {
  const { data, error } = await deps.admin
    .from('offers')
    .select('id, node_id, status, round')
    .eq('task_id', taskId);
  if (error) throw error;
  return (data ?? []) as { id: string; node_id: string; status: string; round: number }[];
}

/**
 * Which cascade pass this is: the count of prior `offered -> matching`
 * transitions on the task, from the trigger-written audit trail.
 *
 * The `resumeEpoch` shape from the optimize sweep, pointed at tasks. Derived
 * rather than stored for the same reason: a crashed pass recomputes the same
 * number from durable rows and collides on `offers_task_round_idx` instead of
 * opening a second offer for a round that already has one.
 */
async function cascadeRound(deps: MatcherSweepDeps, taskId: string): Promise<number> {
  const { count, error } = await deps.admin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('verb', 'task.transitioned')
    .eq('subject_type', 'task')
    .eq('subject_id', taskId)
    .eq('payload->>to', 'matching')
    // **Every return from dispatch, not only an expired or declined offer.**
    //
    // This counted `from = 'offered'` alone until slice 6, which was complete
    // while the only way back to `matching` was a settled offer. `20260906123000`
    // adds `escrow_funded -> matching` and `in_progress -> matching` for a node
    // who took work and abandoned it, and those do not pass through `offered`.
    //
    // Left as it was, a reassigned task would have re-derived **the round its
    // no-show already holds**: the insert below collides on
    // `offers_task_round_idx`, the `23505` arm reads the existing row back, and
    // that row is the no-show's **accepted** offer. The sweep would then move the
    // task to `offered` against it and write `offer.created` naming a third node
    // and an offer id that is not theirs. That is the second, independent
    // objection ADR-0019:54-62 raised against reintroducing an arc into
    // `matching`, arriving exactly as predicted.
    //
    // Excluding `escalated` rather than listing the states that count is the
    // safer shape: `escalated -> matching` is the owner's **first** dispatch, so
    // it must not be counted, and anything else that ever reaches `matching` is
    // by definition a return and should be. Arithmetically identical to the old
    // predicate today, since `settleOffered` and the owner's dispatch were the
    // only two producers, so **no live task renumbers**.
    .neq('payload->>from', 'escalated');
  if (error) throw error;
  return count ?? 0;
}

/** How many times this task has already come back from the marketplace. */
async function returnEpoch(deps: MatcherSweepDeps, taskId: string): Promise<number> {
  const { count, error } = await deps.admin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('verb', 'task.transitioned')
    .eq('subject_type', 'task')
    .eq('subject_id', taskId)
    .eq('payload->>from', 'matching')
    .eq('payload->>to', 'escalated');
  if (error) throw error;
  return count ?? 0;
}

/**
 * An offer event, carrying what the trigger cannot.
 *
 * Never throws: an event that failed to write must not undo the offer it
 * describes. `actor_kind` is `system` with no actor id, because the
 * authorisation was the owner clicking "Find an expert" and that act has its own
 * event with their id on it.
 */
async function writeOfferEvent(
  deps: MatcherSweepDeps,
  row: {
    project_id: string;
    verb: string;
    subject_id: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await deps.admin.from('events').insert({
    project_id: row.project_id,
    actor_kind: 'system',
    verb: row.verb,
    subject_type: 'offer',
    subject_id: row.subject_id,
    payload: row.payload,
  });
  if (error) {
    deps.log.error({ err: error, verb: row.verb }, 'an offer moved but its event was not written');
  }
}
