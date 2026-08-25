-- 20260815210000_artifact_embeds.sql — the deliverable becomes something you can read.
--
-- An AI-owned step already produced a full artifact: a title, a body, and the
-- sources it rests on. Nothing rendered it. The person approved a plan, waited,
-- and saw silence, while the work sat in a table only a developer with SQL could
-- reach. A product that plans visibly and delivers invisibly is worse than one
-- that does neither, because it looks like it stopped.
--
-- The same two-row shape the plan card uses (a message plus its embed), and for
-- the same reasons: the message body stays legible anywhere the card does not
-- render, and the card is an enhancement rather than the only way to read it.
--
-- No policy or grant changes. `action_embeds` is already client-readable through
-- room membership and server-written with no client INSERT or UPDATE
-- (`20260812120000`), which is exactly right here: an artifact is evidence the
-- agent produced, and a client that could write one could fabricate delivered work.
--
-- Deliberately NOT given an action yet. Reviewing a deliverable is a real
-- decision and it belongs with the marketplace's maker-checker, not bolted on
-- now; this card reports, and reporting honestly is the whole gap.
--
-- `reported` exists for that reason. The other five states all describe a
-- **verdict** or the absence of one, and this card asks for neither: `pending`
-- would claim somebody owes it an action, and `approved` would record a decision
-- nobody made. `feedback_events` reads embed state as a training label, so an
-- invented approval here would become a labelled example of a human accepting
-- output they were only shown. Same reasoning that gave the question card
-- `answered` rather than reusing `approved`.

alter type public.embed_component add value if not exists 'artifact';

alter type public.embed_state add value if not exists 'reported';
