# ADR-0033 — The first byte-producer is the workspace's image connector, and the brief stays the record

**Status:** Accepted · **Date:** 2026-09-04 · **Slice:** model connectors (slice 6 of seven; the creative byte-producer)

## Context

`artifacts` has carried a `storage_path` since [`20260813160000`](../../supabase/migrations/20260813160000_artifacts.sql) and nothing could fill it for a long time. [`20260829124000`](../../supabase/migrations/20260829124000_artifact_storage_bucket.sql) added the private bucket and its tenancy policy, and `apps/api/src/lib/artifact-files.ts` added the writer. Until now that writer had exactly one caller: a human node uploading proof that they finished a step.

The AI arm produced text and only text. A creative step, which `deliverable.py` classifies by the word "brief" and by the visual vocabulary around it, came back as a structured brief whose first sentence said, verbatim, that **this system cannot generate images yet**. That was the honest thing to write while it was true. [ADR-0032](0032-reasoning-providers-are-workspace-connectors.md) made it stop being true: a workspace can now connect its own Google key and route the `creative` role at an image model, and for one slice that route was a preference nothing read.

This decides what happens when it is read.

## Decision 1: the proposal says what to draw and Node draws it

`services/ai` emits a sixth proposal kind, `generate_image`, carrying a prompt, a count of one to three and one of four aspect ratios. It carries **no bytes and no credential**, and `apps/api` executes it with the workspace's own key.

The alternative was letting the Python service call the image endpoint and return base64. It is refused on the same grounds [ADR-0006](0006-python-ai-service-node-backend.md) drew the seam on, and each of the three is sufficient on its own. That service holds no storage key by design, so bytes arriving there would have nowhere to go except back across an HTTP hop built to carry sentences. A live customer credential would reach a second process that has no use for it. And a proposal is the shape every other act in this system takes: the core describes an act and the side that is allowed to act performs it, which is what makes `routeTask`, the spend cap and the plan card the only paths to anything consequential.

This is also the case ADR-0032 decision 2 reserved. Provider-native tools are admissible where they are **read-only or artifact-producing**, and this is the artifact-producing one: it writes a file into a tenant folder of a private bucket and touches nothing that publishes, spends, connects or pays.

## Decision 2: the brief is the deliverable and the images ride with it

A creative step produces its brief whatever happens to the pictures. The brief is what carries the citations, it is the record of what was asked for and why, and it is what a person hands to a designer when the generated image is not right. An image with no brief is an asset nobody can check.

Every failure path therefore ends in the same place: the step reaches `done`, the brief is delivered, and the room is told in **one sentence naming what happened** when the images are missing and the brief said they were coming. A refused key, a rate limit, a content refusal, an unreachable vendor and a storage failure each have their own sentence, because the person's next move differs across them and nothing else about the failure does.

**The count comes from the step, not from the model.** "Create a brief for 3 distinct paid hooks" is three, because the plan is what the owner approved and returning five would be the executor overruling them on the one detail they were specific about. It is capped at three on both sides of the seam: each image is a separate billed call on somebody else's account authorised by one approval of one step, so the ceiling is re-checked on the side that spends (rule 6).

**The prompt is built in code from the brief's own Concept and Art direction sections.** Asking the model for its own image prompt beside the brief would create a second deliverable that nothing renders and nobody reads, and the first time the two disagreed the picture would have come from the one that was never on the card. Deriving it means what was approved and what was drawn are the same words. Shot list and Specs are deliberately excluded: a shot list is three different frames, and folding them into one prompt asks for a single picture of three ideas.

## Decision 3: the brief's opening sentence is conditional, so the capability is never claimed falsely

`deliverable.py` now has two openings for the brief and one body. A workspace that cannot draw still reads "this system cannot generate images yet"; one that can reads that images will be generated from this brief.

**The capability is withheld from the core rather than ignored on the way back**, which is what makes that sentence trustworthy. The three conditions are checked before the request is sent: `IMAGE_GEN_ENABLED` is the deployment's kill switch, a missing route is a workspace that connected nothing, and `images` on the registry entry catches a route pointed at a model that cannot draw. Told it could be drawn and then drawing nothing, the product would have written a false statement into the deliverable itself, which is worse than an absent feature.

The corollary is that **a workspace with no Creative route gets no second message about it.** The brief already says so, in the deliverable, which is where that statement belongs; a room message repeating it would be noise on every creative step of every workspace that has connected nothing, addressed largely to members who could not connect one anyway.

## Decision 4: a file artifact records its own content type

[`20260914120000`](../../supabase/migrations/20260914120000_artifact_content_type.sql) adds `artifacts.content_type`: nullable, no backfill, no default, an open vocabulary with a length bound and a check that it appears only on a row that actually has a file.

The reader is the project panel, which has to decide between rendering an image and offering a download **before** it fetches anything. The alternative source for that decision is the filename, which this system sanitises out of an artifact title a model wrote, so routing rendering on it would mean a model choosing whether the browser is handed bytes as a picture.

