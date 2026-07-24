# Playbook — Cafe · US · Texas · Austin

> Worked example of the flagship US pack. **Informational only** — regulated/physical steps route to licensed or local **human nodes**; nothing here is legal/tax advice. All specifics must be **cited and effective-dated** in the RAG jurisdiction pack before use, and re-verified on the freshness cadence ([rag.md](../10-architecture/rag.md)). Values below are indicative and must be confirmed against current sources at runtime — **do not treat as current fact.**

## Scope

- **Archetype:** `food-service > cafe` (coffee + light food; alcohol optional).
- **Jurisdiction:** `US / TX / Austin`.
- **Assumptions:** single location, small owner-operated, dine-in + takeaway.

## Ordered steps

Legend: **AI** = agent can do · **H** = needs a human node · role in parentheses.

| #   | Step                                                   | AI  |  H  | Node role                            | Notes                                                                                                                                                                          |
| --- | ------------------------------------------------------ | :-: | :-: | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Intake, concept & market research                      | ✅  |  —  | —                                    | Competitor/foot-traffic/pricing research, demand estimate, SWOT. Framed as market _information_, not a success guarantee.                                                      |
| 2   | Business model & budget                                | ✅  |  —  | —                                    | CapEx/OpEx model, break-even, unit economics. Illustrative projections; financing/tax structure flags an accountant.                                                           |
| 3   | Entity selection (LLC vs S-corp; TX vs DE)             | ✅  | ✅  | licensed attorney/CPA                | AI drafts the comparison; a licensed professional confirms before filing (regulated advice + liability).                                                                       |
| 4   | Name/availability + formation docs                     | ✅  | ✅  | owner (signature)                    | AI checks name/trademark, drafts Certificate of Formation, operating agreement, registered-agent setup; the **owner signs**.                                                   |
| 5   | File with TX Secretary of State + registered agent     | ✅  | ✅  | owner / registered-agent node        | AI prepares and monitors; filing/authorization needs the owner or an authorized agent.                                                                                         |
| 6   | EIN (IRS)                                              | ✅  | ✅  | owner (SSN/ITIN)                     | AI prepares SS-4; the **owner** provides personal ID and is the responsible party — AI never enters it as the user.                                                            |
| 7   | Assumed name (DBA) if trading under a brand            | ✅  | ✅  | owner                                | County/state DBA filing; AI prepares, owner files/signs.                                                                                                                       |
| 8   | Sales-and-use tax permit (TX Comptroller)              | ✅  | ✅  | owner / CPA                          | AI prepares registration; a CPA confirms elections and ongoing filings.                                                                                                        |
| 9   | Business bank account                                  | ✅  | ✅  | owner (in-person/KYC)                | AI assembles the KYC packet + books the appointment; the **beneficial owner** completes bank KYC — AI cannot authenticate as the owner.                                        |
| 10  | Location scouting + lease                              | ✅  | ✅  | real-estate node + owner             | AI shortlists by budget/zoning/footfall/venting; **viewing, negotiation, signing** need a human. Lease drafted/reviewed but not as a binding legal opinion.                    |
| 11  | Certificate of Occupancy + zoning check                | ✅  | ✅  | permit-runner node                   | AI checks zoning/CO requirements; physical inspection + in-person filing (City of Austin) need a human.                                                                        |
| 12  | Food Enterprise / health permit (Austin Public Health) | ✅  | ✅  | food-safety node + inspector         | AI drafts the plan/layout/SOPs (wet areas, ventilation); **on-site inspection** is a human act.                                                                                |
| 13  | Food Handler / Food Manager certification              | ✅  | ✅  | owner/staff                          | AI schedules/prepares; certification exam is taken by a person.                                                                                                                |
| 14  | Alcohol permit (TABC) — if serving                     | ✅  | ✅  | licensed advisor + owner             | AI researches the specific TABC permit class and drafts; a licensed advisor verifies what **this** cafe needs before serving. Deliberate escalation, not an AI final answer.   |
| 15  | Sign permit + build-out/construction                   | ✅  | ✅  | contractor/architect + permit-runner | AI produces design brief/budget/checklist; physical build-out and in-person permits need humans.                                                                               |
| 16  | Equipment & supplier sourcing                          | ✅  | ✅  | on-site node (delivery/install)      | AI sources espresso/refrigeration/POS + recurring supply with RFQs/draft contracts; **purchases need per-purchase user confirmation**; heavy install/inspection needs a human. |
| 17  | POS, payments & accounting stack                       | ✅  | ✅  | owner (merchant KYC)                 | AI configures POS + bookkeeping; some acquirer/merchant onboarding needs in-person/bank verification.                                                                          |
| 18  | Hiring, contracts & payroll (I-9, workers' comp)       | ✅  | ✅  | owner + HR/legal node                | AI writes JDs, screens, drafts compliant contracts, sets up payroll/withholding; interviews, I-9, and legal review need humans.                                                |
| 19  | Branding, identity & digital presence                  | ✅  |  —  | (optional design node)               | AI generates naming/logo/menu/site/Google Business Profile/socials; publishing/account creation confirmed with the user.                                                       |
| 20  | Marketing, launch & ongoing ops                        | ✅  | ✅  | local PR node + CPA                  | AI runs launch campaign, local SEO, ads, loyalty; ongoing compliance monitoring (sales-tax filings, license renewals) with a licensed accountant.                              |

## Escalation map

Legally reserved / physical / high-risk steps: **4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 17, 18, 20** → human node (role per row). Missing user-only facts (personal ID, budget ceiling, brand taste) → **user**. Everything else runs autonomously.

## Cost/time (indicative — confirm at runtime)

State filing fees, permit fees, health/CO fees, TABC fees, build-out, and equipment vary widely; the agent pulls current figures from `cost_benchmarks` + the jurisdiction pack and shows **"last verified"** dates. **Never quote these from memory.**

## Freshness

Sources: TX Secretary of State, IRS, TX Comptroller, City of Austin (Development Services + Austin Public Health), TABC. Crawl cadence + last-verified dates tracked in `knowledge_sources` ([rag.md](../10-architecture/rag.md)).
