/**
 * The campaign card: the first thing on this surface whose approval commits money.
 *
 * Renders an `action_embeds` row of component `campaign`, produced by the
 * `campaign-v1` core. Approving it calls `materialise_campaign`, which creates
 * one campaign at state `ready`. Nothing here starts anything, and nothing
 * publishes anywhere in this slice.
 *
 * Three rules this component exists to hold.
 *
 * **The budget is an input, not a display.** Every other card shows what a model
 * proposed and asks yes or no. This one has a field the owner fills in, because
 * the reasoning core is never given a budget to propose: a figure it invented and
 * a figure a person authorised would be the same `budget_cap` on the same row,
 * and this is the surface where that difference is the whole point. The card says
 * so in as many words rather than leaving an unexplained empty field.
 *
 * **What will not happen is stated as plainly as what will.** Somebody entering a
 * number reasonably wonders whether money starts moving when they press approve.
 * It does not: the campaign is recorded and stops. Saying that here is the
 * difference between an authorisation and a surprise.
 *
 * **Money is tabular.** Rule 14, and the reason is alignment when a person
 * compares the figure they typed against the headroom they have left.
 */
'use client';

import { useState } from 'react';
import type { CampaignActionEmbed, MarketingChannel } from '@octopus/contracts';

/** Where it runs, as a word. Never colour alone (rule 15). */
const channelMeta: Record<MarketingChannel, { label: string; cls: string }> = {
  meta: { label: 'Meta ads', cls: 'chan-meta' },
  google: { label: 'Google ads', cls: 'chan-google' },
  email: { label: 'Email', cls: 'chan-email' },
  organic_social: { label: 'Organic social', cls: 'chan-organic' },
};

interface Props {
  embed: CampaignActionEmbed;
  /** True when the viewer owns the workspace. The server re-checks; hiding the
   *  buttons is presentation, not the control. */
  canAct: boolean;
  onAct: (
    embedId: string,
    action: 'approve' | 'request_changes',
    note?: string,
    budgetCap?: number,
  ) => Promise<void>;
}

export function CampaignCard({ embed, canAct, onAct }: Props) {
  const campaign = embed.payload;
  const channel = channelMeta[campaign.channel];

  const [busy, setBusy] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [budget, setBudget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pending = embed.state === 'pending';
  const approved = embed.state === 'approved';

  // Deduplicated by label, the way `PlanCard` already does it and for the same
  // reason: citations are per chunk, one document usually contributes several,
  // and printing its title five times makes one source look like five agreeing.
  // On the card that authorises spend, that is the reading that matters most.
  const cited = campaign.citations.filter(
    (c, i) => campaign.citations.findIndex((o) => o.label === c.label) === i,
  );

  // Parsed once and used for both the guard and the request, so the number the
  // button checks is the number the server is sent.
  const typed = budget.trim();
  const parsed = typed === '' ? Number.NaN : Number(typed);
  // Zero is legal and meaningful: email and organic social genuinely spend
  // nothing, and refusing it here would force a fictitious number onto a card
  // whose entire purpose is that the figure is true.
  const budgetValid = Number.isFinite(parsed) && parsed >= 0;

  async function act(action: 'approve' | 'request_changes') {
    setBusy(true);
    setError(null);
    try {
      await onAct(
        embed.id,
        action,
        action === 'request_changes' ? note.trim() : undefined,
        action === 'approve' ? parsed : undefined,
      );
    } catch (err) {
      // The spend cap refuses here with its reason in the message, so this is a
      // real answer rather than a generic failure: the owner reads why and can
      // enter a smaller number against the same card, which stays pending.
      setError(err instanceof Error ? err.message : 'Could not record that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`plan${approved ? ' approved' : ''}`}>
      <div className="plan-top">
        <div className="plan-eyebrow">
          <span className="pulse" aria-hidden />
          Campaign · needs your authorisation
        </div>
        <p className="plan-goal">{campaign.name}</p>
      </div>

      <div className="plan-stages">
        <div className="stage stage-single">
          <div className="stage-body">
            <ul className="plan-steps">
              <li className="plan-step">
                <div className="stage-title">
                  Where it runs
                  <span className={`owner ${channel.cls}`}>{channel.label}</span>
                </div>
                {campaign.objective ? (
                  <div className="stage-detail">{campaign.objective}</div>
                ) : null}
              </li>
              <li className="plan-step">
                <div className="stage-title">Why this channel</div>
                <div className="stage-detail">{campaign.summary}</div>
                {cited.length > 0 ? (
                  <div className="step-cites">
                    {cited.map((c) => (
                      <span className="cite" key={c.sourceId}>
                        <span className="dot" aria-hidden />
                        {c.label}
                      </span>
                    ))}
                  </div>
                ) : (
                  /* Same treatment PlanCard gives an uncited step. Rule 10 applies
                     to a spend proposal at least as much as to a plan step. */
                  <div className="step-uncited">Not backed by a retrieved source</div>
                )}
              </li>
            </ul>
          </div>
        </div>
      </div>

      {pending ? (
        <div className="plan-sources">
          <div className="plan-sources-label">
            Approving this publishes the campaign through your connected channel account. It will
            never spend more than the budget you set here, and you can pause it at any time.
          </div>
        </div>
      ) : null}

      {!pending && (
        <div className={approved ? 'plan-approved-banner' : 'plan-rejected-banner'}>
          {/* The cap arrives on the card through the action response now, so
              this reads the figure the owner typed rather than the null the
              card was posted with. A card fetched fresh carries it too. */}
          {approved
            ? campaign.budgetCap === null
              ? `Campaign approved in ${campaign.currency}. Publishing starts shortly.`
              : `Campaign approved at ${campaign.budgetCap} ${campaign.currency}. Publishing starts shortly.`
            : 'Campaign not approved. The step still needs you.'}
        </div>
      )}

      {pending && canAct && (
        <div className="plan-foot">
          {noteOpen ? (
            <div className="plan-note">
              <label className="auth-label" htmlFor={`campaign-note-${embed.id}`}>
                What should change instead?
              </label>
              <textarea
                id={`campaign-note-${embed.id}`}
                className="auth-input"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="The part that is wrong, and why."
              />
              <div className="plan-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setNoteOpen(false)}
                  disabled={busy}
                >
                  Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => act('request_changes')}
                  disabled={busy || note.trim().length === 0}
                >
                  Send it back
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="plan-note">
                <label className="auth-label" htmlFor={`campaign-budget-${embed.id}`}>
                  Budget you authorise ({campaign.currency})
                </label>
                <input
                  id={`campaign-budget-${embed.id}`}
                  className="auth-input mono"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="0.00"
                />
                {/* Said out loud, because an empty field with no explanation reads
                    as something the agent forgot rather than something it refuses
                    to do. */}
                <div className="step-uncited">
                  I do not propose a number here. The cap is yours to set, and it is checked against
                  what this project has already committed.
                </div>
              </div>
              <div className="plan-actions">
                <button className="btn btn-ghost" onClick={() => setNoteOpen(true)} disabled={busy}>
                  Request changes
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => act('approve')}
                  disabled={busy || !budgetValid}
                >
                  Approve campaign
                </button>
              </div>
            </>
          )}
          {error ? <div className="auth-error">{error}</div> : null}
        </div>
      )}
    </div>
  );
}
