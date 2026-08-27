-- 20260815230000_artifact_kind_answer.sql — what a person's answer IS.
--
-- `artifact_kind` offered `draft`, `analysis`, `asset` and `proof`, all of which
-- describe something produced FOR someone. When the plan hands a step to the
-- person, their reply is none of those: it is a decision only they could make,
-- and it completes the step rather than describing progress on it.
--
-- Found the hard way, and the way it failed is the point. The insert was rejected
-- for an invalid enum value, the failure was caught per task and logged, and the
-- run had **already consumed the question card**. So the person answered, the
-- card closed, no task moved, and nothing in the room said anything at all. The
-- ordering that makes a race safe is what made a failure silent; the caller now
-- reopens the card and says so.

alter type public.artifact_kind add value if not exists 'answer';
