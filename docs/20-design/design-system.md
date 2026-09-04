# Design System — "Ink & Bioluminescence"

> The house style and full token architecture: the ownable brand system, three adaptive skins, motion, typography, and the explicit anti-pattern list that keeps Octopus off the AI-slop path. **Primary aesthetic: editorial / calm minimal.** Owner of the design decisions implemented in `apps/web/**` alongside [design-system-frontend.md](../30-modules/design-system-frontend.md). Update on any token, type, motion, or component-spec change.

> **`packages/ui` does not exist, and is not the next step.** Both docs named it as the owner path from the start. There is exactly one consumer, `apps/web`, so extracting nineteen components into a workspace package today buys nothing and costs build wiring; the tokens live in `apps/web/app/globals.css` and the component library is the set of stylesheets beside it. Revisit when a second consumer appears.

## The one-line brief

**Calm, editorial, trustworthy by default — with a dense, fast "command deck" when you're doing real work, and a warm, alive chat where the AI and humans collaborate.** An octopus: intelligent, many-armed, color-changing. The opposite of purple-gradient AI slop.

## Why editorial/calm-minimal is the primary aesthetic

Octopus asks a person to let software run their business and move their money. That is an **anxiety-forward** ask. The antidote is the design language of the most _trusted_ software on the web — Stripe, Vercel, Framer: generous whitespace, refined type, restrained color, confident-but-quiet. Density and power (Linear/Superhuman/Raycast) are earned **inside** the product for power users; delight and warmth (Family/Arc) are reserved for the chat and onboarding. We lead with trust.

## How a reference enters this system

References are read for **system decisions, not for looks**. From each one we measure the same six things in the browser, on real computed values rather than by eye: spacing rhythm, type ratio and tracking, border and elevation treatment, the interaction-state model, motion durations and their easings, and density. What comes back is a **diff to the token layer plus a line in this doc**, so the system sharpens each round instead of accumulating one-off screens.

What we deliberately do **not** take: brand colour, page length, and any structure that only works because the reference has social proof we do not have yet. An empty testimonial block does not build trust, it spends it.

**Measure the picture, not only the type.** The first pass over mercury.com measured spacing, type, colour and easing, and produced a page that was still a document: no image, nothing that moved. Three quarters of that reference is picture and movement, and the parts that were skipped were the parts that made it feel expensive. A reference pass that has not counted the images and the animations has not been done. Two things that pass also got wrong by sampling the whole page instead of the surface in question: the hero is a **full-viewport photograph**, not a product screenshot, and its **CTAs are 32-40px pills** while only its menu rows are 4px.

**Art direction is a decision, not an output of the token layer.** No amount of spacing and type work reaches a commissioned image. Ours is deep water, light from above, and a bioluminescent presence below the frame, carried by **eight arcs of light** rather than a literal octopus. A mark optimised for 13px scaled to 1100px is a large icon, not an image.

**It is rendered rather than bought, generated, or drawn.** Three routes were weighed. Stock photography of people is the generic option and we do not want it. AI image generation was rejected on brand grounds rather than cost: "bioluminescent underwater" is one of the most over-generated prompts there is, and the output would land inside the exact genre [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md) exists to ban, one hue over from the purple gradient. So the water is a **Cycles render** from a committed scene script ([`tools/art/hero-scene.py`](../../tools/art/hero-scene.py)): ours, directable, and it looks like nobody else's output.

**Amended 2026-09-01: generated engravings are permitted, and only those** ([ADR-0027](../40-adr/0027-the-landing-is-an-ink-ground-with-a-paper-panel.md)). The ban above was on a genre, not a tool, and it stands: the water is still a render, and photoreal, underwater, glowing or sparkling generation is still out. What the landing now carries beside the render is black-ink engraving on white paper of our own subjects (a ledger, a seal, a signal mast, a hand passing a key), which is monochrome by construction and so cannot smuggle the banned genre in. `tools/art/engrave.mjs` splits each master into an ink encode tinted `--teal-300` for the water (`mix-blend-mode: screen`) and a paper encode for the panel (`multiply`); the tint is baked there because a CSS filter chain that lands reliably on one hue does not exist, and the hue means "the agent". Masters are gitignored, like the Blender masters, because the prompt and the script are the reproducible part.

