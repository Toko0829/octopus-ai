-- 20260914120000_artifact_content_type.sql — what kind of file an artifact is.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/marketing-growth-engine.md,
--       docs/30-modules/business-projects-workflow.md,
--       docs/40-adr/0033-the-first-byte-producer-is-the-workspace-image-connector.md
--
-- ---------- What this adds ----------
--
-- `20260829124000` gave this system a private artifacts bucket and
-- `artifact-files.ts` gave it a writer, and until now that writer had exactly one
-- caller: a human node uploading proof of completed work. A proof is opened by
-- clicking Download, and a download does not need to know what it is downloading.
--
-- Slice 6 gives it a second caller and a different reader. A creative step on a
-- workspace with a Google connector now produces image bytes beside its brief
-- (ADR-0033), and the project panel has to decide, before fetching anything,
-- whether to render an `<img>` or offer a link. Without this column that decision
-- would be made by looking at the filename, which is a string this system
-- sanitises out of a model's own title and is therefore the wrong thing to route
-- rendering on.
--
-- ---------- Nullable, no backfill, no default ----------
--
-- Every row written before this one is a proof file whose type nobody recorded,
-- and inferring one now from `storage_path` would be a value written into a table
-- by guesswork, which is the shape of thing that stops being true quietly. NULL
-- means "nobody recorded what this is", which is what is true of them, and the
-- panel's answer to NULL is the behaviour those rows already have: offer the
-- download.
--
-- No default for the same reason `messages.model` has none. A default of
-- `application/octet-stream` would be this column asserting a fact about content
-- it never saw, on every text artifact in the system, where `body` is the content
-- and there is no file at all.
--
-- ---------- An open vocabulary with a length bound ----------
--
-- IANA media types are a registry somebody else owns and extends. A closed check
-- here would mean that the day a vendor returns a format we did not list, a step
-- which succeeded and produced real work **fails at the write** and the person
-- loses the output to a label. `messages.model` took the same decision one slice
-- back for the same reason, and it is the reason again rather than a convention
-- being copied: the value is a vendor's vocabulary, not ours.
--
-- The bound is what stops an unbounded string reaching a jsonb payload and an
-- HTML attribute. 255 is the practical ceiling for a media type with parameters.
-- **It is not a safety control.** What makes a browser treat these bytes as an
-- image is the content type Storage was given at upload, and what stops a
-- malicious one being served from our own origin is that the bucket is private
-- and every read is a short-lived signed URL against Storage's own host.

alter table public.artifacts add column content_type text;

alter table public.artifacts
  add constraint artifacts_content_type_length
    check (content_type is null or char_length(content_type) between 1 and 255);

-- ---------- And only on a row that is actually a file ----------
--
-- `artifacts_have_content` already says a row is inline text or a file and never
-- neither. This says the type describes the file half: a content type on a row
-- with no `storage_path` would be a claim about bytes that do not exist, and the
-- panel would then have a row that says "image/png" and has nothing to render.
--
-- It is the `messages_model_agent_only` shape, one table along, and it is the
-- half of the rule a constraint can carry. The other half is Node's:
-- `writeFileArtifact` sends the type it uploaded with, so the column and the
-- object agree because one call site writes both.

alter table public.artifacts
  add constraint artifacts_content_type_needs_a_file
    check (content_type is null or storage_path is not null);

comment on column public.artifacts.content_type is
  'The IANA media type of the stored object, as it was uploaded (ADR-0033). NULL on every text '
  'artifact, since there is no file, and on every file written before this column: no backfill, '
  'because a type inferred from a path afterwards is a guess recorded as a fact. An open '
  'vocabulary with a length bound and no closed check, for the reason messages.model has one: '
  'media types are a registry we do not own. Read by the project panel to decide whether to '
  'render an image or offer a download; it is not a safety control, since the bucket is private '
  'and every read is a signed URL served from Storage''s own origin.';
