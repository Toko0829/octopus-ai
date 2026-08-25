-- 20260813160000_artifacts.sql — what a task produces.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md
--
-- A task that ran and left nothing behind cannot be reviewed, disputed, or built
-- on. This is the row the maker produces and the checker reads.
--
-- Deliberately NOT Storage yet. data-model.md has artifacts carrying a
-- `storage_path`, which is right for a video edit or a signed PDF and wrong for
-- the only thing the AI produces today, which is text. Putting a paragraph of
-- positioning copy in object storage would mean a fetch to read it, a bucket
-- policy to get right, and a second place for the audit trail to live. `body`
-- holds inline output and `storage_path` arrives with the first artifact that is
-- genuinely a file.

create type public.artifact_kind as enum (
  'draft',      -- text the AI produced for a task
  'analysis',   -- research output
  'asset',      -- generated image / video / audio (storage_path)
  'proof'       -- a human node's evidence of completion (storage_path)
);

create table public.artifacts (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  project_id   uuid not null references public.projects (id) on delete cascade,
  kind         public.artifact_kind not null default 'draft',
  title        text,
  -- Inline output. Null for kinds that live in Storage.
  body         text,
  storage_path text,
  -- Which sources the output actually rests on, as document titles resolved at
  -- write time. Rule 10 applies to what a task produced as much as to the plan
  -- that proposed it, and the checker reads this rather than re-deriving it.
  citations    jsonb not null default '[]',
  -- Which run produced it, so an artifact can be tied back to the exact attempt
  -- and its trace (observability.md).
  task_run_id  uuid references public.task_runs (id) on delete set null,
  created_by   public.author_kind not null default 'agent',
  created_at   timestamptz not null default now(),

  -- An artifact is either inline or a file, never neither. A row with no content
  -- is a task that reported success and produced nothing, which is precisely the
  -- silent failure the checker exists to catch, so the database refuses it first.
  constraint artifacts_have_content check (
    (body is not null and length(trim(body)) > 0) or storage_path is not null
  )
);

create index artifacts_task_idx on public.artifacts (task_id, created_at desc);
create index artifacts_project_idx on public.artifacts (project_id, created_at desc);

alter table public.artifacts enable row level security;

create policy "artifacts_select_member" on public.artifacts
  for select using (private.is_project_member(project_id));

-- Client-readable, server-written, like every other workflow table. A client that
-- could INSERT here could fabricate the evidence its own task is judged on.
grant select on public.artifacts to authenticated;
grant all on public.artifacts to service_role;

comment on table public.artifacts is
  'What a task produced. Inline text in `body`, files in `storage_path`, never neither.';
