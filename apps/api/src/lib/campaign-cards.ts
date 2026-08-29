import type { SupabaseClient } from '@supabase/supabase-js';
import type { TickReport, TickResult } from '@octopus/core';
import { CampaignEmbedPayload, type PlanCitation } from '@octopus/contracts';
import { requestCampaignDraft, type Proposal, type Citation } from './ai';
import { roomForProject } from './room-for-project';

/**
 * Posting the card that lets an owner authorise a campaign.
 *
 * **Why this exists at all.** `create_campaign` is `high_risk`, so `routeTask`'s
 * first rule parks the step at `needs_user` whatever the planner proposed. Until
 * now that was the end of the road: the step sat there, `notifyWaiting` said a
 * step needed the owner, and there was no surface on which they could say yes to
 * a campaign. The plan card is the authorisation boundary this system already
 * uses; this is the same boundary for the first act that commits money.
 *
 * **The detection rule reads the router's own verdict, not the step's words.**
 * A candidate is a task the tick parked at `needs_user` under
 * `high_risk_needs_authorisation`. Every `TickResult` already carries the rule
 * that fired, so this needs no vocabulary list of its own and cannot drift from
 * the one in `risk.py` that raised the tier in the first place. Whether the step
 * is actually a campaign, rather than an account connection or a publish, is
 * decided by the reasoning core, which is allowed to decline.
 *
 * **It never throws.** A tick that failed to post a card is worse than one that
 * did not, and much worse if that failure also unwinds work that already
 * committed. A step with no campaign card is still announced by `notifyWaiting`
 * and still answerable through its question card, so the degraded path is the
 * one that existed before this file.
 */

/** The rule that means the router stopped for an authorisation rather than for a person's knowledge. */
const AUTHORISATION_RULE = 'high_risk_needs_authorisation';

/**
 * Which of a tick's results are worth asking the core about. Pure, so the filter
 * can be checked without a scheduler or a database.
 */
export function campaignCandidates(report: TickReport): TickResult[] {
  return report.results.filter(
    (r) => r.outcome === 'needs_user' && r.decision.rule === AUTHORISATION_RULE,
  );
}

export interface CampaignCardInput {
  projectId: string;
  taskId: string;
  /** The project's currency. The card is denominated in it or the ceiling arithmetic is meaningless. */
  currency: string;
  citations: Citation[];
}

/**
 * Snake_case proposal to camelCase card payload.
 *
 * **Renamed field by field, never spread.** `planEmbedPayload` records what a
 * spread costs: the shapes differ by case, so `{...proposal}` type-checks, drops
 * every renamed field, and the payload silently defaults. Here the field that
 * would vanish is the channel, and a card that renders a default channel is a
 * card asking someone to authorise spend somewhere they did not choose.
 *
 * `budgetCap` is set to null unconditionally and there is no parameter for it.
 * The core has no budget field to offer and this function has nowhere to put one:
 * the owner types the number on the card.
 */
export function campaignEmbedPayload(
  proposal: Extract<Proposal, { kind: 'propose_campaign' }>,
  input: CampaignCardInput,
): unknown {
  // 1-based indices into the response's citations, exactly as the plan card
  // resolves them. An index out of range is dropped rather than rendered as a
  // source nobody can open.
  const citations: PlanCitation[] = proposal.citations
    .map((i) => input.citations[i - 1])
    .filter((c): c is Citation => Boolean(c))
    .map((c) => ({
      sourceId: c.source_id,
      label: c.label,
      url: c.url ?? null,
      effectiveDate: c.effective_date ?? null,
    }));

  return {
    projectId: input.projectId,
    taskId: input.taskId,
    name: proposal.name,
    objective: proposal.objective,
    channel: proposal.channel,
    budgetCap: null,
    currency: input.currency,
    summary: proposal.summary,
    citations,
  };
}

export interface CampaignCardDeps {
  aiServiceUrl: string;
  aiTimeoutMs?: number;
  log: {
    info: (o: unknown, m: string) => void;
    warn: (o: unknown, m: string) => void;
    error: (o: unknown, m: string) => void;
  };
}

/**
 * Ask the core for a campaign for each authorisation-blocked step, and post the
 * cards.
 *
 * One card per task forever, keyed on the task rather than on a run: the
 * scheduler routes a task once, so a replayed tick collides on the message key
 * instead of asking a person to authorise the same spend twice.
 */
