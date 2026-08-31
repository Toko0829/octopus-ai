-- 20260903121000_matcher_selection_index.sql — the matcher reads tasks across
-- every project, which nothing has ever done before.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/human-nodes-marketplace.md
--
-- `20260813120000:145-147` gave `tasks` two indexes, and both are project-scoped:
-- `tasks_project_idx (project_id, position)` for reading a plan in order, and
-- `tasks_state_idx (project_id, state)` for "what is ready in this project". Both
-- serve the scheduler, which is driven per project by the ticker's loop over
-- active projects.
--
-- The matcher is the first reader that is not. It asks "which tasks anywhere are
-- waiting on the marketplace", because an offer's 48-hour clock has nothing to do
-- with which project the step belongs to, and walking projects to find two rows
-- would read every task in the system to answer a question about a handful.
-- Against `tasks_state_idx` that question is a sequential scan today and a
-- worsening one as plans accumulate.
--
-- Partial, and deliberately narrow. `matching` and `offered` are the only two
-- states the sweep selects on; `escalated` is not among them, because a task
-- reaches the marketplace by an owner clicking rather than by a sweep noticing,
-- and indexing it would invite exactly the poll this design decided against.
create index tasks_market_idx
  on public.tasks (state)
  where state in ('matching', 'offered');

comment on index public.tasks_market_idx is
  'The matcher sweep''s selection: tasks awaiting or holding an offer, across all '
  'projects. The other two task indexes are project-scoped and serve the scheduler.';
