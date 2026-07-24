# ADR-0005 — House style: editorial "Ink & Bioluminescence", not AI-slop

- **Status:** Accepted
- **Date:** Phase 0
- **Context doc:** [design-system.md](../20-design/design-system.md), [brand.md](../20-design/brand.md)

## Context

Octopus asks a user to let software run their business and move their money — an anxiety-forward ask that demands a **trusted, distinctive** visual identity. The default AI-startup look (purple gradients, sparkles, un-customized shadcn) signals "generic AI toy" and undercuts trust. The user explicitly asked for a modern design backed by real references, not "the design AI is trained on."

## Decision

Adopt the **"Ink & Bioluminescence"** house style with **editorial / calm minimal** as the primary aesthetic (Stripe/Vercel/Framer energy), a **dark Command Deck** for dense work surfaces (Linear/Superhuman/Raycast), and a **Warm Chat** surface (Family/Arc). Ink neutral ramp + one bioluminescent teal signal + coral for human/CTA. Glow reserved for live agent/presence. Tabular numerics for money. Enforce the anti-pattern list in lint/CI.

## The anti-slop rules (enforced)

Never ship: violet/2-stop-purple gradient hero · sparkle/"magic"/AI badges · default un-customized shadcn + Inter + zinc · glassmorphism-everywhere · conic/neon ambient glows · pure-`#000` dark · corner chatbot bubble (the AI lives **inline**).

## Rationale

- Trust is the product's scarce resource; the most trusted software on the web is editorial and restrained.
- A distinctive, ownable identity (the octopus metaphor) is a moat and a memory hook.
- Real references give the team a concrete bar instead of "make it look nice."

## Consequences

- Higher craft bar; a token architecture and component specs are required ([design-system-frontend.md](../30-modules/design-system-frontend.md)).
- Lint/CI guardrails reject slop patterns, so the rule survives contributor turnover.