export async function produceCampaignCards(
  admin: SupabaseClient,
  report: TickReport,
  deps: CampaignCardDeps,
): Promise<void> {
  const candidates = campaignCandidates(report);
  if (candidates.length === 0) return;

  try {
    const roomId = await roomForProject(admin, report.projectId);
    if (!roomId) {
      deps.log.warn(
        { projectId: report.projectId },
        'project has no room, so no campaign card can be posted',
      );
      return;
    }

    const { data: project, error: projectError } = await admin
      .from('projects')
      .select('currency')
      .eq('id', report.projectId)
      .maybeSingle();
    if (projectError) throw projectError;

    const currency = (project as { currency?: string } | null)?.currency ?? 'USD';

    const { data: tasks, error: taskError } = await admin
      .from('tasks')
      .select('id, title, detail, stage')
      .in(
        'id',
        candidates.map((c) => c.taskId),
      );
    if (taskError) throw taskError;

    for (const task of (tasks ?? []) as {
      id: string;
      title: string;
      detail: string | null;
      stage: string | null;
    }[]) {
      await postOneCard(admin, {
        roomId,
        projectId: report.projectId,
        currency,
        task,
        deps,
      });
    }
  } catch (err) {
    deps.log.error(
      { err, projectId: report.projectId },
      'could not draft campaign cards; the steps are still recorded as needing the owner',
    );
  }
}

async function postOneCard(
  admin: SupabaseClient,
  args: {
    roomId: string;
    projectId: string;
    currency: string;
    task: { id: string; title: string; detail: string | null; stage: string | null };
    deps: CampaignCardDeps;
  },
): Promise<void> {
  const { roomId, projectId, currency, task, deps } = args;

  try {
    // Cheap guard before spending a retrieval pass: if this task already has a
    // card, the core has nothing to add. The message key below is the durable
    // half; this only avoids the work.
    const { data: existing } = await admin
      .from('messages')
      .select('id')
      .eq('idempotency_key', `campaign-card:${task.id}`)
      .maybeSingle();
    if (existing) return;

    const draft = await requestCampaignDraft(
      deps.aiServiceUrl,
      {
        taskId: task.id,
        title: task.title,
        detail: task.detail ?? '',
        stage: task.stage,
        agentRunId: crypto.randomUUID(),
        projectId,
        roomId,
      },
      deps.aiTimeoutMs,
    );

    const proposal = draft.proposals.find((p) => p.kind === 'propose_campaign');
    if (!proposal) {
      // The core declined, which is a legitimate answer: the step may be an
      // account connection or a publish rather than a campaign, or the sources
      // may not support a channel. `notifyWaiting` has already told the room the
      // step needs the owner, so silence here is not a dead end.
      deps.log.info(
        { taskId: task.id, core: draft.core },
        'the core proposed no campaign for this step; it stays with the owner',
      );
      return;
    }

    const payload = CampaignEmbedPayload.safeParse(
      campaignEmbedPayload(proposal, {
        projectId,
        taskId: task.id,
        currency,
        citations: draft.citations,
      }),
    );
    if (!payload.success) {
      throw new Error(`refusing to store an invalid campaign payload: ${payload.error.message}`);
    }

    const { data: message, error: postError } = await admin
      .from('messages')
      .insert({
        room_id: roomId,
        author_id: null,
        author_kind: 'agent',
        body:
          `${payload.data.name}\n\n${payload.data.summary}\n\n` +
          'Nothing is published or spent until you approve this and set a budget.',
        idempotency_key: `campaign-card:${task.id}`,
      })
      .select('id')
      .maybeSingle();
    if (postError && postError.code !== '23505') throw postError;
    if (!message) return;

    const { error: embedError } = await admin.from('action_embeds').insert({
      message_id: message.id,
      room_id: roomId,
      component: 'campaign',
      payload: payload.data,
      required_role: 'owner',
      state: 'pending',
    });
    if (embedError && embedError.code !== '23505') throw embedError;

    deps.log.info(
      { taskId: task.id, projectId, channel: payload.data.channel },
      'posted a campaign card for the owner to authorise',
    );
  } catch (err) {
    // Per task, so one failed draft does not cost the others their cards.
    deps.log.error(
      { err, taskId: task.id, projectId },
      'could not post a campaign card for this step; it remains with the owner',
    );
  }
}
