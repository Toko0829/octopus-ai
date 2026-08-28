# Brand — Octopus

> The identity behind the product: name, metaphor, voice, and the anti-slop stance. Update when positioning, naming, or voice changes. Visual tokens live in [design-system.md](design-system.md).

## Name & metaphor

**Octopus.** The octopus is the perfect metaphor for this product:

- **Eight arms** → parallel workstreams (registration, location, suppliers, licensing, hiring, branding, budget) executed at once.
- **Highly intelligent** → the autonomous business operator.
- **Chromatophores (color-change)** → adaptive theming per surface and per business.
- **Bioluminescence** → the living "the agent is working" signal.
- **Tentacles reaching out** → **human nodes** plugging into the physical/legal world where the AI can't.

This gives us an ownable identity with real semantic depth — the deliberate opposite of a generic AI brand.

## Positioning line

> **Octopus runs your business. You just decide.**

Alternates for context:

- "Tell Octopus what you want to build. It handles the rest — and brings in real people when the law needs one."
- "The AI that opens your business, end to end."

## Voice & tone

- **Calm, precise, credible.** We handle money and legal steps; we sound like it. Editorial, not hypey.
- **Plain language over jargon.** The user may be a first-time founder.
- **Show the receipts.** Claims come with citations and "last verified" dates; we never bluff.
- **Honest about limits.** When something needs a human or a lawyer, we say so clearly — that honesty _is_ the trust.
- **Never breathless AI-hype.** No "magical", no "revolutionary AI", no ✨. Confidence is quiet.

- **No em dashes.** Product copy never uses em dashes (—); use commas, colons, periods, parentheses, or a middot (·). Enforced as an [AGENTS.md](../../AGENTS.md) rule.

## What the brand is not

- Not a "chatbot" brand. Not a purple-gradient AI startup. Not a hustle/"get-rich" brand. Not a legal/financial advisor (we're informational + accountable hand-off).

## Visual stance (summary)

- **Editorial / calm minimal** primary aesthetic (see [design-system.md](design-system.md)).
- Ink neutral ramp + one bioluminescent teal signal + coral for human/CTA.
- Glow reserved for live agent/presence. Tabular numerics for money.
- **Anti-slop rules are brand rules** — [ADR-0005](../40-adr/0005-house-style-not-purple-gradient.md).

## Naming within the product

- Ventures = "businesses" (guild entries).
- Workers = **nodes** (human nodes; "Verified Pro" for licensed).
- The agent = **Octopus** (or "the agent" in system copy); it signs its messages as **Agent**.
- Workstreams = channels; subtasks = threads/topics.

## Logo (built)

The brief was: an octopus mark that reads at 16px (favicon) and as a wordmark. Geometric, confident, single-weight; the teal signal used sparingly. No literal gradient blobs.

It is now drawn, in [`apps/web/components/brand/Logo.tsx`](../../apps/web/components/brand/Logo.tsx), with the favicon at `apps/web/app/icon.svg`. Four things the drawing settled that the brief left open.

- **The floor is 13px, not 16.** The chat renders the mark that small beside a system message, so 13px is what the geometry answers to. Every decision below follows from it.
- **A filled silhouette, and "single-weight" honoured by having no stroke at all.** The previous mark was a 1.6px outline with a hand-drawn wavy base, which at 13px is a grey smudge. A solid shape holds.
- **Three deep lobes, not eight arms.** Eight is the metaphor, not the drawing: at 13px eight of anything is texture. The octopus reads from the whole shape.
- **Eyes knocked out with `fill-rule="evenodd"`.** One path, one colour, so it works on any background, including inside the coloured agent avatar, with no second fill to keep in sync.

**The mark is `currentColor` everywhere.** Teal arrives only from the context it is placed in: the wordmark glyph, the rail, the agent avatar. That is what "used sparingly" has to mean for something rendered this often, and it is why the mark itself carries no colour of its own.

The favicon is the same geometry with the lobes 0.4 units deeper: at 16px the base reads optically lighter than the dome and the correction stops it looking top-heavy in a tab. It carries its own `prefers-color-scheme` query, because browser chrome is the one background we do not control.

**Closed, 2026-08-28: the large editorial variant.** This entry read "still open: a large editorial variant, where one arm extends out of the silhouette to a coral node. That is the tentacles reaching out to human nodes half of the metaphor, and it needs room a 24px grid does not have." The room turned out to be the landing's human-nodes section, which was 626px of heading and one paragraph.

It is **rendered rather than drawn**, in [`tools/art/landing-art.py`](../../tools/art/landing-art.py) (`--shot reach`), and it does not use the mark. One arm of light with no edges at all, narrowing across the frame to a single small solid coral point. The two brand hues carry the whole claim without a caption: teal is the agent, coral is "a person does this", and the picture says what the heading says. **The agent is diffuse and everywhere; the person is one place.** That contrast is the composition, and it is why the node is small and hard against an arm that has none.

Three things the drawing settled that the brief left open.

- **The arm is a volume, not a surface.** An emissive surface has an edge, and an edge reads as wire. Several attempts produced something between a grass stalk and a sea urchin before the material became a pure volume with no surface shader at all.
- **The node does not glow, and it does scatter.** Glow is reserved for live agent presence, so a halo would be the wrong claim about a human. What surrounds it is a faint volumetric scatter, which is simply what an emissive body does in water.
- **Coral had to be checked after the tone transform.** At the strength it was first lit, AgX desaturated it to **white**, so the one pixel carrying "a person does this" had silently lost the only thing that made it mean that. A hue that carries meaning is verified in the rendered frame, never in the colour picker.
