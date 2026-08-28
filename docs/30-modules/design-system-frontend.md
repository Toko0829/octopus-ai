# Module: Design System & Frontend

> Owns the **implemented** token system, component library, and the Next.js UI shell — the code embodiment of the "Ink & Bioluminescence" house style, including the Discord chat shell, command palette, and adaptive theming. **Enforces the anti-slop rules in code.**
>
> **Owner paths:** `packages/ui/**`, `apps/web/**` · **Depends on:** chat-discord (renders the chat model), auth-identity (role-based UI), ai-orchestrator (renders inline agent stream + embeds), infra-devops (build).
>
> The design language + tokens are specified in [design-system.md](../20-design/design-system.md); this doc owns the **implementation**. Update both together on any token/component change.
>
> **Implementation status (Phase 1, in progress):** the **Discord-style chat shell** at `/app` now runs on **live data, with no mock or demo content anywhere**. Sign-in (`/sign-in`, Supabase GoTrue) gates the workspace via middleware; reads happen in the Server Component; the browser talks to Fastify only through the thin BFF at `/api/bff/*`; messages arrive over Realtime and sends are optimistic, reconciled on the server copy. House style via design tokens in `app/globals.css` + `app/app/chat.css`, type (Fraunces / Hanken Grotesk / JetBrains Mono via `next/font`), light + dark skins.
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

- **An authenticated route must declare `dynamic = 'force-dynamic'`, not infer it.** `/app` used to become dynamic only as a side effect of `await cookies()` throwing Next's dynamic-usage bailout. But `createClient()` validates the Supabase env _before_ it reaches `cookies()`, so with no env the page throws an ordinary `Error` first, Next never receives the bailout signal, and the build fails trying to prerender a page that was never prerenderable. The failure is invisible locally, because a present `.env.local` lets execution reach `cookies()` and the route turns dynamic by accident. **CI builds with no Supabase env at all, and that is deliberate:** it proves the build depends on no runtime config. Verify a build the way CI runs it (`NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= pnpm build`) rather than only the way your machine runs it. Confirm the route lands as `ƒ (Dynamic)` in the build's route table.

## Empty and failure states

Every surface that can be empty or broken says which it is, and says it in terms the reader can act on. `EmptyWorkspace` distinguishes "you have no rooms yet" from "the API did not answer", and the failure copy names **the URL actually tried** (from `API_URL`) rather than a hardcoded port, because the message is read precisely when that value has been overridden. Message-level state (`sending`, `not sent`) is text, never colour alone, and a failed send keeps the text on screen instead of discarding what the person wrote. See [`DEVELOPMENT.md`](../../DEVELOPMENT.md) for the port-override setup this copy refers to.

## Token implementation

CSS variables in three layers (primitive → semantic → component); three skins (**Light Editorial** default, **Dark Command Deck**, **Warm Chat**) as semantic-layer swaps; per-business accent injected at runtime. Components never hardcode primitives.

## Typography implementation

Display / body / mono faces wired as CSS vars; the type scale (12→64); **tabular numerics** utility applied to all monetary/tabular contexts.

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

## Icon system

One customized icon set (consistent stroke); no color-only meaning.

## Frontend architecture

RSC for reads; streaming; **ts-rest** typed client from `packages/contracts`; optimistic sends reconciled on Realtime broadcast; the BFF stays thin (proxies mutations, never runs long work).

## Anti-pattern lint / guardrails

Automated checks (lint rules / CI) reject: violet / 2-stop purple gradient, sparkle/"magic"/AI badges, default un-customized shadcn + Inter + zinc, glassmorphism-everywhere, conic/neon glows, pure-`#000` dark, and any corner chatbot bubble. See [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md).

> **These checks are not automated yet, and the first manual pass found two things.** A **`✦` sparkle glyph** decorated the landing page's eyebrow label, which the avoid-list bans twice over (sparkle-as-decoration and emoji-as-UI). And `--role-pro: #7a5cff` was the **only violet value in the repository** — declared in all three skin blocks, referenced **zero** times, with a comment claiming it was "used only as a role marker" while `.badge-pro` actually reads `--human`. Both removed; the source now contains no violet or indigo at all.
>
> Everything else on the list passed on inspection: fonts are Fraunces / Hanken Grotesk / JetBrains Mono rather than Inter; dark is `#0d0e11` rather than `#000`; the one `backdrop-filter` is a 2px blur on the ⌘K scrim rather than glassmorphism as a crutch; glow appears only on the agent working pulse; the two `position: fixed` elements are that scrim and a centred toast, not a corner chatbot bubble; gradients are two-stop avatar fills within one hue, and no `background-clip: text` exists.
>
> **Until a lint rule exists, this is a manual pass that will drift.** The cheap version is a CI grep for the banned hex families and for decorative glyphs in `.tsx`, plus the contrast sweep above run headlessly against `/` and `/sign-in`.

## Copy conventions

Product copy follows the brand voice ([brand.md](../20-design/brand.md)): **no em dashes** (—) in any user-facing text (landing, chat, plan cards, agent messages, labels). Use a comma, colon, period, parentheses, or a middot (·) instead. Enforced as [AGENTS.md](../../AGENTS.md) rule 22; lint/CI should flag em dashes in `apps/web` strings.

## Key entities

`packages/ui` components · design tokens (CSS vars) · theme definitions · chat UI components · command-palette actions.
