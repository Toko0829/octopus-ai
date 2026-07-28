# Module: Design System & Frontend

> Owns the **implemented** token system, component library, and the Next.js UI shell — the code embodiment of the "Ink & Bioluminescence" house style, including the Discord chat shell, command palette, and adaptive theming. **Enforces the anti-slop rules in code.**
>
> **Owner paths:** `packages/ui/**`, `apps/web/**` · **Depends on:** chat-discord (renders the chat model), auth-identity (role-based UI), ai-orchestrator (renders inline agent stream + embeds), infra-devops (build).
>
> The design language + tokens are specified in [design-system.md](../20-design/design-system.md); this doc owns the **implementation**. Update both together on any token/component change.
>
> **Implementation status (Phase 1, in progress):** the **Discord-style chat shell** at `/app` now runs on **live data, with no mock or demo content anywhere**. Sign-in (`/sign-in`, Supabase GoTrue) gates the workspace via middleware; reads happen in the Server Component; the browser talks to Fastify only through the thin BFF at `/api/bff/*`; messages arrive over Realtime and sends are optimistic, reconciled on the server copy. House style via design tokens in `app/globals.css` + `app/app/chat.css`, type (Fraunces / Hanken Grotesk / JetBrains Mono via `next/font`), light + dark skins.
>
> **Deliberately not rendered** (no backend until Phase 2, and a trust surface must not show invented numbers): the **plan card** (`PlanCard.tsx` and its types are kept, unwired), agent replies, the budget figure in the top bar, and unread counts. The ⌘K palette lists only actions that work. What replaced them is real: rooms, channels, members with profile names, Realtime Presence, and message history.

## Responsibilities

Turn the house style into shipped, accessible, themeable React — and make it **hard to ship slop** (lint/guardrails).

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

## Icon system

One customized icon set (consistent stroke); no color-only meaning.

## Frontend architecture

RSC for reads; streaming; **ts-rest** typed client from `packages/contracts`; optimistic sends reconciled on Realtime broadcast; the BFF stays thin (proxies mutations, never runs long work).

## Anti-pattern lint / guardrails

Automated checks (lint rules / CI) reject: violet / 2-stop purple gradient, sparkle/"magic"/AI badges, default un-customized shadcn + Inter + zinc, glassmorphism-everywhere, conic/neon glows, pure-`#000` dark, and any corner chatbot bubble. See [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md).

## Copy conventions

Product copy follows the brand voice ([brand.md](../20-design/brand.md)): **no em dashes** (—) in any user-facing text (landing, chat, plan cards, agent messages, labels). Use a comma, colon, period, parentheses, or a middot (·) instead. Enforced as [AGENTS.md](../../AGENTS.md) rule 22; lint/CI should flag em dashes in `apps/web` strings.

## Key entities

`packages/ui` components · design tokens (CSS vars) · theme definitions · chat UI components · command-palette actions.
