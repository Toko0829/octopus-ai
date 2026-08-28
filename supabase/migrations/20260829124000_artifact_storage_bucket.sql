-- 20260829124000_artifact_storage_bucket.sql — artifacts that are files.
-- Owner doc: docs/10-architecture/data-model.md
-- Also: docs/30-modules/business-projects-workflow.md
--
-- `artifacts.storage_path` has existed since `20260813160000` and travels the
-- whole way: the column, `Artifact.storagePath` in `packages/contracts`, the read
-- in `apps/api/src/routes/projects.ts`, and an arm in the project panel that says
-- "This one is a file rather than text." **Nothing could ever put anything
-- there**, because there was no bucket, no policy on `storage.objects`, no route
-- that could hand a file back, and no writer. The UI arm was reachable only by a
-- row nobody could create.
--
-- That migration said it was "deliberately NOT Storage yet" and gave the right
-- reason at the time: the only thing the AI produced was text, and putting a
-- paragraph of positioning copy in object storage means a fetch to read it and a
-- bucket policy to get right. What changed is not the reasoning, it is that the
-- creative side of the module produces files and needs somewhere to put them.
-- This closes the four gaps and nothing else.
--
-- **The path convention is the tenancy scheme**, which is why it is stated here
-- rather than only in the writer:
--
--     <project_id>/<artifact_id>/<filename>
--
-- The first segment is the tenant. The policy below reads it, and
-- `writeFileArtifact` in `apps/api/src/lib/artifact-files.ts` writes it. A file
-- stored anywhere else in this bucket is visible to nobody, which is the safe
-- direction for a convention to fail in.

-- A private bucket. `public = false` means the object URL is not guessable-and-
-- fetchable; every read goes through a signed URL minted by a route that checked
-- the caller first.
--
-- `on conflict do nothing` so the migration is replayable, matching how every
-- other idempotent insert in this directory is written.
insert into storage.buckets (id, name, public)
values ('artifacts', 'artifacts', false)
on conflict (id) do nothing;

-- Parse the tenant out of an object path, or return null.
--
-- A function rather than an inline cast in the policy, and the reason is a real
-- failure mode rather than tidiness. `((storage.foldername(name))[1])::uuid`
-- raises `invalid_text_representation` for any object whose first segment is not
-- a UUID, and Postgres does not guarantee that the `bucket_id = 'artifacts'`
-- test is evaluated first. One stray object anywhere in Storage could therefore
-- turn every member's listing into an error. Returning null instead makes such
-- an object invisible, which is the direction this should fail in.
--
-- `private`, never `public`: a helper in `public` is published at `/rest/v1/rpc/`
-- (`20260728160000`, and again in `20260813130000`). `search_path` pinned for
-- lint 0011.
create function private.artifact_object_project(p_name text)
returns uuid
language plpgsql
immutable
set search_path = storage, public
as $$
begin
  return (storage.foldername(p_name))[1]::uuid;
exception when others then
  return null;
end;
$$;

revoke all on function private.artifact_object_project(text) from public;
-- Evaluated inside a policy, so it is run as the querying role and must keep its
-- EXECUTE grant. `anon` keeps it for the reason `is_room_member` does: an
-- unauthenticated read must resolve to zero rows rather than a permission error.
grant execute on function private.artifact_object_project(text) to anon, authenticated;

comment on function private.artifact_object_project(text) is
  'The tenant a storage object belongs to, from the first path segment, or null when '
  'that segment is not a UUID. Null makes the object invisible rather than erroring '
  'the whole listing.';

-- One policy, and it is defense-in-depth beside the signed-URL route rather than
-- instead of it.
--
-- Both terminate in `private.is_project_member`, so the policy and the read path
-- answer the same question the same way **by construction**. That is the
-- `20260827110000` lesson stated as a design rule: a read path and a policy that
-- answer the same question differently is a defect waiting for somebody to fix
-- only one of them, and it cost this project 47 tasks and 28 of 58 artifacts the
-- last time it happened.
create policy "artifacts_objects_select_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'artifacts'
    and private.is_project_member(private.artifact_object_project(name))
  );

-- **No client insert, update or delete policy.** Server-written, like every
-- artifact row: a client that could write here could fabricate the evidence its
-- own task is judged on, and could do it without the `artifacts` row that makes
-- the file discoverable and auditable. Uploads go through `writeFileArtifact`,
-- which writes the object and the row together and removes the object if the row
-- fails.
