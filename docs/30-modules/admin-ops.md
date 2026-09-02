# Module: Admin & Ops

> Owns the internal operations surfaces: dispute resolution, content/proof moderation, node/payment/task-queue consoles, and the audit-trail explorer. **Dense, data-first tools built with real craft above the utilitarian baseline.**
>
> **Owner paths:** admin UI in `apps/web/**` (ops routes) + ops actions in `apps/api/**` · **Depends on:** all domain modules (read/act across projects, tasks, nodes, payments, chat), auth-identity (admin/ops RBAC), analytics (metrics), payments-billing (dispute actions).
>
> Update on any change to ops workflows, RBAC, or the consoles.

## Implementation status

**One console of seven is live: dispute resolution** (marketplace slice 8, `20260908120000`…`128000`). It was pulled forward from Phase 3, and the reason is specific rather than a change of plan: `20260908120000` made `disputed` reachable from four states, and **nothing else in this system can move a task out of it**. A console is what stops that being the `escalated` defect reproduced on purpose — the one this repository measured at twelve stranded tasks before slice 4 fixed it.

The other six consoles are unbuilt and stay Phase 3. Building them now would mean six surfaces with no reachable state behind them, which is this repository's other recorded defect in the opposite direction.

| Console                    | Status                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dispute resolution**     | ✅ live — `/ops`, `GET/POST /api/ops/disputes*`                                                                                                             |
| Moderation                 | ⏳ Phase 3. No extractor exists: ADR-0022 records that proof carries no EXIF/geo/verdict columns and that a `proof_checks` table is the shape when one does |
| Node ops                   | ⏳ Phase 3. Suspension is the blocker, not the surface — see "What suspension needs" below                                                                  |
| Payments / ledger ops      | ⏳ Phase 3. Reconciliation needs a real provider to reconcile against; the only registered one is the in-repo fake                                          |
| Task-queue / stuck-run ops | ⏳ Phase 3. The no-show and reconcile sweeps already handle expiry and reassignment without a human                                                         |
| RAG source ops             | ⏳ Phase 3                                                                                                                                                  |
| Audit-trail explorer       | ⏳ Phase 3. `events` still has no client read policy; the dispute detail view is a narrow, purpose-built slice of it                                        |

### What the dispute console does

`/ops` (`apps/web/app/ops/`) is a queue beside a detail pane. Open disputes list oldest-first, because the longest freeze is the one where somebody has been waiting longest with their money held; resolved list newest-first, because that view is read to check recent decisions rather than worked through.

The detail pane shows everything a decision rests on, in one place: the grievance and which side raised it, `from_state`, both parties by name, every escrow hold on the step with its state, the payout rows, **the raw ledger entries**, and the thread roster **including ended memberships**. That last one is why `reassign_engagement` and `resolve_dispute` stamp `room_members.expires_at` rather than deleting the row — "the roster still records that this person was here, which is what a dispute reads" (`20260906124000`).

**The roster shipped broken and is recorded here rather than quietly fixed.** The first version of that query asked for `room_members.created_at`; the column is `joined_at`, so PostgREST refused the whole select with `42703`, the route's `roster.data ?? []` turned the error into an empty list, and the pane said "nobody was admitted to this thread". Two things made it invisible. **An empty roster is a legitimate answer** — a dispute raised before anybody was admitted has one — so the failure was indistinguishable from the truth on screen. And **no test in this repository could have caught it**: `ops.test.ts` stubs the Supabase client, so a select string is never parsed by anything, which is the defect class slice 7 named when it said a mocked client cannot fail on syntax. Found by resolving a real dispute against the running stack. The column was never projected into the response, so the fix is to stop asking for it; the error is now logged rather than swallowed, because rule 16 applies hardest where a failure and a fact look the same.

**This is the first legitimate reader of `ledger_entries`.** That table has had RLS with no policy and no client grant at all since `20260904122000`, whose migration said "the reader of raw entries is the Phase-3 ops console". It is read here as `service_role` behind the role check, never through a policy.

Five resolutions, and each names where the money goes and where the step ends up. The full mapping and its reasoning is [ADR-0026](../40-adr/0026-the-dispute-exit-map.md):

