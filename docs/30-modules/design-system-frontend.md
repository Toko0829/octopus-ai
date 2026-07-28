# Module: Design System & Frontend

> Owns the **implemented** token system, component library, and the Next.js UI shell — the code embodiment of the "Ink & Bioluminescence" house style, including the Discord chat shell, command palette, and adaptive theming. **Enforces the anti-slop rules in code.**
>
> **Owner paths:** `packages/ui/**`, `apps/web/**` · **Depends on:** chat-discord (renders the chat model), auth-identity (role-based UI), ai-orchestrator (renders inline agent stream + embeds), infra-devops (build).
>
> The design language + tokens are specified in [design-system.md](../20-design/design-system.md); this doc owns the **implementation**. Update both together on any token/component change.
>
> **Implementation status (Phase 1, in progress):** the **Discord-style chat shell** is built at `/app` — full 5-region layout, roles/badges, presence, inline agent messages with the bioluminescent working pulse, the marquee **plan card** (stages, owner chips, citations, approve/request-changes), composer, context panel, and a ⌘K command palette. House style implemented via design tokens in `app/globals.css` + `app/app/chat.css`, distinctive type (Fraunces / Hanken Grotesk / JetBrains Mono via `next/font`), light + dark ("Command Deck") skins. Mock-driven; wires to Supabase Realtime + the planner next. (Phase 0: Next.js 15 scaffold + editorial landing.)

## Responsibilities

Turn the house style into shipped, accessible, themeable React — and make it **hard to ship slop** (lint/guardrails).

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

## Key entities

`packages/ui` components · design tokens (CSS vars) · theme definitions · chat UI components · command-palette actions.
