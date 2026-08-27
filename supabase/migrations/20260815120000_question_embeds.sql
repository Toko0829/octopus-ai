-- 20260815120000_question_embeds.sql — the Question card, and a state for it.
--
-- `discord-chat-spec.md` has specified a **Question** embed since Phase 0
-- ("Answer a batched user-only question", owner-only), and `action_embeds`
-- shipped without it because nothing produced one. Intake does: a whole-funnel
-- goal arrives too vague to plan, and the agent asks a batch of questions before
-- retrieval runs.
--
-- Two enum values, and both are additions rather than changes, so nothing
-- existing is touched.
--
-- **Why `answered` rather than reusing `approved`.** The four existing states
-- describe a verdict on a proposal: someone said yes, someone said no, or the
-- window closed. A question has no verdict. Recording an answered question as
-- `approved` would put a sentence in the audit trail that is simply untrue, and
-- `feedback_events` reads embed state as a training label, so an "approval"
-- nobody gave would become a labelled example of a person approving something.
-- `expired` is equally wrong: it means nobody acted in time, which is the one
-- outcome this is not.
--
-- The card is single-use for the same reason the plan card is. Without a state
-- to move it to, a second message in the room would be read as a second answer
-- to a question already answered, and the intake would loop.
--
-- ALTER TYPE ... ADD VALUE runs inside a transaction on PG12+, provided the new
-- value is not USED in that same transaction. This migration only adds; the
-- first row carrying either value is written by the application afterwards.

alter type public.embed_component add value if not exists 'question';

alter type public.embed_state add value if not exists 'answered';

-- No policy or grant changes. `action_embeds` is already client-readable through
-- room membership and server-written with no client INSERT or UPDATE policy
-- (`20260812120000`), and a question card needs exactly that: the person reads
-- it, and the answer arrives as an ordinary chat message rather than as a write
-- to this table. A client able to insert here could fabricate a question card,
-- and one able to update it could mark someone else's question answered.
