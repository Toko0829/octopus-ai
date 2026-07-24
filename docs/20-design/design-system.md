# Design System — "Ink & Bioluminescence"

> The house style and full token architecture: the ownable brand system, three adaptive skins, motion, typography, and the explicit anti-pattern list that keeps Octopus off the AI-slop path. **Primary aesthetic: editorial / calm minimal.** Owner of `packages/ui/**` design decisions alongside [design-system-frontend.md](../30-modules/design-system-frontend.md). Update on any token, type, motion, or component-spec change.

## The one-line brief

**Calm, editorial, trustworthy by default — with a dense, fast "command deck" when you're doing real work, and a warm, alive chat where the AI and humans collaborate.** An octopus: intelligent, many-armed, color-changing. The opposite of purple-gradient AI slop.

## Why editorial/calm-minimal is the primary aesthetic

Octopus asks a person to let software run their business and move their money. That is an **anxiety-forward** ask. The antidote is the design language of the most *trusted* software on the web — Stripe, Vercel, Framer: generous whitespace, refined type, restrained color, confident-but-quiet. Density and power (Linear/Superhuman/Raycast) are earned **inside** the product for power users; delight and warmth (Family/Arc) are reserved for the chat and onboarding. We lead with trust.

## Reference map (real products, what we take)

| Reference | What we take |
|---|---|
| **Stripe** (stripe.com) | Premium editorial trust; *disciplined* multi-stop gradients as rare brand connective tissue (never the clichéd 2-stop purple); confident **light** display weights; tabular numerics for money. |
| **Vercel / Geist** (vercel.com/geist) | Token architecture rigor + mono-for-labels — but a **baseline to diverge from** (everyone ships Geist), so we add a characterful display face, our own accent, and radii. |
| **Framer** (framer.com) | Marketing-site motion vocabulary + the actual animation library (Framer Motion): spring, scroll-linked, layout transitions. |
| **Linear** (linear.app) | The command-deck: hairline borders do the structural work, low font-weight band, tight radii, ⌘K, color as a rare functional flashlight. |
| **Superhuman** (superhuman.com) | Speed-as-product; the centered ⌘K palette with a monospaced surface that feels like directing a machine; "learn the shortcut once." |
| **Raycast** (raycast.com) | Per-item ActionPanels + shortcut-per-action; excellent light/dark parity in a tiny surface. |
| **Family** (family.co) / **Arc** (arc.net) | Tactile spring choreography, earned micro-delight, per-space theming — for chat + onboarding, where warmth lowers the "AI runs my business" anxiety. |
| **Discord / Slack / Zulip** | The 5-region chat model, roles/mentions/presence, interactive embeds, Zulip-style named topics. |

## Three adaptive skins ("chromatophore" theming)

The product changes color to fit the task, like an octopus:

1. **Light Editorial (default / trust surfaces)** — marketing, onboarding, plan review, dashboards. Paper-white canvas, ink text, tons of whitespace, restrained accent. This is the face of Octopus.
2. **Dark Command Deck (work surfaces)** — task board, agent run-log, budget ledger, admin ops. Dense, hairline-bordered, keyboard-first. Not pure `#000` — a layered ink.
3. **Warm Chat (collaboration surface)** — the Discord-style channel. Presence-rich, tactile, alive; the AI's inline stream and human nodes co-exist here.

Plus a **per-business accent** so each venture the user runs feels distinct.

## Color

- **Ink neutral ramp** (primary structure). Layered, warm-cool-neutral, **not** zinc/gray-default. Light shell built on paper-white; dark deck on layered ink (`~#0d0f12` base, never `#000`).
- **One signal accent — bioluminescent teal.** Used sparingly and functionally: primary actions, active/live states. **Glow is reserved for live agent/presence only.**
- **Coral — human / CTA.** Marks human-node presence and high-intent CTAs; a warm counterpoint to the cool teal.
- **Semantic tokens** over primitives: `--color-bg`, `--color-surface`, `--color-border-hairline`, `--color-text`, `--color-text-muted`, `--color-accent`, `--color-human`, `--color-success|warning|danger|info`.
- **Chat role tokens:** `--role-you`, `--role-agent`, `--role-node`, `--role-pro`, `--role-admin` — **always paired with a badge/icon, never color alone** (accessibility).