|                            | task           | engagement | escrow                                                                                                       |
| -------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Pay the expert in full     | `-> approved`  | stays live | untouched; the payout sweep sends it                                                                         |
| Split it                   | `-> cancelled` | ends       | refund + a new hold released ([ADR-0025](../40-adr/0025-a-partial-settlement-is-a-refund-and-a-new-hold.md)) |
| Refund the client in full  | `-> cancelled` | ends       | `held -> refunded`                                                                                           |
| Send it back to the market | `-> matching`  | ends       | `held -> refunded`                                                                                           |
| Uphold the rejection       | `-> rejected`  | stays live | nothing moves                                                                                                |

**A partial takes one number.** The operator enters what the expert keeps; the refund is derived as `hold − release` and shown before they confirm. Two fields that must sum to a third are two ways to type a number that does not add up.

**Every resolution requires a reason**, checked in the route, in the RPC, and by a non-empty constraint on the column. An unexplained decision cannot be recorded, and because the trail is written inside the same transaction as the money, it therefore cannot happen.

### RBAC, and the first reader of `profiles.role`

`admin` and `ops` have been in the `user_role` enum since `20260724000000` and authorised nothing. `apps/api/src/plugins/require-ops.ts` is the first thing in this system to read the column, which makes auth-identity.md's standing paragraph on that subject false and it has been rewritten in the same push.

**The role is read from the database and never from the token.** This is the part that would fail silently if it were wrong: `apps/api/src/plugins/auth.ts` already puts a `role` on `request.user`, which looks exactly like the thing to check — but `toRole()` maps an unrecognised claim to `'user'`, Supabase mints `role = 'authenticated'`, and there is no GoTrue custom-claims hook in this project. A check written against the claim would refuse everybody, look like a working deny-by-default, and stay broken until somebody "fixed" it by trusting a claim the client half-controls.

**`admin` and `ops` are treated identically.** Nothing in this build distinguishes them, and inventing a distinction here would mean deciding which of the two may release somebody's escrow on no evidence. Scoped permissions between them stay Phase 3.

**There is no RLS policy for operators**, on any of the four tables the console reads, and this is deliberate. An ops-wide policy would have to test `profiles.role` inside a policy, which needs a `SECURITY DEFINER` helper in `public` — the shape security-compliance.md:99 records being reintroduced once by somebody who had already read the migration that removed it, because such a function is published at `/rest/v1/rpc/` to anyone holding the anon key. The layering is: the route check is the control, and **no client grant at all** is the backstop. That is `ledger_entries`' posture, and it fails in the safe direction.

**A role is granted only by `scripts/grant-ops.mjs`**, run by somebody holding the secret key. No route, no policy and no UI can grant it: `authenticated` holds a column grant on `profiles` covering three columns, and `private.guard_profile_role_self_service` refuses a `role` change from any writer carrying a JWT (`20260831110000`). `service_role` writes with no claims, so the server path is untouched — which is why this needed **no migration**. The script mirrors `invite-node.mjs` (zero dependencies, `--confirm`, prints the server's own hints), refuses `--role admin` for the reason above, refuses to make a `human_node` an operator, and `--revoke` puts the role back.

`invite-node.mjs`'s header says it "is not an ops console and must not be dressed up as one". That is still true and is why this is a second script rather than a flag on the first: inviting a node creates a record for somebody who will be **paid** through the platform; granting ops gives somebody authority **over other people's** money.

### `ops_actions`, and why `events` could not do this job

Every resolution writes an `ops_actions` row inside the same transaction as the money. `events` keeps recording what happened to the domain objects, from the triggers that enforce the transitions; this records who decided it and on what grounds. Three reasons the second table exists, none of them fixable by writing to the first more carefully:

1. **`events` cannot tell an operator from a sweep.** Every `service_role` writer has no JWT, so `auth.uid()` is null and the house `actor_kind` idiom resolves to `'system'` with a null `actor_id` — `settle_payout` hardcodes exactly that. A person releasing somebody's money would be indistinguishable from the payout sweep doing it on schedule. Here `actor_id` is `not null` with no `'system'` branch: if nobody can be named, the write fails.
2. **`events` has nowhere to _require_ a reason.** `payload` could carry one; carrying and requiring are different guarantees, and admin-ops.md requires one.
3. **`events` is project-scoped**, and ops act on subjects outside any project.

The table is **append-only including for `service_role`** — stricter than every money table in this schema, which keep UPDATE because settling is an update. Nothing here is ever settled, and the account being protected from is the one the operator is using.

### What suspension needs, and why it is not here

human-nodes-marketplace.md:1040 specifies "repeat low ratings / fraud flags suspend the node", and `node_profiles.kyc_status` carries a `suspended` value with `node_profiles_suspended_has_reason` constraining it. **Nothing reaches it, and slice 8 does not change that.**

A suspension writer needs three things this slice does not have: a documented **un-suspend** arc (otherwise it is a terminal state with no exit, the defect this whole slice exists to avoid); a **threshold** that is not a kill switch wearing a threshold's shape (ADR-0014's argument about a ceiling of zero applies directly — "suspend after one low rating" is not a threshold); and a **moderation console** to review the evidence behind it. All three are Phase 3 with the node-ops console. Recorded here so it is somebody's to notice rather than nobody's.