**The split is that the render owns the photograph and SVG owns what moves.** Volumetric depth, shafts, falloff and grain are photographic properties that stacked gradients only imitate. Drifting motes and breathing arms are motion, which a still frame cannot supply. Neither layer substitutes for the other, and the arms were built in 3D first and thrown away: emissive geometry needs glare compositing to read as light rather than as wire, and the drawn ones already animate.

**Text over a photograph gets a scrim, and the scrim is a measured value.** The instinct is to darken the image until the copy clears AA. That was tried and it produced a plate that passed every check and had no shafts and no bloom left in it. Contrast bought by deleting the picture is a regression the checker cannot see. Measure the **composited** surface, never the plate alone, and keep the scrim as light as the margins allow.

The sign of a value is not the decision. mercury.com adds _positive_ tracking to its display face because Arcadia Display is drawn for large use; Fraunces has a real `opsz` axis that does the same job, so our correction stays slightly negative. The decision taken from the reference is that **tracking is tokenised per step at all**.

## Reference map (real products, what we take)

| Reference                                        | What we take                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stripe** (stripe.com)                          | Premium editorial trust; _disciplined_ multi-stop gradients as rare brand connective tissue (never the clichéd 2-stop purple); confident **light** display weights; tabular numerics for money.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Vercel / Geist** (vercel.com/geist)            | Token architecture rigor + mono-for-labels — but a **baseline to diverge from** (everyone ships Geist), so we add a characterful display face, our own accent, and radii.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Framer** (framer.com)                          | Marketing-site motion vocabulary + the actual animation library (Framer Motion): spring, scroll-linked, layout transitions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Linear** (linear.app)                          | The command-deck: hairline borders do the structural work, low font-weight band, tight radii, ⌘K, color as a rare functional flashlight.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Superhuman** (superhuman.com)                  | Speed-as-product; the centered ⌘K palette with a monospaced surface that feels like directing a machine; "learn the shortcut once."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Raycast** (raycast.com)                        | Per-item ActionPanels + shortcut-per-action; excellent light/dark parity in a tiny surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Family** (family.co) / **Arc** (arc.net)       | Tactile spring choreography, earned micro-delight, per-space theming — for chat + onboarding, where warmth lowers the "AI runs my business" anxiety.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Discord / Slack / Zulip**                      | The 5-region chat model, roles/mentions/presence, interactive embeds, Zulip-style named topics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Mercury** (mercury.com)                        | Measured 2026-08-28. A 120-point weight band that never exceeds 480; 4px as the default radius; alpha hairlines; three-layer shadows at 2-9% alpha; line-height and tracking as functions of size; a 72-128px section rhythm; and the regulatory disclaimer placed **in the hero** rather than the footer.                                                                                                                                                                                                                                                                                                                                                                                       |
| **Hermes Agent** (hermes-agent.nousresearch.com) | Measured 2026-09-01, for the landing. One saturated ground under the whole page with a paper panel dropped into it; a fluid unit (`--u`, the viewport over 2360 with a floor) for the frame and section rhythm; upper-case display headings at a light weight; monospace for every label; square paper buttons with a real 25% shadow; a panel that overlaps the section above it; a fixed footer revealed as a curtain; a light sweep across a picture on hover; `lenis` smooth scrolling. **Not taken:** the blue, the 800-weight nav, upper-case body copy at 14px for whole paragraphs, the canvas grain. See [ADR-0027](../40-adr/0027-the-landing-is-an-ink-ground-with-a-paper-panel.md). |

## Three adaptive skins ("chromatophore" theming)

The product changes color to fit the task, like an octopus:

1. **Light Editorial (default / trust surfaces)** — marketing, onboarding, plan review, dashboards. Paper-white canvas, ink text, tons of whitespace, restrained accent. This is the face of Octopus.
2. **Dark Command Deck (work surfaces)** — task board, agent run-log, budget ledger, admin ops. Dense, hairline-bordered, keyboard-first. Not pure `#000` — a layered ink.
3. **Warm Chat (collaboration surface)** — the Discord-style channel. Presence-rich, tactile, alive; the AI's inline stream and human nodes co-exist here.