## Typography

- **Pairing:** one **characterful display** face (editorial confidence, used at light weights in large sizes — Stripe/Söhne energy, *not* Inter-default), a clean **body** grotesque, and a **mono** for labels/code/command surfaces and all monetary/tabular contexts.
- **Type scale:** 12 · 14 · 16 · 18 · 20 · 24 · 32 · 40 · 48 · 64.
- **Tabular numerics for all money** — non-negotiable (`font-variant-numeric: tabular-nums`).
- Tight tracking on display; comfortable measure on body (editorial).

## Spacing, radius, elevation

- **Spacing:** 4px grid (`--space-1..12`).
- **Radius scale:** 6 / 10 / 14 / 20 / 999 (`--radius-sm..full`).
- **Elevation:** hairline borders do the structural work (Linear); soft shadow for genuine layering; **glow strictly for live agent/presence**, nowhere else.
- **Density modes:** `compact` / `cozy` / `spacious` — command deck defaults compact; editorial defaults spacious.

## Motion

- **Tokens:** `--dur-fast` (~120ms) / `--dur` (~200ms) / `--dur-slow` (~320ms); `--ease-out` for UI; **spring** (Framer Motion) for tactile surfaces (chat, onboarding).
- **Rules:** motion serves perceived speed and continuity, never spectacle. Command-deck motion is near-instant; chat/onboarding motion is spring and delightful. Respect `prefers-reduced-motion`.
- The **live agent working pulse** (a gentle bioluminescent breathing state) is the one place ambient motion is encouraged — it signals the AI is doing something.

## Token layering

```
primitive tokens  (raw ink ramp, teal, coral, type sizes, durations)
      ↓
semantic tokens   (--color-bg, --color-accent, --role-agent, --space-4, --radius-md, --dur)
      ↓
component tokens   (--btn-bg, --card-border, --message-accent-bar)
```

Skins (Light Editorial / Dark Command Deck / Warm Chat) are **swaps at the semantic layer**; components never hardcode primitives. Light + dark parity is mandatory; the theme toggle stamps the active skin on the root.

## Iconography

- **One** icon set, customized (consistent stroke), not a mixed bag. Never convey meaning by icon color alone.

## Accessibility (enforced)

- Never role/status by **color alone** — always badge + icon.
- WCAG AA contrast minimum (AAA for body where feasible) in **both** skins.
- Keyboard-first; global **⌘K** action layer; visible focus rings; `prefers-reduced-motion` honored.

## Anti-patterns (the AI-slop avoid-list) — see [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md)

**Never ship:**

- Violet/indigo primary or the **2-stop purple gradient hero**.
- **Sparkle / ✨ / "magic" / "AI" badges** as decoration.
- **Default, un-customized shadcn + Inter + zinc** (the generic template look).
- **Glassmorphism everywhere** / frosted panels as a crutch.
- **Conic/neon glows** as ambient decoration (glow is reserved for live agent/presence only).
- **Pure `#000`** dark backgrounds.
- A **corner chatbot bubble** — the AI lives **inline** in the shared channel as a member.
- Emoji-as-UI, random gradient text, center-everything landing pages.

## Component specs (reference-driven)

Full implementation specs live in [design-system-frontend.md](../30-modules/design-system-frontend.md); the marquee components:

- **Chat shell** (Discord 5-region) — [discord-chat-spec.md](discord-chat-spec.md).
- **Inline agent stream** — accent bar + AI tag + live token streaming + working pulse (never a bubble).
- **Action embeds** — Approve / Pay / Sign / Assign / Accept, permission-gated, tabular money.
- **Plan / approval cards** — cited, effective-dated, cost-estimated; the plan is the product's first "wow."
- **Dense tables** (Command Deck) — Linear/Retool-density, hairline, tabular numerics, conditional status color (paired with text).
- **Command palette** (⌘K) — Superhuman/Raycast: action + shortcut-on-right, "learn once."
