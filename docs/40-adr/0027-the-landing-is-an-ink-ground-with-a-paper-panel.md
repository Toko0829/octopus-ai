# ADR-0027 — The landing is an ink ground with a paper panel, and its pictures are engravings

- **Status:** Accepted
- **Date:** 2026-09-01
- **Context:** Landing redesign against hermes-agent.nousresearch.com
- **Amends:** the "the landing is Light Editorial" line in
  [design-system.md](../20-design/design-system.md#three-adaptive-skins-chromatophore-theming),
  and the "AI image generation was rejected" line under
  [How a reference enters this system](../20-design/design-system.md#how-a-reference-enters-this-system)
- **Related:** [ADR-0005](0005-house-style-not-purple-gradient.md), whose
  anti-pattern list is unchanged and is what this decision was checked against

## The two decisions

**1. The landing runs on the deep-water ground from top to bottom, and the paper is
a panel dropped into it.** Until now the rule was that the landing is Light
Editorial with one dark hero band inside it, because Light Editorial is "the face
of Octopus" and Dark Command Deck is reserved for work surfaces. The reference the
owner chose does the opposite: one saturated ground under everything, a white
panel in the middle, a fixed footer revealed as the content lifts away. Measured
on 2026-09-01 and recorded in the reference map, that structure is what gave the
reference its presence, and no amount of type and spacing work on a paper page
reached it.

The ground is **not** the Command Deck. It is the rendered water plate that was
already the hero's, now the page's, and it is cool where the deck's ink is warm.
The panel is `data-skin="light"` and paints its own background, colour and
`color-scheme`, on the subtree-skin rule this same doc already carries. Light
Editorial remains the default for every other trust surface: sign-in, the connect
flow, plan review, the dashboards.

**2. The landing's pictures are generated engravings.** design-system.md rejected
AI image generation "on brand grounds rather than cost", because "bioluminescent
underwater" is one of the most over-generated prompts there is and the output
lands inside the exact genre ADR-0005 bans. That reasoning stands, and it is the
reason this decision is narrow: what is permitted is **black-ink engraving on
white paper, of our own subjects**, converted by a committed script
([`tools/art/engrave.mjs`](../../tools/art/engrave.mjs)) into two encodes that
are tinted and blended in the page rather than in the prompt. The water is still
a render, and the hero is the water alone: an engraved octopus was tried there and
rejected the same day. Photoreal, underwater, glowing, and anything with a sparkle in it stay
banned.

## Why an engraving is different from the thing that was banned

The ban was on a **genre**, not on a tool. An engraving is monochrome by
construction, so the prompt cannot smuggle in a purple gradient or a neon glow;
its subject is a thing (a ledger, a seal, a signal mast), not a mood; and it
reads as printed on the surface it sits on, which is the opposite of a floating
render pasted over a gradient. The reference uses public-domain engravings for
exactly this reason, and a public-domain engraving of a ledger does not exist for
us to borrow. The masters are gitignored on the same principle as the Blender
masters: the prompt and the script are the reproducible part.

## Consequences

- `design-system.md` gets a dated amendment under the skins section and a Hermes
  row in the reference map; `design-system-frontend.md`'s landing block is
  rewritten.
- `lenis` (smooth scrolling, 4 kB) is added to `apps/web` and `framer-motion`
  leaves the landing, so the page's first-load JavaScript falls rather than rises.
- The anti-pattern checklist is re-run by hand on the new page and the pass is
  recorded, as ADR-0005's amendment requires.
- If a second reference pass ever puts the landing back on paper, this ADR is
  superseded rather than edited, so the reason for the inversion survives.