No backfill, because every existing file is a proof whose type nobody recorded, and a type inferred from a path afterwards is a guess written into a table as a fact. No closed check, for the reason [`20260913122000`](../../supabase/migrations/20260913122000_message_model.sql) gave `messages.model` none: media types are a registry we do not own, and a vendor returning a format we did not list would fail a write on a step that succeeded and produced real work.

**It is not a safety control.** What makes a browser treat bytes as an image is the type Storage was given at upload, and what stops a hostile one being served from our own origin is that the bucket is private and every read is a short-lived signed URL on Storage's own host.

## Decision 5: the card counts the images and the panel shows them

`ArtifactEmbedPayload` gains the file ids and their content types, and never a URL. A signed download link is a ten-minute bearer credential; the payload is stored in `action_embeds` and re-broadcast on every room update, so a link in it would be a credential written to a table and handed to everyone in the room for as long as the row lives. The message stream also re-renders on every broadcast, so an inline `<img>` on the card would mint one fresh credential per artifact per re-render for every person with the room open.

So the card says how many images there are and where they live, and the panel mints exactly one link when one person clicks to see one. That is the same rule `ArtifactFileUrl` already states one layer down, applied to a surface that did not exist when it was written.

**The uncited warning does not appear under a generated image**, and that exception is narrow and was found by looking at the panel rather than by reasoning about it: three images produced three consecutive "No sources are cited for this, so treat it as unverified." lines. The sentence is not false, because an image genuinely carries no citations (decision 6). But rule 10 exists so an uncited **claim** cannot pass as grounded, and a picture makes no claim the corpus could have supported, while the brief it was drawn from sits directly above it with its own sources. Three repeats of a warning that means nothing in this position is how a reader learns to skip it where it does mean something. Every text artifact and every non-image file keeps the warning, and one shared predicate decides, so the card and the panel cannot drift on what counts as an image.

## Decision 6: review does not judge the images, and the artifact row is the asset

The checker in `@octopus/core` reads the brief. It has no opinion about a picture, and giving it one would mean inventing a quality bar for generated imagery that nobody has measured, on the surface whose whole value is that its rules are checkable. The images are written **after** the review passes, which is also what stops a brief that failed its own check from spending anybody's image quota.

`creative_assets` as a table of its own stays deferred. An artifact row already carries the project, the task, the run, the author and the storage path, which is everything that is true about a generated image today. **Trigger to build it: the first need for per-asset performance rows**, meaning an image whose impressions or CPA are measured separately from the campaign that carried it.

**A retry must not draw twice.** The executor is not durable, so a crash between the images and the delivery leaves the step to the heal sweep, and a second run of the same task would otherwise spend the customer's quota again for pictures they already have. The existing `asset` rows on the task are the idempotency key, exactly as the artifact id is the delivery message's.

## Decision 7: the flag is on by default

`IMAGE_GEN_ENABLED` joins the `PUBLISH_ENABLED` family rather than `CRAWL_ENABLED`. The rule `packages/config/src/env.ts` has followed since publishing is that a capability is off by default only when there is a stranger to protect; crawling reaches regulators' servers, and this reaches the vendor whose key the workspace owner pasted in themselves, spending their quota inside a step they approved.

It is a kill switch: set it to `false` and creative steps still produce their brief, and nothing is drawn.

## Rejected

**Bytes through the Python service.** Decision 1.

**An image checker.** There is no measured quality bar for generated creative, and a rule nobody can check is the kind of disposition this project has twice paid for pretending to enforce.

**Inline images in the chat stream.** Decision 5.

**Reading the aspect ratio out of the brief's Specs section.** That section is prose a model wrote and the ratio is a field the vendor validates, so parsing one out of the other would turn a wording change into a rejected call.

**Fixing the latent `count` defect in `build_execute_prompt` in this slice.** `instruction_for` honours a count and the executor has never handed it one, so a step asking for three variants still gets the prompt's default five. It is real and it is recorded in the function's own docstring. Fixing it changes the prompt every executed step is drafted with, and a prompt change in this repository is an eval pass rather than a line, so it does not ride in on an image slice.

## Consequences

- A creative step on a workspace with a Google connector produces a brief and up to three PNGs in the project's own folder of the private artifacts bucket.
- `artifacts` gains a nullable `content_type`; `ArtifactEmbedPayload` gains `projectId` and `files`; `Artifact` gains `contentType`.
- `services/ai` gains a sixth proposal kind and a `creative` capability on `ExecuteRequest`, and still holds no key, no storage and no bytes.
- The customer's images live in a private bucket under the project's own prefix, so [security-compliance.md](../10-architecture/security-compliance.md)'s tenancy argument covers them unchanged.
- Nothing that publishes, spends, connects or pays gained a path. A Creative route remains a preference about who proposes.
