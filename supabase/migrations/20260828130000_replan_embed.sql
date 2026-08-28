-- 20260828130000_replan_embed.sql — a card for changing a plan that is running.
-- Owner doc: docs/30-modules/chat-discord.md
-- Also: docs/30-modules/business-projects-workflow.md
--
-- `ai-orchestrator.md` has specified "replan by diff, not regeneration" since
-- Phase 0 and nothing produced one, because there was no way to ask for a change
-- and no surface on which to approve it. `/replan` now proposes a diff; this is
-- the component that renders it.
--
-- **Why it is a card rather than an applied change.** A diff cancels planned
-- work, adds steps that will spend somebody's time, and rewrites what a step is
-- for. That is the same class of act as approving a plan in the first place, and
-- the plan card is the authorisation boundary this system already uses for it.
-- A replan applied without a card would be a change to a running project that
-- nobody agreed to, and the fact that a model proposed it does not make it agreed.
--
-- No new state value. A diff card is a proposal with a verdict, so `pending`,
-- `approved`, `rejected` and `expired` all mean exactly what they already mean,
-- unlike the question card, which needed `answered` because a question has no
-- verdict to record.
--
-- Split from the migration that adds the table and the function purely so this
-- value is never USED in the transaction that adds it, which PostgreSQL forbids.

alter type public.embed_component add value if not exists 'replan';

-- No policy or grant changes, for the reason `20260815120000` records:
-- `action_embeds` is already client-readable through room membership and
-- server-written with no client INSERT or UPDATE policy. A client able to insert
-- here could fabricate a diff card proposing to cancel its own approval step.