### Limits this console ships with

- **No moderation of proof.** The detail pane shows what was submitted; nothing checks authenticity, and no extractor exists (ADR-0022).
- **No node suspension, no trust-score override.** See above.
- **No reconciliation.** Ledger entries are shown; nothing compares them to a provider, because the only registered provider is the in-repo fake.
- **No audit-trail explorer.** `events` still has no client read policy. The dispute detail is a purpose-built slice, not the general view.
- **Nobody is notified of a dispute.** The room gets a system message; the node's thread deliberately does not, because a dispute is decided by an operator rather than negotiated between the parties. Notifications remain specified and unbuilt.
- **`carriesRealMoney` gates the three resolutions that settle escrow**, refusing with a 503 before anything is written, exactly as the payout sweep does. payments-billing.md's counsel gate is unmoved.
- **A second resolution is ignored, not refused.** `resolve_dispute` puts idempotency before validation, this domain's ordering in all four writers, so a replay short-circuits before reading the resolution being asked for. The route surfaces it honestly with `replayed: true` and the stored resolution, so nobody is told a new answer was taken.

## Responsibilities

Keep the marketplace and platform healthy and disputable: resolve disputes, moderate proof, review node verification, reconcile payments, unstick stalled runs, triage stale RAG sources — all **audited, least-privilege**.

## Consoles

- **Dispute resolution** — freeze / release / partial / refund / reassign, with the full event-sourced audit trail. Drives [payments-billing.md](payments-billing.md) fund actions. **Live; see above.**
- **Moderation** — review node-submitted proof and flagged content (authenticity, tampering, policy).
- **Node ops** — verification review, suspension, trust-score overrides.
- **Payments / ledger ops** — reconciliation (ledger vs Stripe), payout inspection.
- **Task-queue / stuck-run ops** — waitpoint expiry, node no-show, SLA breach; re-dispatch or reassign.
- **RAG source ops** — stale-source review, parse-failure triage, re-verification routing (to a human node).
- **Audit-trail explorer** — event-sourced timeline per project/run (the human-facing view of `events`).

## RBAC & least privilege

`admin` and `ops` roles with scoped permissions; every ops action is written to `ops_actions` (audited). No destructive action without a trail. Ops access to a project chat is audited and scoped.

## Design guidance

Dense, keyboard-first tools — **Retool as the density reference, but higher craft** (the Dark Command Deck skin, hairline borders, tabular numerics, conditional status color paired with text). See [design-system.md](../20-design/design-system.md).

The dispute console is the **first Dark Command Deck surface in the repository**, and it applies the skin as a subtree (`data-skin="dark"` on the page wrapper) rather than by flipping the root. That carries two obligations design-system.md states and `ops.css` meets: the wrapper paints its own `background` and `color`, because `body` sits outside it and resolves from `:root`, and it sets `color-scheme` so scrollbars and form controls follow. It also gives `--role-admin` its first use — a token that had existed unused since the token layer was written.

## Key entities

`disputes` ✅ · `ops_actions` ✅ (audited) · `moderation_flags` ⏳ · `reconciliation_runs` ⏳ · ~~`admin_roles`~~ — **not built, and not planned**: `profiles.role` already carries `admin` and `ops`, and a second table would be a second answer to "what is this person allowed to do".
