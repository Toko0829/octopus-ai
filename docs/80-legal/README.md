# Legal

> Home for legal templates and the compliance paper trail. **These are engineering placeholders, not legal documents** — every item here must be drafted/reviewed by qualified counsel before use. Tracks the counsel action-items surfaced across the docs.

## Documents to produce (with counsel)

| Doc | Purpose | Blocking gate |
|---|---|---|
| `terms-of-service.md` | Platform ToS (user + node) | Before onboarding real users/nodes |
| `disclaimers.md` | "Informational, not legal/financial advice" copy shown on regulated output | Phase 1 ship |
| `node-engagement.md` | Per-task engagement agreement | Onboarding real nodes |
| `node-nda.md` | Node NDA template | Onboarding real nodes |
| `data-processing-addendum.md` | DPA for GDPR/EU users | EU launch |
| `privacy-policy.md` | Privacy + data-rights (GDPR/CCPA) | EU/US launch |
| `aml-kyc-policy.md` | KYC/AML + sanctions/PEP program | Any node payout |
| `marketplace-tos.md` | Marketplace + escrow terms | Real money movement |

## Counsel action-items (do not hand-wave — from [security-compliance.md](../10-architecture/security-compliance.md))

- **Money-transmission / escrow-licensing** analysis per jurisdiction (US state MTL regime; EU e-money/payment-institution rules; GEL/FX for the future Georgia pack). Clear **before real money moves**.
- **Platform-of-record** determination for payments.
- **Tax reporting** obligations (1099-K / DAC7 / local equivalents) via Stripe Connect.
- **Unauthorized-practice-of-law / accountancy** boundaries — reserve regulated acts to credentialed nodes carrying professional indemnity.
- **Consumer-protection / advertising** compliance for AI-generated marketing (truthful claims, alcohol-ad rules, AI-content labeling where required).
- **Data-protection** posture (GDPR, US state laws; Georgian Personal Data law for the future pack).

## Standing principles (engineering-enforced)

- Persistent disclaimers on regulated output; per-action user confirmation for side-effects; the AI never signs/notarizes/authenticates-as-user/enters credentials; everything event-sourced for liability defense. Enforced in [AGENTS.md](../../AGENTS.md) and [security-compliance.md](../10-architecture/security-compliance.md).