Plus a **per-business accent** so each venture the user runs feels distinct.

**Amended 2026-09-01: the landing is an ink ground with a paper panel** ([ADR-0027](../40-adr/0027-the-landing-is-an-ink-ground-with-a-paper-panel.md)). The paragraph below still describes how a subtree skin works, and the landing still uses it, but inverted: the page runs on the rendered water plate from top to bottom (`data-skin="dark"`, painting the plate's own cool ink rather than the deck's warm one), and the paper is a `data-skin="light"` panel dropped into the middle of it. Light Editorial remains the default for every other trust surface. The reason is the Hermes row in the reference map: a paper page with one dark band never reached the reference's presence however the type and spacing were tuned, and the structure was the part that did.

**A skin applies to a subtree, not only to the root.** `:root` and `[data-skin='light' | 'dark']` both declare the semantic layer, and custom properties resolve from the nearest declaring ancestor, so a page can be Light Editorial while one band inside it is dark. The landing uses this: it is light whatever the operating system prefers, because Dark Command Deck is reserved for work surfaces, and its cinematic hero band is its own dark world inside that. Two things a subtree skin must do that the root gets for free: **paint its own `background` and `color`**, because `body` sits outside it and still resolves from `:root`, and set **`color-scheme`**, which scrollbars and form controls read instead of custom properties.

## Color

