-- 20260913124000_feedback_message.sql — a verdict on a reply, not only on a card.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/10-architecture/learning-flywheel.md, docs/30-modules/chat-discord.md,
--       docs/40-adr/0021-a-labelled-ungrounded-tier.md,
--       docs/40-adr/0032-reasoning-providers-are-workspace-connectors.md
--
-- ---------- The half of the flywheel that had no subject ----------
--
-- `20260812130000` built `feedback_events` around `embed_id`, because at the time
-- every AI output a person could judge was a card: a plan to approve or send
-- back. That was true then and is no longer. The labelled ungrounded tier
-- (ADR-0021) answers in prose, carries no card by construction, and is the one
-- tier whose quality rests on the model rather than on the corpus, which makes it
-- the output most worth labelling and the only one that could not be labelled.
--
-- So the table gains a second subject. `embed_id` and `message_id` are siblings,
-- both nullable, and a row carries whichever one it was about.
--
-- **No cross-column constraint requiring exactly one.** It is tempting and it is
-- wrong here, because both columns are `on delete set null` and a room cascade
-- would then race: deleting a room deletes its messages and its embeds, and a
-- check demanding one of the two would turn an ordinary cleanup into a constraint
-- violation depending on which cascade Postgres ran first. The write path is
-- server-side and sets exactly one; the table declines to make a deletion order
-- into a failure.
--
-- ---------- Two verdicts, not a second table ----------
--
-- `helpful` / `not_helpful` join `approved` / `changes_requested` in the same
-- column rather than in a new one, because they are the same kind of fact: a
-- human's judgement of one AI output, captured at the moment it was made. The
-- correction rate that `learning-flywheel.md` calls the metric is read across
-- both. What differs is only what was judged, which `embed_id` and `message_id`
-- already say.
--
-- The pair is deliberately asymmetric with the card pair, and the wording is the
-- reason. A card asks for an authorisation, so its verdicts are `approved` and
-- `changes_requested`: consequences follow. A prose answer asks for nothing, and
-- `helpful` / `not_helpful` says what the reader got out of it without implying
-- anybody agreed to anything. Nothing downstream materialises from these two.
--
-- The check is dropped by its auto-generated name, confirmed against the live
-- catalogue first, exactly as `20260905130000` did for `retrieval_gaps_core_check`.
--
-- ---------- Append-only, and multiple labels are allowed ----------
--
-- No unique constraint on `message_id`. A person who reads an answer again next
-- week and changes their mind should be able to say so, and this table has no
-- UPDATE grant for any client, so the only way to record a changed mind is a
-- second row. The latest wins when the rate is computed; the earlier one is
-- evidence that it changed, which is exactly the sort of thing an append-only
-- label table exists to keep.
--
-- **The known gap stays known.** `20260812130000` grants `all` to `service_role`,
-- which includes UPDATE and DELETE on a table its own comment calls append-only.
-- That is a real inconsistency with `campaign_outcomes`, `events` and
-- `retrieval_gaps`, all of which revoke them. It is not narrowed here: this
-- migration adds a subject, and closing a grant that four writers currently rely
-- on nothing of is a separate change with its own blast radius. Recorded rather
-- than quietly inherited.

alter table public.feedback_events
  add column message_id uuid references public.messages (id) on delete set null;

alter table public.feedback_events
  drop constraint feedback_events_verdict_check;

alter table public.feedback_events
  add constraint feedback_events_verdict_check check (verdict in (
    -- A card, authorised or sent back. Consequences follow both.
    'approved',
    'changes_requested',
    -- A message, rated. Nothing follows but the number.
    'helpful',
    'not_helpful'
  ));

-- Partial, because the rows that carry a message are a minority of the table and
-- the query this serves is "every label on this message" rather than "every row
-- with no message". Same shape as `retrieval_gaps_room_idx`.
create index feedback_events_message_idx on public.feedback_events (message_id)
  where message_id is not null;

comment on column public.feedback_events.message_id is
  'The message being judged, for a verdict on prose rather than on a card. Nullable and '
  'sibling to embed_id; a row carries one or the other. on delete set null, so a deleted '
  'message leaves the label behind: subject holds what was actually judged.';

comment on column public.feedback_events.verdict is
  'approved / changes_requested judge a card, where consequences follow. helpful / '
  'not_helpful judge a message, where nothing follows but the number. Append-only: a '
  'changed mind is a second row, and the latest one wins.';
