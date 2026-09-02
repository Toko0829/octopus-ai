# Module: Design System & Frontend

> Owns the **implemented** token system, component library, and the Next.js UI shell — the code embodiment of the "Ink & Bioluminescence" house style, including the Discord chat shell, command palette, and adaptive theming. **Enforces the anti-slop rules in code.**
>
> **Owner paths:** `apps/web/**` · **Depends on:** chat-discord (renders the chat model), auth-identity (role-based UI), ai-orchestrator (renders inline agent stream + embeds), infra-devops (build).
>
> **`packages/ui` is named in `.docmeta.yml` and does not exist.** It was written down as an owner path before anything was built and has stayed there since. There is one consumer, so extracting the components into a workspace package today costs build wiring and buys nothing; the tokens live in `apps/web/app/globals.css` and the library is the stylesheets beside it. The mapping is kept so that the day a package appears it already has an owning doc.
>
> The design language + tokens are specified in [design-system.md](../20-design/design-system.md); this doc owns the **implementation**. Update both together on any token/component change.
>
> **Implementation status (Phase 1, in progress):** the **Discord-style chat shell** at `/app` now runs on **live data, with no mock or demo content anywhere**. Sign-in (`/sign-in`, Supabase GoTrue) gates the workspace via middleware; reads happen in the Server Component; the browser talks to Fastify only through the thin BFF at `/api/bff/*`; messages arrive over Realtime and sends are optimistic, reconciled on the server copy. House style via design tokens in `app/globals.css` + `app/app/chat.css`, type (Fraunces / Hanken Grotesk / JetBrains Mono via `next/font`), light + dark skins.
>
> **A blocked step now says what it is waiting for.** `TaskRow` renders a `work-waiting` line under the owner line when `blockedBy` is non-empty and the step is `pending` or `blocked`. From `ready` onward the scheduler has already proved every hard dependency satisfied, so the line would be describing a queue that had cleared. Before this, twelve of fifteen steps on a live project read "Not started" with nothing to tell them apart, which is the same sentence a step that is simply next in line gets.
>
> - **Two sentences, and the difference is the point.** "Waiting on: A, B" is a wait that will clear on its own. A dependency that was cancelled or failed can never satisfy `task_deps_satisfied`, so that step is stranded until somebody changes the plan, and the copy says exactly that instead of naming a queue position that will not arrive. The wording carries the distinction, so a reader who cannot tell the two treatments apart loses nothing (rule 15).
> - **The dead-end variant is weight, not red**, because `--red-500` measures 4.00 as text on the light panel. Measured before it was spent rather than after, which is the habit the token history below argues for.
>
> **The campaign card** (`CampaignCard.tsx`) renders a `campaign` embed, and it is the first card on this surface whose approval commits money. It reuses `PlanCard`'s classes and footer and holds three rules of its own.
>
> - **The budget is an input, not a display.** Every other card shows what a model proposed and asks yes or no; this one has a field the owner fills in, because the reasoning core is never given a budget to propose ([ADR-0011](../40-adr/0011-spend-cap-checked-twice.md)). The empty field is explained on the card in as many words, since an unexplained blank reads as something the agent forgot rather than something it refuses to do. Approve stays disabled until the number parses, and **zero is accepted**: email and organic social genuinely spend nothing, and refusing zero would force a fictitious figure onto the one card whose whole point is that the number is true.
> - **What happens next is stated as plainly as what just happened, and this sentence has now changed once.** It used to read "nothing is published or spent", which was true while the campaign stopped at `ready`. Approving now publishes it on the next pass ([ADR-0013](../40-adr/0013-approving-a-campaign-publishes-it.md)), so the card, the approval notice in the room, the chat intro and the connect callback were all rewritten in the same commit. **A promise on a trust surface is altered where it was made, or not at all**: leaving any one of them saying "nothing is published" while the sweep published would be the worst copy defect this surface can carry. The callback's line was the least obvious of the four, since connecting an account can now unblock a campaign already approved and waiting, so its old "Octopus will ask you before anything uses this connection" stopped being true without anybody editing that page. The approved banner still repeats the figure and the currency, because the cap is the reassurance that survives.
> - **Money is tabular** (rule 14), on the card and in the panel, because the figure a person typed is read against the headroom they have left. The channel is a labelled chip rather than a colour, since "which channel" is exactly the fact being authorised (rule 15). An uncited campaign gets the same "Not backed by a retrieved source" treatment `PlanCard` gives an uncited step: rule 10 applies to a spend proposal at least as much as to a plan step.
>
> **The project panel shows what each campaign spent**, in a Campaigns block between the budget and the steps. It is the first surface for `campaign_outcomes`, and it ships in the same slice as that table's first writer deliberately: `detail.campaigns` was itself an instance of this repository's most-repeated defect, fetched by the API on every open and rendered nowhere, so adding a writer without a reader would have extended it rather than closed it.
>
> - **Null is "No numbers yet", never `0`.** A zero on a spend figure claims a day was measured and found to have none, which is a different sentence from "this has not been read yet" and the wrong one to show somebody wondering whether their money is moving. Same rule the budget block already applies to a null ceiling, which it renders as "Nothing yet" rather than as "no limit".
> - **Every state is a word**, through a `CAMPAIGN_STATE_COPY` map covering all eight, with the dot as decoration (rule 15). `publishing` deliberately does not read as "live": the campaign machine keeps those apart because claiming the platform confirmed something it has not is an untrue sentence, and it would be the same untrue sentence here, on the surface where somebody decides whether their money is moving. The channel is a labelled chip rather than a hue, since which channel is the fact being reported.
> - **Nothing renders that the engine did not produce.** No cost per acquisition, no click-through rate, no projected finish. Those are derived, and this is the surface whose whole claim is that the figures are the ones that were measured. Clicks and conversions appear only when something measured them. Money is `mono` for tabular numerics (rule 14), because these figures are read directly against the budget block above them.
> - "Measured through" renders the **day before** `period_end`, since that column is the exclusive end of a closed UTC day and printing the boundary itself would tell somebody their campaign was measured through tomorrow.
>
> **The Campaigns block gained the ceiling control and the resume path** (ADR-0014). Each campaign shows its cost per conversion ceiling ("None set" when null, which abstains rather than blocks, the documented inversion of the budget's null), with owner-only editing on the budget control's exact shape: seed from the current value, a separate explicit clear button whose copy says what clearing means ("Octopus stops judging this campaign"), save then refetch. **No computed CPA appears anywhere**, on the block's standing derived-ratios ban: the ceiling is an input a person typed, and the decision-time arithmetic lives in the room message and the event payload. A campaign paused for `cpa_breach` explains itself in words and, for the owner, carries a resume button whose warning sits **before** the click: a still-crossed ceiling re-pauses on the next check, and learning that from the button would read as the product fighting the person. Two new classes (`work-campaign-reason`, `work-campaign-actions`) beside the existing `.work-campaign-*` family; everything else reuses `auth-*`, `plan-note`, `plan-actions` and the `btn` family.
>
> Every class and token was checked against `globals.css` before shipping, which is now a habit rather than a note: `--danger`, `--hairline` and `--warning` are three separate occasions this file records of a declaration that reads as working and quietly does nothing.
>
> **The project panel gained a budget block**, showing authorised, committed and available in tabular numerics, with owner-only editing. A null ceiling renders as "Nothing yet" and says plainly that no campaign can be approved until a budget is authorised, never as "no limit": that is the column's documented stance, and a panel reading it the other way would describe an open account. Clearing the ceiling is its own button rather than an empty field, because it is a different decision from lowering a number and should not be reachable by deleting one.
>
> **The node surface** (`app/node`) is the first page in this product that does not belong to a workspace owner, and that is why it is a route rather than a panel. A node is admitted to a task thread and to nothing else, so rendering the owner's shell around somebody who can see almost none of it would have been a screen that lies about what it contains. Light Editorial on the sign-in and consent precedent, a single column of cards, no new tokens, and the four classes it needed added to `consent.css` beside the flow it shares a shape with. Five rules, and every one of them is a place the page could have been dishonest.
>
> - **Status is words plus a dot, never colour alone** (rule 15). Two `Record<>` maps cover every `kyc_status` and every `availability` value, the dot carries `aria-hidden`, and somebody who cannot tell the tints apart reads exactly the same page. Same discipline as `ConnectedAccounts`' `STATUS_COPY`.
> - **A disabled control says why.** Availability cannot be set to available until identity is verified, because a table constraint says so, and the control is disabled with the reason printed beside it rather than silently doing nothing. `ineligibilityReason` in `@octopus/marketplace` is a pure function returning that sentence, so the copy is tested rather than typed into JSX.
> - **Nothing claims to be verified when it is not.** Every skill and licence is labelled "Claimed" or "Claimed, not verified", because `verified` is false on all of them and nothing in this slice can set it true. There is no upload control either, and the page says why: we do not want somebody's identity document until we can keep it properly.
> - **A verified, available node is told there is no work yet.** That is the cold-start sentence, and it lives in `NO_WORK_YET` in `@octopus/marketplace` so the place it gets deleted when the matcher ships is one constant rather than a search. Same honesty as `waiting.ts`'s "I cannot bring one in yet".
> - **The verification log is absent and the page says so.** The subject of a `node_verifications` row is refused it by grant, because a face-search result names a third party. An empty list would have read as a bug; a sentence explaining that the record exists and is not theirs to read is the true thing.
>
> **`/node/verify` is the fake verifier's own screen**, the direct counterpart of `/connections/fake-consent` and reusing its stylesheet. It exists for the reason the consent page's Cancel button exists, plus one more: three of the five KYC arcs are only reachable if a check can come back as something other than a pass, so the outcome is something a person clicks. It opens by saying "This checks nothing", because a screen that looks like identity verification and is not would be the worst copy defect this surface could carry.
>
> **Routing reads a row, not a role.** A signed-in person with no workspace is sent to `/node` when they have a `node_profiles` record, and a node who also owns a workspace gets a link in the top bar instead. The branch reads the row rather than `profiles.role`, which still authorises nothing anywhere; the top-bar link exists because this repository already recorded that a structurally correct home nobody opens is not a home.
>
> **The plan-change card** (`ReplanCard.tsx`) renders a `replan` embed: a diff against a project that is already running. It reuses `PlanCard`'s classes and its approve / request-changes footer, and holds three rules of its own.
>
> - **Every op is shown and labelled with a word.** A person is authorising the removal of planned work, so the card cannot summarise: "3 changes" is not something anybody can agree to. `Add` / `Cancel` / `Update` each carry their own label, their own explanation, and a tint that is a second signal on top of the word rather than the thing carrying it (rule 15). The strike-through on a cancelled title is decoration on top of the `Cancel` label, never the only cue.
> - **A cancelled step is named.** The op references a task by UUID, so the payload carries `taskTitle` beside it; when it is absent, because the card predates the field, the id is shown rather than hidden, since a reference the reader cannot resolve still beats a change they cannot see.
> - **The consequence people do not expect is on the card.** Cancelling a step does not release what waits on it, and reading that after approving is much worse than reading it before.
>
> **`ProjectPanel` gained a way to ask.** The panel could unstick one step and could not say "this plan is wrong"; without that the only way to change direction was to abandon the project and post a new goal, discarding every deliverable already produced. The affordance is owner-only and its copy promises a proposal rather than an edit, because that is what it does: the diff arrives in the chat as a card and nothing changes until it is approved.
>
> **The plan card is now rendered on real data.** `PlanCard.tsx` reads an `action_embeds` row of component `plan`, produced by the `grounded-plan-v1` core. Three rules it holds:
>
> - **All six funnel stages render, always.** A stage with no steps is meaningful output, not absent output: it says the corpus had nothing in scope. Hiding it would read as "this plan has four parts" rather than "two stages are unsupported", and the second is what lets a reader judge the plan.
> - **A step with no citation is labelled, not merely styled the same.** Uncited claims cannot gate action (rule 10), so the card must not let one pass as grounded. The label is text, never colour alone.
> - **Nothing renders that the planner did not produce.** The earlier draft showed an estimated cost and timeline; both came from mock data. Displaying invented figures on the one surface whose purpose is to be checkable would undo the grounding it advertises, so they are gone rather than filled in.
> - **A step that spends, publishes or connects an account says so before it is approved.** A risk chip sits beside the owner chip for `high_risk` ("Needs your approval") and `external` ("Uses an outside service"), word plus icon and never colour alone (rule 15). It is shown for **those two tiers only**: `reversible` covers most of a plan, and a badge on every step is a wall people learn to skip, which costs more on an approval surface than it buys. New semantic tokens `--warn` / `--warn-quiet`, deliberately not coral: coral already means "a human does this", and a step the AI may not run alone is a different claim from a step a person performs. One hue asserting both is how a badge stops meaning anything. The palette needed **two** amber steps, measured rather than assumed: a single `--amber-500` as the chip text computes to **2.34** against its own wash on the light skin, failing AA on the skin the design system calls primary, exactly as `--on-accent` did before the last review. `--amber-700` light and `--amber-400` dark measure **5.23** and **7.15**.
>
> **Approve / request-changes are live**, shown only to the workspace owner and only while the card is `pending`. Hiding them is presentation, not the control: the server re-checks membership, `required_role` and state on every action, so a forged call is simply refused. A failed submit **keeps the note on screen**, because it is the person's writing and discarding it is the fastest way to lose their trust in the button. Card state renders as text, never colour alone. `plan-types.ts` is deleted: the shapes moved to `@octopus/contracts`, as its own comment said they should once something produced a plan.
>
> **The card is patched in place after an action, not re-fetched.** Re-loading the stream would scroll the reader away from the thing they just acted on.
>
> Two defects found by actually clicking through it, both of which type-checking could never have caught:
>
> - **Approval and rejection shared a banner style.** "Changes requested" rendered on the teal accent, which reads as success, so the colour contradicted the words beside it. Stating both states in words is necessary but not sufficient: the colour must not fight the text. Rejection now has its own neutral treatment.
> - **Citations are per chunk, so one document appeared three times.** Three chunks from a single source rendered as three identical entries, which reads as three independent sources corroborating the plan when there is one. That overstates how well-supported the plan is on the exact surface built for checking it. The card now groups by document (`[1][2][3] Title`) and counts documents rather than chunks, keeping chunk-level numbers so a step citing `[2]` stays traceable. Per-step citation lists are deduplicated for the same reason.
>
> **A citation with a URL is now a link, and until crawled sources existed there was nothing to link to.** The card has always said "grounded in N documents" and the reader could not open any of them: the whole corpus was internally authored, so a citation named a document only we held. Four externally-sourced documents now carry a publisher, an address and the date the page was read, and `PlanCitation.url` has carried that through the contract from the beginning. A source without a URL stays plain text rather than being styled as a dead link, since an affordance that only fails when used is worse than none. The external-link arrow is paired with visually-hidden text rather than carrying the meaning alone (rule 15), which needed a `.sr-only` utility the stylesheet did not have.
>
> **Still deliberately not rendered** (no backend, and a trust surface must not show invented numbers): the budget figure in the top bar, and unread counts. The ⌘K palette lists only actions that work.
>
> **A plan card is fetched immediately after its message is broadcast.** Realtime carries the `messages` row only, and the embed lives in a table the trigger cannot see, so a broadcast-delivered agent message always arrives with `embed: null`. The ordinary catch-up does not repair this either: it fetches `seq > highest`, and the message that needs the card _is_ the highest. So an agent message triggers one targeted re-fetch from `seq - 1`, guarded by a ref so it happens once per message. Only for agent messages: re-fetching on every broadcast would turn live delivery back into polling.
>
> **`mergeMessages` never lets an absent embed overwrite a present one.** The broadcast copy of a message has no embed even when a card exists, so a plain `set` would make a rendered card vanish on the next broadcast. Absence there means "not included", never "there is none". Verified against the live database: the pipeline produced a six-stage plan with five stages filled and one legitimately empty.

> **`ActionEmbed` is now a union, and `PlanCard` takes the narrowed variant.** A second card exists (`question`, written by intake), so a component that renders a plan says so in its own signature rather than accepting the union and re-narrowing inside. A card whose `component` says `plan` and whose payload is a question is a bug the boundary should reject, not something to render half of.
>
> **The question card is not rendered yet, and that is survivable rather than broken.** The questions are in the message body in plain text, which is the same rule the plan card follows: the card is an enhancement of a readable message, never the only way to read it. A person sees the questions and answers in the composer, which is how the answer reaches the agent anyway. A dedicated card, with the slots shown and inferred values marked as guesses, is the improvement this leaves on the table.

> **The deliverable is now rendered, and until it was the product looked like it stopped.** An approved AI step wrote a full artifact, title, body and cited sources, into a table only a developer with SQL could reach. A person approved a plan, waited, and saw nothing. `ArtifactCard.tsx` renders an `action_embeds` row of component `artifact`, posted by the executor the moment a step passes review. Same two-row shape as the plan card, so the work stays legible in a notification or any client that does not know the type.
>
> Three rules, all of them the plan card's applied to work rather than to a proposal. **An uncited deliverable is labelled**, in words rather than colour: rule 10 says uncited claims cannot gate action, so the card must never let one pass as grounded. **Nothing renders that the agent did not produce**, so no invented dates or progress figures on the surface whose purpose is checking. And **it reports rather than asks**: there is no approve button, because reviewing a deliverable is a real decision belonging with the marketplace's maker-checker, and a button recording a verdict nobody considered is worse than no button. The embed's state is `reported` for the same reason, since `feedback_events` reads that column as a training label.

> **A stuck step can be dealt with where you are looking at it.** Every step in `needs_user` or `escalated` carries its own control, shown to the workspace owner only (presentation: the server re-checks ownership on every call). The two states offer different things because they genuinely are different. `needs_user` offers **Answer this**, since the plan asked a question only that person can answer. `escalated` offers **I will do this one** and **Try again**, because the expert it was assigned to cannot be brought in, and the copy says that rather than implying somebody is on their way.
>
> Their write-up is recorded against that step and the panel re-reads the whole project rather than patching the row: an approved step satisfies its dependents and a retry can produce an artifact, so patching only the row that was clicked would leave every consequence of the click stale, which on a progress view is the same defect as showing nothing at all. A failed submit keeps their text on screen, for the reason the plan card already does.
>
> **The control names the step, which is the point.** Answering in chat means the room has to infer whether a sentence was an answer or a new request, and getting that wrong silently discards whichever it was. That has cost real requests. A button on a named step cannot be misread.

> **The whole project is now something you can look at, not just the last thing it said.** `ProjectPanel.tsx` opens from the top bar and lists what every approved plan in this workspace became: each step, its state in words, who owns it, and the deliverable it produced. The badge on the button counts steps waiting on the person, and is hidden at zero because a badge reading 0 is noise.
>
> It re-reads when a message lands rather than polling, because the things that move the number (a plan approved, a tick routing steps) all announce themselves in the room, so the badge changes when something actually happened. A failure there is deliberately silent: it is a count on a button, and a banner about it would be louder than the thing it describes. The panel reports its own errors.
>
> Four rules, three of them the plan and artifact cards' rules applied to a wider view of the same work. **Every state is named in words** beside its dot, so the colour is decoration and a reader who cannot distinguish hues loses nothing (rule 15). **Waiting and escalated are separated**, and the escalated copy says no expert can be brought in yet rather than implying one is coming. **Nothing renders that the engine did not produce**: no percentage invented from stage order, no estimated finish date, counts are counted. **An uncited deliverable is labelled in words**, because being displayed beside grounded work must not let it pass as grounded (rule 10).
>
> Loading and empty are kept distinct, which is this panel's own lesson turned on itself: it exists because an absent view was indistinguishable from an idle system, so "nothing here" is never shown while a request is still in flight.
>
> Every token it uses was checked against `globals.css` before shipping, and one did not exist: `--danger` was written from habit and is not in this system. That is the third time this file has recorded that defect, after `--hairline` and `--warning`, and it is the argument for the CI grep the anti-pattern section already asks for.

> **A file deliverable is now something you can open.** That arm of the artifact block used to be one sentence, "This one is a file rather than text.", describing something with no control beside it, and it was unreachable anyway because nothing could write a file until `20260829124000`. It is a **Download** button now, and three things about it are deliberate.
>
> **The link is fetched on click, never with the project.** A signed URL is a bearer capability, good for ten minutes without signing in, so shipping one inside the project payload would mint a download credential for every file the moment the panel opened and keep it in memory for as long as it stayed open.
>
> **A blocked pop-up is shown rather than swallowed.** `window.open` after an await is exactly what a pop-up blocker stops, and a button that appears to do nothing is worse than a link somebody clicks themselves; when the tab is refused, an "Open the file" link takes its place.
>
> **The control is `work-action`, not a new style.** A download reads as the same weight of thing as the other actions in this panel, and one more bespoke button is how a design system stops being one.

## Responsibilities

Turn the house style into shipped, accessible, themeable React — and make it **hard to ship slop** (lint/guardrails).

### Two dead ends in the shell, closed

**The rail's `+` had no handler at all.** Room creation lived only in the empty state, which stops rendering the moment you have one room, so a person with one workspace could not make another and the button that looked like the way to do it did nothing. That is the affordance-that-lies this design system's own rule against dead buttons exists to prevent. `CreateBusinessPanel` now creates the room and **selects it**, which `CreateRoom.tsx` does not: that component calls `router.refresh()`, so the new workspace would appear in the rail while the person kept looking at the old one.

**`AddSourcePanel`** is where somebody tells Octopus what their business is: a description, a page to read, or a `.md`/`.txt` file read in the browser and dropped into the same box. No upload endpoint and no storage, because the text is the payload. It is shown only to the workspace owner, and the composer button is **absent** rather than disabled for everyone else, since an affordance that only fails when used is worse than none.

Both reuse `.cmdk-scrim`, so there is one overlay treatment rather than a second that drifts from it. Every token used was checked against `globals.css` before shipping: the first draft referenced five that do not exist, which is precisely the defect recorded when `chat.css` was found referring to `--hairline` and `--warning` and silently doing nothing.

## Agent messages in the stream

Posting a message also starts an agent run (`startAgentRun`), and the reply arrives over Realtime as an ordinary member message with `authorKind: 'agent'`, rendered with the accent bar and **Agent** badge. Two rules the client holds to:

- **A failed agent run never invalidates a sent message.** The send and the run are separate awaits; if the run cannot start, the message stays sent and the failure surfaces in its own banner.
- **Live updates failing is never silent.** If the browser cannot read the session, or the channel errors or times out, a banner says so. The page would otherwise look perfectly healthy while quietly showing stale data, since the server-rendered first paint succeeds regardless.

## Layout: the scroll chain

The shell is a full-height grid whose panes scroll independently. **Every ancestor of a scrolling pane needs `min-height: 0`.** Flex and grid items default to `min-height: auto`, which refuses to shrink below the content's intrinsic height, so the child's `overflow-y: auto` never receives a bounded height and the content simply overflows and is clipped by `.shell`'s `overflow: hidden`. The symptom is a message list you cannot scroll once it fills the viewport. This applies to `.main` → `.stream`, `.sidebar` → `.chan-list`, and the `.rail` and `.context` panes.

The stream sits its content at the bottom with `margin-top: auto` on the first child, **not** `justify-content: flex-end`, which clips overflow at the top of a scroll container in some engines and makes the oldest messages unreachable.

Auto-scroll follows new messages **only when the reader is already within 80px of the bottom**. Someone who has scrolled up to read history is never yanked to the end.

## Build-time traps worth knowing

- **`useSearchParams` needs a Suspense boundary.** Reading it at the top level of a route opts that route out of prerendering and **fails `next build`**, while `next dev` passes cleanly because dev does not prerender. `/sign-in` reads `?next=` and so splits into an inner form wrapped in `<Suspense>`. Run `pnpm build`, not just `pnpm dev`, before claiming a page works.

- **`next build` while `next dev` is running fails, and the error names the wrong thing.** They share `.next`, so the dev server's writes land under the production build and it dies with `PageNotFoundError: Cannot find module for page: /sign-in/page`, which reads like a missing route rather than a corrupted output directory. Stop the dev server, `rm -rf apps/web/.next`, then build. The same build passed minutes earlier in the same session, so the failure looks like a regression in whatever was edited in between.

- **An authenticated route must declare `dynamic = 'force-dynamic'`, not infer it.** `/app` used to become dynamic only as a side effect of `await cookies()` throwing Next's dynamic-usage bailout. But `createClient()` validates the Supabase env _before_ it reaches `cookies()`, so with no env the page throws an ordinary `Error` first, Next never receives the bailout signal, and the build fails trying to prerender a page that was never prerenderable. The failure is invisible locally, because a present `.env.local` lets execution reach `cookies()` and the route turns dynamic by accident. **CI builds with no Supabase env at all, and that is deliberate:** it proves the build depends on no runtime config. Verify a build the way CI runs it (`NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= pnpm build`) rather than only the way your machine runs it. Confirm the route lands as `ƒ (Dynamic)` in the build's route table.

## Empty and failure states

Every surface that can be empty or broken says which it is, and says it in terms the reader can act on. `EmptyWorkspace` distinguishes "you have no rooms yet" from "the API did not answer", and the failure copy names **the URL actually tried** (from `API_URL`) rather than a hardcoded port, because the message is read precisely when that value has been overridden. Message-level state (`sending`, `not sent`) is text, never colour alone, and a failed send keeps the text on screen instead of discarding what the person wrote. See [`DEVELOPMENT.md`](../../DEVELOPMENT.md) for the port-override setup this copy refers to.

## The landing page

`app/page.tsx` + `app/landing.css` + `components/landing/*`. Rebuilt on 2026-09-01 against **hermes-agent.nousresearch.com**, measured on computed values at a 1912px viewport and recorded in the [reference map](../20-design/design-system.md#reference-map-real-products-what-we-take). The previous page was honest and on-token and, at desktop widths, a document: every section head in a narrow left column, the right two thirds bare paper, five sections on the same eyebrow / title / paragraph rhythm. The reference's structure is what it lacked, and that structure is now this page's, in our palette, with our copy and our subjects ([ADR-0027](../40-adr/0027-the-landing-is-an-ink-ground-with-a-paper-panel.md)).

### The page is four layers

```
.curtain     fixed, z1     the footer, revealed when the content lifts off it
.hw-scroll   relative, z2  the content, opaque, one viewport of bottom margin
  .ground    sticky        the water plate, the eight arms, the twelve motes, grain, scrim
  nav · hero · preview · surfaces · .ledger (the paper panel)
.frame       fixed, z100   the ink border around the viewport
```

**The ground is sticky, not fixed, and the reason is the curtain.** The scroll layer has to be opaque, because the footer sits behind it waiting to be revealed as the content runs out; a fixed plate behind a transparent layer would show the footer through every section. The plate is therefore a sticky element inside an absolutely positioned track that covers the scroll layer, pinned for its length and gone with it. **The first version put `margin-bottom: -100dvh` on the sticky element instead of using a track**, and the water stayed pinned one full viewport past the end of the content, exactly over the footer: a sticky element's constraint is its containing block minus its own margins, so the negative margin extended the range by the amount it was meant to cancel. Found by scrolling to the end and seeing the water where the footer should have been.

**The scale unit.** `--u: max(100vw / 2360, 0.58px)` on `.hw`, with `--edge` (93u), `--gap` (30u) and `--frame` (2.5 · (0.5vw + 0.5vh)) derived from it. The reference is designed at 2360 and scales linearly with a floor, and this is the one place the page departs from the 4px grid: the frame and the section rhythm scale with the viewport, component internals stay on `--sp-*`. `vw` rather than the reference's `cqw`, because container units need `container-type` on an ancestor and that applies layout containment, which would position the fixed curtain and frame against the page instead of the viewport.

**Type.** Fraunces upper-case at `--fw-normal` for every display heading: the reference sets its serif at 300 and ours has `opsz` doing that work. h1 at `clamp(44px, 120u, 96px)`, section heads at `clamp(32px, 64u, 56px)`. Upper-case text has no descenders, so its leading is tighter than the prose token: 0.92 on the h1 and 1.0 on section heads, against the reference's 0.88 and 1.0. Everything that is not a heading is JetBrains Mono: eyebrows and labels upper-case at `--ls-eyebrow`, prose at `--text-sm` / `--lh-prose` in sentence case. The reference sets its paragraphs upper-case too, and that was not taken: a 14px upper-case paragraph is a label pretending to be prose.

**Buttons are square, paper on ink, with a real shadow.** 42px tall, mono, `0 4px 14px rgba(0,0,0,.25)`, and `.btn-primary` carries a 3px teal rule on its leading edge. Inside the paper panel they invert to ink on paper. The pills are gone with the hero that had them.

### What each section is, top to bottom

- **Nav** (`.nav`): absolute, a `1fr auto 1fr` grid with the wordmark centred, section links left, sign-in and the app button right. It scrolls away with the hero and the curtain repeats the links. **The first version listed `.nav` beside `main` in the rule that lifts scrolling content above the ground, and the higher specificity made it `position: relative`**: in flow, full width, and 22px past the viewport edge. One selector, removed.
- **Hero** (`HeroSplit.tsx`): one centred column over the water, with the eight arms of light rising through it. The reference fills its right half with an engraving and ours did too, for an afternoon: an octopus seen from below, which the owner rejected as creepy, and which was the literal creature brand.md has always said the mark must not scale into. With the picture gone the copy sat beside half a viewport of nothing, so the two-column split went with it. The composer is still the page's one ask and the disclaimer still sits under it (the mercury.com rule, kept). The h1 is three deliberate lines.
- **Preview** (`ProductFrame.tsx` + `CitationProof.tsx`): the chat shell in a frame, showing the finished plan with the agent's working pulse live, then the operable plan card beside its argument. **`PlanTheatre` and its scroll-scrub are gone, and framer-motion with them.** The theatre pinned for 220vh, needed 44 kB of framer-motion that this doc flagged the day it landed, and defaulted to the finished plan on every failure path anyway. The reference shows its product as one looping video in a frame; the honest equivalent for a product whose output is an interface is the interface at rest. The frame chrome (`.th-*`) is the theatre's, unchanged.
- **Surfaces**: the reference's three download cards, as the three surfaces the product has: the room, the plan, the thread. Each carries an engraving, a mono line and a paper button.
- **The ledger** (`LedgerPanel.tsx`): the paper panel. Inset by `--frame`, lifted `126u` into the section above it the way the reference's panel overlaps its downloads, `overflow: clip`. Inside: the mark as a sticky badge in the left margin; six entries for the six beats of the loop, numbered `#1 Tell` … `#6 Learn` because the loop is a real sequence and the number encodes order; the three drawn mechanisms from `StepScenes.tsx`, which stay diagrams because a diagram must change when the mechanism does; the four refusals from `LimitCard.tsx`, unchanged; and the wordmark at `clamp(112px, 24.3vw, 480px)` in `--teal-300` at 28%, clipped by the panel edge, which is the reference's closing move and the one bold thing on the page.
- **Curtain** (`CurtainFooter.tsx`): fixed, 100dvh, behind everything. The human-nodes render that was a band in the middle of the page is its backdrop, arm of light narrowing to the coral node, with a second ghost wordmark behind the copy. The page's one ask, repeated. Below 900px it is an ordinary block at the end of the document, because a fixed 100dvh footer on a phone is a known trap.

### Motion

- **`lenis` smooth scrolling** (`SmoothScroll.tsx`, `lenis@1.3.26`). Mounted in an effect, `autoRaf`, destroyed on unmount, and **not constructed at all under `prefers-reduced-motion`**. Nothing else imports it: it drives `window.scrollY`, so the reveal observers and the limit-card replay keep their native listeners. The library's four recommended rules are in `landing.css` verbatim; `scroll-behavior: auto` while it drives matters, or an anchor click smooth-scrolls twice.
- **The sweep** (`.sweep` inside every `Engraving`): the reference's hover, a diagonal band of paper, accent and ground on a 300% canvas, `background-position` animated 15% → 75% over 2.2s, `opacity` the only thing that transitions. On while the figure, the surface card or the entry is hovered or focused, `soft-light` blend, and dead under reduced motion by the global rule.
- **Ambient motion is still one thing:** the arms breathing and the motes rising on the ground, and the agent's pulse in the frame. The reveals (`motion.tsx`) survive for the step scenes and the limit cards only, with the same `html.js` gate and one-second backstop.

### The engravings

`Engraving.tsx` + `tools/art/engrave.mjs`. Nine subjects, generated as black ink on white paper in the owner's ChatGPT (the prompt is the style block in the script header), masters kept in the gitignored `tools/art/engravings/src/`, and split by the script into four encodes each: `-paper-1x/-2x` (the ink as it is, for the panel, `mix-blend-mode: multiply`) and `-ink-1x/-2x` (inverted and tinted `--teal-300`, for the water, `mix-blend-mode: screen`). Both start from one levelled greyscale, so they are one drawing on two surfaces. The tint is baked in the script rather than done in CSS because a filter chain that reliably lands on one hue does not exist, and the hue carries meaning. `sharp` is resolved from the workspace, where Next already has it, so the pipeline adds no dependency. Why generation is permitted here and nowhere else is in [ADR-0027](../40-adr/0027-the-landing-is-an-ink-ground-with-a-paper-panel.md).

### Verified

Measured on 2026-09-01 at a 2124px viewport (the widest available), in Chrome, on the running dev server.

- **Build.** `next build` from a clean `.next`: `/` is `○ (Static)` at **11.4 kB / 114 kB first load**, down from 49.2 kB / 152 kB. framer-motion left the route and `lenis@1.3.26` arrived; the shared chunks are unchanged at 103 kB. `/app` stays `ƒ (Dynamic)`.
- **No horizontal overflow**: `scrollWidth` 2107 against `innerWidth` 2124 (the difference is the scrollbar). The 22px overflow the first version had was the nav selector defect above.
- **Composited contrast**, 119 text nodes, **zero AA failures**. Text on the water is measured against the lightest 24px block of the plate (`rgb(50,113,118)`, found by sampling the encode on a canvas), never the average; the curtain against the reach plate's lightest block composited with its scrim at 0.15. Tightest per surface: water **6.18** (the frame caption), curtain **7.23**, ledger paper **4.82** (`--text-faint`), plan card **4.61** (`--text-faint` on `--surface-2`), the five chip tones **5.09 to 5.20** composited over their card. The first sweep reported the chips at 3.55 to 3.67 and was wrong: Chrome serialises a `color-mix()` background as `oklab(… / 0.12)`, and a regex that reads the first three numbers of that string reads Lab coordinates as RGB. The chips were re-measured by painting the colours through a canvas, which parses any CSS colour and composites the alpha, and the earlier figure of 5.14 for `--human` on its wash reproduced exactly.
- **Prerendered HTML with no client**: 6 entries, 4 refusals, all 16 stage rows across the frame and the proof, both composers as real forms, all 9 engraving `<img>`s, the frame and the curtain, and **no em dash** in the body.
- **Curtain**: at the end of the document the footer is fully revealed with its composer focusable; `html.lenis` is stamped, so the controller mounted.
- **Engravings**: 9 masters, 36 encodes, 5.5 MB on disk in total; every one is below the fold and `loading="lazy"`, so the first paint carries no engraving bytes.
- **Anti-pattern checklist, by hand**: no violet or indigo anywhere in the source, no sparkle glyph, no gradient text, no `backdrop-filter`, the ground is `#060c13` and the curtain `#050b10` (never `#000`), the only glow is the agent pulse in the frame, and the AI lives inside the framed room rather than in a corner bubble.

**Not verified in this pass, and worth doing by eye.** The browser pane could not be resized below the desktop width (the window reported 2124px whatever was asked), so the **900px and 375px layouts are unmeasured**: the hero stack, the curtain becoming a static block, the panel grid falling to one column. The CSS for them is written and typechecks against nothing, which is exactly the kind of claim this doc has learned not to make. Reduced-motion was likewise not emulated; `SmoothScroll` returns before constructing under the media query and the reveal, sweep and pulse all sit under the global reduced-motion rule, but nobody has watched it.

## The connect flow's two pages

`/connections/fake-consent` and `/connections/callback` are the first surfaces
outside `/app` and `/sign-in`, and they follow the sign-in precedent rather than
the landing one: Light Editorial, quiet, no picture. **The moment somebody is
deciding whether to hand over access to an account is not the moment for an
interface with opinions.**

**Cancel comes before Approve, in the DOM and on screen.** On a page whose entire
job is asking permission, the refusal has to be at least as reachable as the
approval. They are the same size; only weight distinguishes them.

**The consent screen lets scopes be unticked**, and says what that costs in
words. A person who removes a permission is told the steps needing it will stop
and ask them, rather than discovering it as a failure three days later.

`ConnectedAccounts` lives in the **room rail**, and it started out in the wrong
place. It was first built into the project panel, which was structurally
defensible (a connection is room-scoped and that panel was the only other
room-scoped surface) and wrong in practice for a reason the structure hid: that
panel is called "The work", it opens as a modal from the top bar, and nobody
looking for account settings opens it. The first person to use the feature could
not find it. Putting it behind a project view also implies a connection belongs
to a project, which is the exact impression room-scoping exists to avoid.

The rail is the room's own column, always visible, already holding the other
room-level fact: who is in it. An account the workspace is connected to is the
same kind of fact, so it sits beside the members rather than behind a button.
**This is the second surface in this module to move for the same reason**, and
the pattern is worth naming: a placement that is defensible from the data model
can still be unreachable in the product, and only the second question is the one
a user experiences.

Status is a word plus a dot and never a colour alone (rule 15), and expired reads
differently from disconnected because the actions differ. An empty list says
plainly that Octopus cannot publish or spend anywhere until an account is
connected, which is the honest version of an empty state on a surface about
permissions.

**The fake is labelled as a test provider on both surfaces.** Somebody about to
click through a consent screen should know what is on the other side of it, and
"fake" appearing as a provider string in a row is not that.

## Token implementation

CSS variables in **two** layers today, primitive → semantic. Two skins exist (**Light Editorial** default, **Dark Command Deck**); **Warm Chat** and the per-business accent are specified and not built. Components never hardcode primitives.

> **What the reference pass on mercury.com changed (2026-08-28).** Measured in-browser on computed values rather than read off a screenshot; the method and what we deliberately declined to take are recorded in [design-system.md](../20-design/design-system.md#how-a-reference-enters-this-system).
>
> - **Radius tightened to 4 / 8 / 12 / 20 / 32.** The reference puts 4px on 108 of its rounded elements and never exceeds 12px on a card. Ours started at 6/10/14 and read softer than a product that holds somebody's money should. `--r-2xl` is new, for full-bleed panels.
> - **The spacing grid now has a section scale** (`--sp-14/18/24/32` = 56/72/96/128) plus `--container` and `--gutter`. It used to stop at 48px, which is the whole reason the landing page's margins were hand-written: there was no token for the distance between two sections, so the page had no rhythm to inherit.
> - **Line height and tracking are ramps bound to size**, five and six steps. The shell carried **15 ad hoc line-heights across 10 distinct values** and no token, so the vertical rhythm had been decided fifteen times and agreed nowhere.
> - **The weight band is capped at 520.** It ran 400 to 700, and a `font-weight: 700` in a system whose own doc asks for "light weights at large sizes" was a contradiction nobody had read closely enough to notice. The reference never exceeds 480 and its whole band is 120 points wide.
> - **Hairlines became alpha** (`color-mix` against transparent) instead of fixed ramp steps. The dark deck is where the fixed value hurt most: one `#24272e` sat on four different surfaces and looked right on one of them.
> - **Shadows are three layers at very low alpha** rather than two heavier ones, matching the reference's contact / weight / distance structure.
> - **Interaction state is a colour wash**, `--state-hover/-active/-selected`, not opacity. Twelve places faded the whole element on hover, which fades the label with it: the text loses contrast at the exact moment somebody points at it.
> - **Motion durations are 150 / 200 / 300 / 500** with easing split by purpose, `--ease-state` for a symmetrical state change and `--ease-enter` for something arriving.
>
> The twelve raw `border-radius` values in `chat.css` were swept onto the tokens in the same pass; the raw `6px`/`10px` counts that looked like radii turned out to be paddings, which is why the sweep was done by reading the declarations rather than by matching numbers. **The remaining ~330 hardcoded px in `chat.css` are not yet migrated**, including 7px, 5px, 11px and 13px, which are off the 4px grid entirely. That is the next piece of work and it is the reason the grid did not hold: a hand-written `7px` is easier to type than the token that should have replaced it.

## Typography implementation

Display / body / mono faces wired as CSS vars; the type scale plus two fluid steps (`--text-title`, `--text-display`); **tabular numerics** utility applied to all monetary/tabular contexts. Type steps ship as utilities (`.t-display`, `.t-title`, `.t-heading`, `.t-prose`, `.t-label`, `.t-eyebrow`) so that a size, its line height and its tracking travel together and choosing a size stays one decision.

> **`font-optical-sizing: auto` was a no-op from the day it was written.** It sits on `.display` in `globals.css`, but `next/font` ships the `wght` axis alone unless the others are named, so the browser had no optical size to select and the hero rendered in the text cut of Fraunces at 50px. `layout.tsx` now requests `axes: ['SOFT', 'opsz']`. This is the same defect class as `--hairline`, `--warning` and `--danger`: a declaration that reads as working and quietly does nothing.

## Component library

- **Chat shell** (Discord 5-region) — see [discord-chat-spec.md](../20-design/discord-chat-spec.md).
- **Inline agent stream** — accent bar + Agent tag + streaming + working pulse (never a bubble).
- **Action embeds** — Approve / Pay / Sign / Assign / Accept; state + `required_role` enforced.
- **Plan / approval cards** — cited, effective-dated, cost-estimated.
- **Dense tables** — Command Deck density; hairline; tabular numerics; conditional status color paired with text/icon.
- **Command palette (⌘K)** — action + shortcut-on-right (Superhuman/Raycast).

## Theming engine ("chromatophore")

Skin switching (Light Editorial / Dark Command Deck / Warm Chat) + density modes (compact/cozy/spacious) + per-business accent. Theme toggle stamps the active skin on the root; light+dark parity mandatory.

## Motion implementation

Framer Motion with the motion tokens; **spring** for tactile surfaces (chat/onboarding); near-instant for the command deck; **glow only for live agent/presence**; `prefers-reduced-motion` honored (static indicator replaces the pulse animation).

## Accessibility enforcement

Role via **badge + icon**, never color alone; WCAG AA contrast in both skins; keyboard-first + ⌘K; visible focus rings.

> **AA applies to de-emphasised text too, and the first ramp did not honour that.** Measured in-browser against the shell backgrounds, three text tokens failed: light `--text-muted` at **4.42** and `--text-faint` at **2.64**, and dark `--text-faint` at **4.21**. Two of the three failures were on the **light** skin, which the design system calls the primary aesthetic.
>
> Fixed by adding `--ink-450` and `--ink-550`. A single ramp step could not serve as "faint" in both skins, because `--ink-500` sits just under the line from both directions (4.42 on light, 4.21 on dark). Every tier now clears AA on its own skin: light **10.54 / 7.02 / 4.82**, dark **11.11 / 7.06 / 6.08**. The practical consequence is that **quiet text has less room than it appears to**: a three-tier hierarchy has to compress into the range above 4.5 rather than fading toward the background.
>
> **`--on-accent` was white, and that failed on every primary button** — 3.74 on light, **2.07** on dark, including the sign-in CTA. It is now `--ink-950`, measuring 5.16 and 9.30, which also keeps the button identical across skins where flipping to white in one of them would not. The token is the single control point: `.btn-primary`, `.send` and `.auth-submit` all read it.
>
> Verified by computing contrast for every rendered text node on `/` and `/sign-in` in both skins: **zero failures**. `/app` was **not** covered, because it requires an authenticated session; the token fixes propagate to it but element-level contrast there is unverified.

> **`--human` was failing AA on the light skin, in seven places, and had been since it was written.** Found by re-running the sweep over the rewritten landing page, where a "A person does this" chip came back at **3.93**. `--human` was `--coral-600` (`#e14e35`), which measures 3.93 on `--surface` and **3.47** on its own `--human-quiet` wash, and it is the text colour for every human-node marker in the shell.
>
> Fixed by adding `--coral-700` (`#b8371f`), measuring **5.83** and **5.14**. On dark, `--coral-400` already measures 7.88 and 6.14 and is untouched. This is the amber lesson repeated exactly: a hue that carries text needs **two steps below the mid tone**, because one value cannot clear AA on both skins, and the failure always lands on the light skin, which is the one the design system calls primary. `--role-node` moved with it.
>
> **This is the fourth colour token in this file to have been chosen by eye and measured wrong afterwards**, after `--text-muted`, `--text-faint` and `--on-accent`. The pattern is not carelessness about contrast, it is that a mid-tone hue on a white surface looks obviously legible and is obviously legible, at 3.9. The only reliable move is to measure every token that colours text at the moment it is written.
>
> **And `--red-500` is the fifth, found by measuring before spending it rather than after.** The project panel's new waiting line wanted a "this dependency is a dead end" variant, and the obvious choice was the colour `.work-state.stopped` already uses. Measured first: `#d9524a` is **4.00** against `--surface` on light and **4.53** on dark, so as small text it fails AA on the skin the design system calls primary. The variant uses full-strength `--text` instead, and the sentence carries the distinction in words, which is what rule 15 asks for. **The two existing text uses of `--red-500` are pre-existing debt and are recorded here rather than widened**: `.work-error` and `.work-resolve-error`, both in `apps/web/app/app/chat.css`, both inside `/app`, which the anti-slop sweep has never covered because it needs an authenticated session. Its three other uses are backgrounds (the stopped state dot and two badges), where this ratio is not the test. A `--red-700` two steps down is the same fix `--human` and the amber tokens took, and it is the change to make when `/app` is swept. Counted rather than remembered: `grep -rn 'color: var(--red-500)' apps/web` returns exactly those two.
>
> Landing page swept again after the fix, both skins, 62 text nodes each: **zero failures**. Tightest ratio is 4.82 on light (`--text-faint`) and 5.70 on dark. Re-checked at 375px and 1280px with no horizontal overflow at either.

## Icon system

One customized icon set (consistent stroke); no color-only meaning. `components/chat/icons.tsx` holds the set.

**The brand mark is not part of it.** It lives in `components/brand/Logo.tsx` and is re-exported from `icons.tsx` so the chat's three existing call sites keep working. One drawing in one place, because this file has already recorded what happens otherwise: two copies of `.sr-only` drifted, and the copy inside `PlanTheatre` had started with its own duplicate of the path before it was pointed at the shared one.

The mark's design decisions and the reason its floor is 13px rather than the brief's 16px are in [brand.md](../20-design/brand.md#logo-built). The two things that matter to implementation: it is `fill="currentColor"` with the eyes knocked out by `fill-rule="evenodd"`, so it needs no second colour and works inside the tinted agent avatar; and the favicon is a separate file at `app/icon.svg`, picked up by Next's App Router convention, so there is no `<link>` to maintain and no `public/` directory to invent.

## Frontend architecture

RSC for reads; streaming; **ts-rest** typed client from `packages/contracts`; optimistic sends reconciled on Realtime broadcast; the BFF stays thin (proxies mutations, never runs long work).

## Anti-pattern checklist (reviewed by hand)

**There is no lint rule and no CI check for this, by decision.** The repository already runs enough CI that adding more measurably slows development, and the cost would be paid now against a benefit that arrives later. See the [amendment to ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md#amendment-2026-08-28-enforcement-is-a-review-checklist-not-ci), which is where the earlier "enforced in lint/CI" claim is retracted.

What replaces it is this list, walked by whoever reviews a change that touches a surface. Each pass is recorded below with what it found, because a checklist with no findings history is indistinguishable from one nobody ran.

**The list.** Reject: violet / 2-stop purple gradient · sparkle, ✨, "magic" or "AI" badges as decoration · default un-customized shadcn + Inter + zinc · glassmorphism as a crutch · conic or neon ambient glows (glow is live agent and presence only) · pure `#000` dark · a corner chatbot bubble · emoji-as-UI · gradient text · em dashes in product copy (rule 22).

**Cheap ways to walk it**, none of which need CI: `grep -riE '#(7|8|9)[0-9a-f]{2}(5|6|7)[0-9a-f]' apps/web` for the violet families, `grep -rn '✦\|✨' apps/web --include=*.tsx` for decorative glyphs, `grep -rn 'backdrop-filter\|background-clip: text' apps/web`, and the contrast sweep described under Accessibility enforcement, which is a paste-into-the-console script rather than a build step.

> **These checks are not automated yet, and the first manual pass found two things.** A **`✦` sparkle glyph** decorated the landing page's eyebrow label, which the avoid-list bans twice over (sparkle-as-decoration and emoji-as-UI). And `--role-pro: #7a5cff` was the **only violet value in the repository** — declared in all three skin blocks, referenced **zero** times, with a comment claiming it was "used only as a role marker" while `.badge-pro` actually reads `--human`. Both removed; the source now contains no violet or indigo at all.
>
> Everything else on the list passed on inspection: fonts are Fraunces / Hanken Grotesk / JetBrains Mono rather than Inter; dark is `#0d0e11` rather than `#000`; the one `backdrop-filter` is a 2px blur on the ⌘K scrim rather than glassmorphism as a crutch; glow appears only on the agent working pulse; the two `position: fixed` elements are that scrim and a centred toast, not a corner chatbot bubble; gradients are two-stop avatar fills within one hue, and no `background-clip: text` exists.
>
> **Second pass, 2026-08-28**, walked over the rewritten landing page and the token layer. Nothing on the list was found. The page contains no violet or indigo, no decorative glyph, no gradient, no `backdrop-filter`, no `background-clip: text`, and no em dash in product copy; the dark skin is `#0d0e11`; the one place with a glow is still the agent working pulse. What the pass **did** find was an accessibility failure the list does not cover, recorded under Accessibility enforcement: `--human` had been failing AA on the light skin in seven places since it was written.
>
> That is the argument for keeping the checklist and the contrast sweep as two separate habits. The list catches things that look wrong. Only measurement catches things that look fine.

## Copy conventions

Product copy follows the brand voice ([brand.md](../20-design/brand.md)): **no em dashes** (—) in any user-facing text (landing, chat, plan cards, agent messages, labels). Use a comma, colon, period, parentheses, or a middot (·) instead. Enforced as [AGENTS.md](../../AGENTS.md) rule 22; lint/CI should flag em dashes in `apps/web` strings.

## Key entities

`packages/ui` components · design tokens (CSS vars) · theme definitions · chat UI components · command-palette actions.

## The marketplace surfaces (slice 4)

**`/node` gains an offers section.** Open offers show the step's title, its funnel
stage in words rather than the planner's token, its description, and when the
offer runs out. Settled offers stay on the page as a quiet history line, because a
list that empties after a decline reads as though the decline lost something.

**Accept was rendered and disabled, with its reason printed beside it**, for the
length of slice 4. Omitting it would have been worse: a node reading work they
cannot take has no way to tell whether accepting is coming, broken, or something
they failed to qualify for. Slice 5 makes it live, and **both the disabled state
and the sentence beside it are gone** rather than left behind as a control that
lies about itself.

**Declining is two steps**, because it cannot be undone: the cascade moves on and
`offers_task_node_idx` means this node is never asked about this step again. The
confirm step carries an optional reason and says plainly that it is final.

**The expiry timestamp renders client-side only.** Formatting a date during a
server render produces the server's locale and time zone and then disagrees with
what the browser renders, which trips a hydration mismatch; the ISO date renders
first and is replaced after mount.

**`ProjectPanel` gains a third action on an escalated step**, "Find an expert",
beside "I will do this one" and "Try again". The refusal sentences from the route
(an unmappable stage, an empty pool) surface verbatim in the existing alert line,
so a step that cannot be staffed keeps all three controls and says why.

Two copy retirements ride the same change, because a promise altered on a trust
surface has to be altered where it was made: the panel's project flag no longer
says "and none can be brought in yet", and the chat digest no longer says "I
cannot bring one in yet, so these are paused rather than under way."

**Once dispatched, the step shows a status label and no controls.** `matching` and
`offered` already had copy in `STATE_COPY` ("Finding an expert", "Offered to an
expert"); the `stuck` set stays `needs_user | escalated`. There is nothing useful
to offer the owner while a stranger is deciding.

## The marketplace surfaces (slice 6)

**The node's engagement card gained its first controls.** Since slice 5 it showed
a state line and a thread and offered nothing to do; `WorkPanel` adds "Start
work", "Hand this over", and the resumed-after-rejection case, which reuses the
same button with different copy because it is the same act.

**Which control appears is driven by `task.state` and nothing else.**
[ADR-0016](../40-adr/0016-an-engagement-has-no-state-of-its-own.md) says
`tasks.state` is the only state an engagement has, so a local idea of where the
work has got to would drift the moment the owner acted in another tab.
`WORK_STATE_COPY` needed no change: it was written when the machine was declared
in full, which is what that table exists for.

**The hand-over form reuses `node-confirm`**, the offer confirm's own class,
because handing work over is the same weight of act as accepting it. Two new
classes and no new tokens: a wrapper that separates the controls from the thread
below them, and a file input, which this product has never had. **The file input
is the native control restyled rather than replaced**: a custom picker is a button
that lies about being an input, and it loses keyboard behaviour, drag and drop,
and the browser's own "3 files selected" text, all of which somebody using a
screen reader gets for free from the real thing.

**A bounced submission keeps everything on screen.** The floor check refuses
before anything is written, so the step has not moved and the form is what they
need to fix; clearing it would be the fastest way to lose their trust in the
button, which is the trade `ResolveStep` already makes. A criterion that was left
blank is marked with **a word** ("still blank"), never a tint (rule 15).

**`ProjectPanel` gained `ReviewWork`**, a separate control from `ResolveStep`
rather than a third arm of it. The two ask different questions: `stuck` means the
plan cannot continue without you, `reviewable` means somebody has finished work
and is waiting to be paid. Sharing a component would have meant a
`stuck || reviewable` predicate and four buttons whose meaning depends on which
arm matched.

**The proof is already on screen and this control does not repeat it.** A node's
proof is an `artifacts` row on the same task ([ADR-0022](../40-adr/0022-proof-is-an-artifact.md)),
and the owner is a project member, so it renders in the deliverables disclosure
that has been there since the artifact card landed. `ReviewWork` sits directly
above the thing it is a verdict on, and fetches nothing.

**Sending back needs a note; approving does not.** The asymmetry is enforced in
two places and the panel is the readable one: the expert works from that note,
and sending work back with no reason leaves them guessing while their fee sits in
escrow.

## The marketplace surfaces (slice 5)

**Accepting is two steps, on declining's exact shape and for a stronger reason.**
Declining cannot be undone; accepting cannot be undone **and commits somebody
else's money**. The confirm step therefore states the figure rather than implying
it: "Your rate, $X for the task, is locked in escrow when you accept." A person
should not have to infer what they will be paid from a rate card on another card
of the same page. It also says what acceptance opens, in one line, because being
admitted to a stranger's room is the other thing the click does.

**`/node` gains an "Accepted work" section**, and each engagement carries a
**minimal thread panel** underneath it: the messages of that thread, and a box to
add one. `STATE_COPY` for the node is written from the expert's side rather than
the owner's ("Funded and ready to start" rather than "Funded"), because the same
row means different things to the two people looking at it.

**The panel subscribes, as of slice 6.** `20260906120000` gave a thread its own
realtime topic, so `ThreadPanel` opens a private channel on `chat:thread:<id>`
and the ten-second poll is gone. Three things carried over from `ChatApp` rather
than being invented: the since-cursor `GET` stays as **catch-up on `SUBSCRIBED`**,
because a live subscription says nothing about what arrived while the tab was
shut; a missing client session is a **banner rather than silence**, which is the
exact bug `ChatApp` records (the page renders because the server holds the
session, live updates never start, and nothing says so); and `CHANNEL_ERROR` /
`TIMED_OUT` say they are disconnected, since messages quietly ceasing to arrive is
the one failure the write path cannot detect on its own. The copy dropped its
"New messages appear within a few seconds" hedge, because that sentence existed to
be honest about the poll.

**The owner's stream now interleaves two conversations, and the rows are marked
rather than hidden.** A node admitted to a task thread posts into the same room,
so messages arrive carrying a `threadId` the room's own conversation does not
have. **Hiding them would be the fetched-never-rendered defect**, and it would hide
work the owner is paying for and is entitled to read. Each such row carries a
quiet "in a task thread" marker: a word, not a tint or an indent, so somebody who
cannot distinguish the shades reads the same page (rule 15). The mirror image is
RLS rather than anything in the UI: the node sees only their own thread.

**A node's messages are badged "Human node" by role, not by name.** The owner
**can** read the node's `profiles` row, through the counterparty policy, and
where that name belongs is the project panel's engagement line, beside the price
and the date it was agreed. So the stream labels the role rather than inventing a
name, which is honest and is also the rule-15 requirement: the badge is a word.

> **This paragraph used to give a reason that was false, and the correction is
> `20260906125000`.** It said `room_members_select_member` "gives a room-scoped
> member the room-scoped roster plus their own row, so a thread-scoped membership
> is invisible to the owner". Measured against the live database as the owner the
> first time a node was actually in a room: **two rows visible, one of them
> thread-scoped**, and the node rendered in "in this room" as a member of a room
> it cannot read.
>
> The misreading is the same one `20260901123000` was written to fix, surviving on
> the other side of the same predicate: `private.member_scope_covers(room_id,
null)` asks whether the **caller** is room-scoped and does not filter which
> **rows** come back, so a room-scoped caller passed once and then saw every
> membership row in the room. On `room_members` the rows are themselves the
> scopes, which is exactly why a predicate about the caller reads as though it
> were about the row.
>
> The policy is narrowed rather than the paragraph rewritten, because the roster
> was making a false claim about somebody's access and the owner loses nothing:
> the engagement line and the counterparty policy are untouched and are the
> designed channel for the node's identity. **Nothing caught it because
> `thread_scope.sql` had never asserted what the owner sees on that table** — only
> what a thread-scoped member sees. Both directions are asserted now (54).

**`ProjectPanel` gains an engagement line on a taken step**, showing who took it,
the agreed price in tabular numerics (rule 14), and the date. This is the only
place the owner learns who is doing their work: `offers` stays closed to them,
because it names everybody who was _asked_, including the people who declined.

**`Budget` counts escrow, and breaks it out.** "Committed" is now both classes
([ADR-0020](../40-adr/0020-the-ceiling-has-two-committer-classes.md)), with "of
which N held in escrow" beneath it. Folding escrow away would leave an owner
reading a number they cannot reduce with no way to tell which half is which, and
counting only campaigns would show headroom the next acceptance refuses to spend,
which reads as a broken check rather than as a full budget.

**`STATE_COPY` needed no change at all.** `claimed` ("An expert took it") and
`escrow_funded` ("Funded") were written when the machine was declared in full,
which is what that table exists for: a view showing a raw enum value the day
something first reaches a state is a view nobody updated.

**The offer card's classes finally got their styles.** `node-offer`,
`node-confirm`, `node-textarea` and `node-history` were introduced by slice 4 with
no rules at all, so an offer rendered as bare stacked text. They land here rather
than in a separate tidy-up because this slice adds a second list of the same shape
with a money figure inside it, and half-styling one of the two would be worse than
the gap it started from.