- **Ink neutral ramp** (primary structure). Layered, warm-cool-neutral, **not** zinc/gray-default. Light shell built on paper-white; dark deck on layered ink (`~#0d0f12` base, never `#000`).
- **One signal accent — bioluminescent teal.** Used sparingly and functionally: primary actions, active/live states. **Glow is reserved for live agent/presence only.**
- **Coral — human / CTA.** Marks human-node presence and high-intent CTAs; a warm counterpoint to the cool teal. Like amber, it needs **two steps below the mid tone**, because one coral cannot clear AA on both skins: `--coral-700` carries `--human` on light, `--coral-400` on dark. See the measurements in [design-system-frontend.md](../30-modules/design-system-frontend.md#accessibility-enforcement).
- **A hue that names a thing carries a word too.** Teal is "the agent", coral is "a person does this", amber is "this needs your approval". Three claims, three hues, and never a hue asserting two of them: that is how a badge stops meaning anything.
- **Semantic tokens** over primitives. As implemented: `--bg`, `--bg-sunken`, `--surface`, `--surface-2`, `--surface-hover`, `--border`, `--border-strong`, `--text`, `--text-secondary`, `--text-muted`, `--text-faint`, `--accent`, `--accent-quiet`, `--accent-text`, `--human`, `--human-quiet`, `--warn`, `--warn-quiet`, `--on-accent`. _(This list previously read `--color-bg`, `--color-surface`, `--color-border-hairline` and so on, none of which have ever existed in the stylesheet.)_
- **Chat role tokens:** `--role-you`, `--role-agent`, `--role-node`, `--role-admin` — **always paired with a badge/icon, never color alone** (accessibility). `--role-pro` was removed: it was `#7a5cff`, the only violet in the repository, referenced zero times. The badges read `--human` and `--accent` directly, so the role tokens are currently unused; they are kept because the roles are real and a badge component will want them.

## Typography

- **Pairing:** one **characterful display** face (editorial confidence, used at light weights in large sizes — Stripe/Söhne energy, _not_ Inter-default), a clean **body** grotesque, and a **mono** for labels/code/command surfaces and all monetary/tabular contexts.
- **Type scale:** 12 · 13 · 15 · 17 · 22 · 30 · 40 · 56, plus two fluid steps: `--text-title` (28→40) for section headings and `--text-display` (36→56) for the landing hero.
- **Line height is a function of size, not of component.** Five steps, bound to the size they serve: `--lh-display` 1.10 · `--lh-title` 1.15 · `--lh-heading` 1.25 · `--lh-ui` 1.40 · `--lh-prose` 1.60. Choosing a size is one decision, not three.
- **Tracking is likewise tokenised per step:** `--ls-display` -0.015em · `--ls-title` -0.01em · `--ls-heading`/`--ls-body` 0 · `--ls-label` +0.02em · `--ls-eyebrow` +0.16em.
- **Narrow weight band:** `--fw-normal` 400 · `--fw-medium` 460 · `--fw-strong` 520. **Nothing above 520.** A wide weight band is most of what makes an interface read as loud; both faces are variable, so the in-between steps are real rather than synthesised.
- **Tabular numerics for all money** — non-negotiable (`font-variant-numeric: tabular-nums`).
- **The display face's optical-size axis must be requested by name.** `next/font` ships `wght` alone unless the others are listed, so `font-optical-sizing: auto` is a no-op until the loader asks for `opsz`.

## Spacing, radius, elevation

- **Spacing:** 4px grid, `--sp-1..12` (4→48) for component space and `--sp-14 / 18 / 24 / 32` (56 / 72 / 96 / 128) for **section rhythm**. Page frame as tokens too: `--container` and `--gutter`.
- **Radius scale:** 4 / 8 / 12 / 20 / 32 / 999 (`--r-sm` … `--r-2xl`, `--r-full`). **4px is the default**, not the exception: a tight radius reads as engineered rather than friendly, which is the register software that holds somebody's money belongs in.
- **Hairlines are alpha, never a fixed ramp step.** A solid border is right on one surface and wrong on the next, so each surface ends up with its own value and the structure stops reading as one system. `--border` / `--border-strong` are `color-mix` against transparent and composite onto whatever they sit on.
- **Elevation:** hairline borders do the structural work (Linear); shadows are **three layers at very low alpha** (a contact layer so the card is not pasted on, a middle layer for weight, a wide layer for distance); **glow strictly for live agent/presence**, nowhere else.
- **Interaction state is a colour layer, not opacity.** `--state-hover` / `--state-active` / `--state-selected` wash over the surface. Fading an element fades its label with it, so the text loses contrast at the exact moment somebody points at it.
- **Density modes:** `compact` / `cozy` / `spacious` — command deck defaults compact; editorial defaults spacious. _(Not implemented yet.)_

## Motion

- **Tokens:** `--dur-fast` 150ms (state changes) / `--dur` 200ms / `--dur-slow` 300ms (things entering) / `--dur-slower` 500ms (large media). Easing is per purpose, not shared: `--ease-state` (`cubic-bezier(0.4,0,0.2,1)`) for a symmetrical state change, `--ease-enter` (`cubic-bezier(0,0,0.2,1)`) for something arriving, which has no history and wants pure ease-out. **Spring** (Framer Motion, installed) for tactile surfaces (chat, onboarding).

- **Nothing the server renders may be invisible.** A reveal animation must be opt-in from the client: the root element carries `js` before first paint, and only under `html.js` does anything start hidden. A page whose client never runs, whose hydration fails, or whose `IntersectionObserver` never reports must render as the finished page. This is a hard rule rather than a preference, because the failure is silent: the markup is all present and only the paint is missing, so nothing looks broken to anyone except the reader, who sees nothing at all.
- **Reveal has a backstop.** An observer that has said nothing after a second is treated as an observer that never will (a background tab, a hidden pane, a headless capture), and the content is shown. Waiting longer only risks showing none of it.
- **Ambient motion is for one thing.** The agent working pulse. Everything else moves in response to arrival or to input, and stops.
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
- **`--text-faint` is the floor, and it is measured rather than assumed.** It is the token for a line that is context rather than content: a timestamp, a thread marker, the model chip on a message head, the "Runs on" line under an agent voice. Composited on the surface each of those actually sits on it measures 4.82 light and 6.08 dark on the stream, 4.99 and 5.70 in the rail. Nothing quieter than it is available, so a new quiet line reaches for this token and then gets measured **through the browser on the real page**: a regex over an `oklab()` declaration cannot compose a colour over the surface behind it and will report a number that is not what anybody sees.
- **A control somebody may not use is absent, not disabled.** Every owner-only action in the room rail is simply not rendered for a member, who instead reads the same fact as a sentence. A greyed-out control is a piece of furniture whose only message is "no", and it invites a click that can never work.

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
