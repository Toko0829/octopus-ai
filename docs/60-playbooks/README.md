# Playbooks

> Domain playbooks: **Business Archetype × Jurisdiction Pack**, compiled into a task DAG by [rag-knowledge](../30-modules/rag-knowledge.md). Each file documents the concrete steps for one archetype in one jurisdiction, marking for every step whether **AI can do it** and whether it **needs a human node**. These are the domain source of truth the compiler mirrors.

## Naming

- **Marketing (first vertical):** `<archetype>-<icp>.md` — e.g. `full-funnel-creator.md`.
- **Business formation (later verticals):** `<archetype>-<country>-<region>-<city>.md` — e.g. `cafe-US-TX-austin.md`, `cafe-GE-tbilisi.md` (founding story).

## Structure per playbook

1. **Scope** — archetype, jurisdiction, assumptions (budget band, format).
2. **Ordered steps** — each with: description · `aiCanDo` · `needsHuman` · required node role · inputs/artifacts · citations + effective dates.
3. **Escalation map** — which steps escalate and why.
4. **Cost/time estimates** — indicative, from `cost_benchmarks`.
5. **Freshness** — sources + last-verified dates.

## Status

| Playbook                                      | Vertical                            | Status                     |
| --------------------------------------------- | ----------------------------------- | -------------------------- |
| [full-funnel-creator](full-funnel-creator.md) | **Marketing — FIRST vertical**      | Flagship — authored        |
| `full-funnel-smb`                             | Marketing → SMB                     | Planned (Phase 4)          |
| `ecommerce-growth`                            | Marketing → e-commerce              | Planned (Phase 4)          |
| [cafe-US-TX-austin](cafe-US-TX-austin.md)     | Business formation (later)          | Reference example authored |
| `cafe-GE-tbilisi`                             | Business formation (founding story) | Planned (Phase 5)          |

> **Reminder:** every playbook's rules must be **cited, dated, and freshness-checked** in the RAG jurisdiction pack; never generalize one jurisdiction's rules to another ([rag.md](../10-architecture/rag.md)). Steps here are informational and, for regulated acts, routed to licensed human nodes — never presented as binding advice.
