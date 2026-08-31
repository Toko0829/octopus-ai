# Security & Compliance

> The consolidated security, authorization, privacy, and legal/regulatory posture — engineering controls **and** business compliance. Update when auth, RLS, guardrails, KYC/AML, or the legal posture changes. Pairs with [auth-identity.md](../30-modules/auth-identity.md) and [payments-billing.md](../30-modules/payments-billing.md).

## Threat model (top surfaces)

1. **`service_role` leakage** — bypasses all RLS. Single biggest footgun.
2. **Dynamic group-chat RLS** — user + AI + multiple time-boxed nodes; the hardest membership surface.
3. **Prompt injection** via retrieved web/document/node content driving side-effecting tools.
4. **Overspend / money movement** via a jailbroken prompt.
5. **Identity fraud** on the node side (account-renting, synthetic identity, collusion).
6. **PII exposure** in URLs, logs, or the RAG index.

## Identity & authentication

- **Supabase Auth (GoTrue)** is the sole IdP, issuing **asymmetric JWTs (ES256/RS256)** published via JWKS.
- Next.js stores the session in cookies (`@supabase/ssr`, refreshed in middleware); Fastify verifies every request's JWT **locally** against cached JWKS (`jose`) in a `preHandler` — no round-trip to Supabase. Note these cookies are **not** `httpOnly`: the browser client must read the session to authenticate the Realtime socket. See the correction in [auth-identity.md](../30-modules/auth-identity.md).
- Roles/claims (`user` / `human_node` / `verified_pro` / `admin` / `ops`) drive both RLS and app authorization.

## Authorization: defense-in-depth

- **App-level checks in Fastify** _plus_ **Postgres RLS as the real backstop.** Never rely on one.
- RLS is **membership-based** (`room_members`, project ownership/assignment), not bare `user_id`.
- Fastify sets `request.jwt.claims` via `set_config()` (or uses the caller's token through supabase-js) so `auth.uid()`/`auth.jwt()` work inside policies.
- **`service_role` containment:** server-only, used by `matcher`/payments/agent system-writes; never shipped to the client; never in browser-reachable env.

  > **Accepted risk, with a trigger (Phase 1).** CI's retrieval-eval job holds `SUPABASE_SECRET_KEY` as a repository secret so it can read the corpus. GitHub exposes repository secrets to **any** workflow in the repo, so anyone able to push a workflow file can exfiltrate it. That is acceptable only while the repository has a single author, which is the case today and is a deliberate decision rather than an oversight.
  >
  > **Trigger to fix: the first additional collaborator.** The eval needs `select` on `documents` / `doc_chunks` and `execute` on `hybrid_search`, nothing more, so the fix is a dedicated least-privilege Postgres role rather than the key that bypasses RLS entirely. Do this before granting anyone else push access, not after.

- **Channel OAuth tokens are stored without envelope encryption.** `channel_connections` (`20260829121000`) holds `access_token` and `refresh_token` as plain columns.

  > **Accepted risk, with a trigger (Phase 2).** Acceptable **only** while the sole registered provider is the in-repo `fake` adapter, whose tokens authorise nothing and reach no network. The row-level control is real and is asserted: the table carries no policy and no grant to `authenticated` or `anon`, so a client is refused rather than shown zero rows, and `supabase/tests/marketing_rls.sql` checks the error code for the owner of the connection's own room as well as for an outsider. What is not protected is the at-rest case, where a database backup or a `service_role` leak yields the tokens directly. Every other control in this document assumes `service_role` containment holds; this one has no second layer behind it.
  >
  > **Trigger to fix: the first real provider credential**, which is the Meta sandbox adapter. Do it in that change, not after it, because the interval between a real token landing and the encryption landing is exactly the exposure. **Known fix:** pgsodium or KMS envelope encryption on the two token columns, with decryption confined to the tool code that makes the call.
  >
  > **That trigger is enforced now rather than only written here.** Every entry in `AUTH_PROVIDER_REGISTRY` (`packages/marketing/src/auth-registry.ts`) carries `carriesRealCredentials`, and `writeConnection` refuses to store a token for any provider where it is true, with a message naming envelope encryption and this paragraph. `fake` is `false`, which is the assertion that keeps the risk inside its stated bound; a test pins it, so changing it is a deliberate edit rather than a default. `carriesRealCredentials` **raises on an unregistered provider rather than answering false**, because "a provider we have never heard of certainly does not carry real credentials" is the inversion that would let an unreviewed name through. The paragraph above was the whole control until this slice, and a document is not a control.

- **`channel_connections` is the one table with no reader at all**, and it is a stronger version of the `events` stance rather than the same one. RLS filters rows, not columns, so any select policy that returned the row would return the secrets with it. A member's legitimate view ("Meta account connected, scopes X, expires Y") is an API projection that never selects the token columns.

  > **That projection exists now, and it is the only control on its own path.** `GET /api/rooms/:roomId/connections` is the one route group in this system where RLS defends nothing: the table has no grant to `authenticated`, so the read cannot run as the caller and must use the service client. Membership is therefore established separately and first, by reading the room as the caller so RLS decides visibility, and a room it hides yields 404 before anything else runs. The column list lives in one constant in `apps/api/src/lib/connections.ts` and is **asserted directly in the tests**, both by naming the eight columns and by checking that neither token column nor a `*` appears, because a `select *` written while debugging would be a silent, total credential leak to every member of the room. `ChannelConnection` in `packages/contracts` has no field for a token either, so a projection that started returning one would fail to typecheck before it reached a browser.
  >
  > Reading is open to any member, which is what the table's own comment promised. **Connecting and disconnecting are owner-only**, because `connect_channel` is `high_risk` in exactly the way `create_campaign` is: it hands a system access to somebody's real account.

- **Dynamic group-chat RLS** is tested with **pgTAP** in `supabase/tests/rls_membership.sql` (26 assertions, verified green against the live database). Covers a room shared by an owner, an unexpired node, an **expired** node and an outsider, across `rooms`, `messages`, `action_embeds` and `feedback_events`.

  The load-bearing case is that an **expired node sees nothing at all**: not the room, not the messages, not the plan card. Time-boxed access is what the entire marketplace model rests on, and until this file existed the only evidence it worked was that nothing had visibly leaked.

  The suite also asserts **privileges, not only policies**, because RLS filters rows a grant already permits and the two fail very differently. `TRUNCATE` is checked explicitly since it bypasses RLS entirely.

  Tests run as `authenticated` with `request.jwt.claims` set, exactly as PostgREST would. Running them as `postgres` would prove nothing: that role bypasses RLS, which is precisely how a policy bug survives review. Everything is inside a transaction that `ROLLBACK`s, so it is safe against a live database.

  Four of the assertions cover a different property and were added with `20260831110000`: **a role is never self-service.** `20260724000000:21` promised a trigger preventing self role changes and no migration ever wrote one, so `update public.profiles set role = 'admin' where user_id = auth.uid()` succeeded for any signed-in person — measured on the live database, where it completed with no error and the row read back `admin`, before being rolled back. Latent only because nothing authorises on `profiles.role` yet; it stops being latent the moment `human_node` means "eligible for paid work funded from somebody else's budget". Fixed with a column grant **and** a trigger, because the table-wide grant has already been silently restated once (`20260812120100:31`) and a `grant` line cannot undo a trigger. The sharp assertion runs **as `postgres` with a person's claims set**, bypassing both the grant and RLS so that only the trigger can refuse: run as `authenticated` it would be stopped by the column grant first and would still pass with the trigger deleted.

  **Still uncovered:** ops/admin access paths. Thread-scoped membership (`room_members.scope`) is no longer among them: it is covered by `supabase/tests/thread_scope.sql` (46 assertions, verified green against the live database), described below.

- **The workflow DAG** is covered by `supabase/tests/rls_workflow.sql` (33 assertions, verified green). Same four actors against `projects` / `tasks` / `task_deps` / `task_runs`, plus the two triggers. Its RLS half runs as a client and its **trigger half runs as `postgres` deliberately**, which is the opposite rule for the opposite reason: RLS must be tested as a client because `postgres` bypasses it, and the state-machine and acyclicity guards must be tested as `postgres` because they are meant to bind trusted server code too. If those ever start passing merely because the caller was privileged, the guard has been lost.

  **Known narrowing, closed.** Project visibility was inherited from room membership, which is coarser than the thread-scoped, time-boxed access this document requires of a node. **It closed in slice 2 of the marketplace sequence** (`20260901120000` … `20260901123000`), and the sequence was ordered so the narrowing was never actually taken: threads landed before any writer existed that could admit anybody. `private.is_project_member` now requires `scope = 'room'`, so **a thread-scoped member is not a project member at all** — not their own task, not their project. Task-level project visibility would join through `engagements`, which does not exist, and a policy that cannot yet be written correctly is not written approximately. `private.artifact_object_project` terminates in the same helper and inherited the narrowing with no edit.

  **`private.shares_room_with` was the half nobody had named.** It backs `profiles_select_co_member` and asked only whether two people share a room, so a thread-scoped node would have read the display name, jurisdiction and languages of **every member of the whole room**. Neither of the two KNOWN NARROWING comments mentioned it. It now requires `scope = 'room'` on both sides. The consequence is a named obligation rather than a gap: the owner will eventually need to read their engaged node's profile, and that policy joins through `engagements` too, so it is the engagement slice's to open.

- **Thread-scoped membership** is covered by `supabase/tests/thread_scope.sql` (46 assertions, verified green against the live database). A thread-scoped member sees the room shell, their own thread, its channel, only messages carrying their `thread_id` (**never the null-thread room stream**), only the embeds on messages they can already see, only their own membership row, and no `feedback_events`, project, task, artifact or realtime. The regression half is asserted just as hard, because a predicate narrowed one conjunct too far presents as "nothing loads" rather than as a security change.

  Two findings are recorded rather than smoothed over. **`room_members` is the one table where the row is itself a scope**, so the predicate that is right for `messages` is wrong for it: reused verbatim it let a thread-scoped member read every membership row pointing at their own thread, including that of a node whose access had already lapsed. Caught by this suite asserting 1 and measuring 2, and corrected in `20260901123000`. And the suite's own first run returned `23505` where it expected `23503`, because the fixture used a user who already held a row in the target room, so the primary key refused the insert before the foreign key was ever consulted — a test that would have passed for a reason unrelated to threads.

  **Realtime was extended, not replaced.** Both `realtime.messages` policies inline their membership predicate rather than calling a helper, because the input is `realtime.topic()`, so neither picks up a helper rewrite for free. Both gained `and m.scope = 'room'` in place via `alter policy`, preserving the time-box: an expired node cannot keep a live socket while correctly losing the rows. Note that the receive policy lives in `20260728120000` and `20260728200000` holds the **send** (presence `INSERT`) policy; an earlier version of this document attributed both to the latter. **There are no thread topics yet**, deliberately: a `'chat:thread:'` branch would have no broadcaster and no subscriber, so it lands with the slice that first admits a node, as an `OR` inside these same two policies rather than as a third one. Until then a thread-scoped member has no realtime at all and reads through the since-cursor `GET`, which runs as the caller and returns exactly their thread. The failure mode is a delay, not a disclosure.

- **The marketplace domain** is covered by `supabase/tests/marketplace_rls.sql` (46 assertions, verified green against the live database). The slice has no writer, so this file is its only caller — which is what makes four tables landing ahead of their writers defensible rather than dead: every constraint and both triggers are exercised here.

  Two assertions are unlike anything else in the suite set. **The subject of a verification record is refused their own row** (`42501`, not zero rows): `node_verifications` names a third party the node may duplicate and carries adverse-inference scores about the node, and RLS filters rows rather than columns, so there is no policy that could return the row safely. And **`service_role` is refused `UPDATE`, `DELETE` and `TRUNCATE`** on the same table, `TRUNCATE` included because `grant all` includes it and it ignores RLS entirely.

  A third is about an absence being deliberate: **an owner sharing a room with a node sees zero node profiles.** The counterparty policy would have to join through `engagements`, which does not exist, and a policy that cannot yet be written correctly should not be written approximately.

  Two more assert that the **task state machine is unchanged**: `matching → failed` is still refused and `escalated → matching` is still allowed. Slice 1 restores no arc, and pinning the absence is what makes slice 4's restoration read as a dated decision rather than as drift — `20260815220000` silently dropped eight arcs with nothing asserting they had ever been there.

- **The marketing domain** is covered by `supabase/tests/marketing_rls.sql` (39 assertions, verified green). Same four actors against `campaigns` / `ad_entities` / `campaign_outcomes`, the campaign state machine and the ad-tree guard as `postgres`, and `TRUNCATE` on all four tables. Two assertions are unlike anything else in the suite set: `channel_connections` must answer **`permission denied` rather than zero rows**, since the grant absence is the control and the two failure shapes are indistinguishable through PostgREST; and `campaign_outcomes` must refuse `UPDATE` **to `service_role`**, because a training signal that trusted code can rewrite is not evidence.

- **A policy and a read path that answer the same question differently is a defect waiting to be half-fixed.** `private.is_project_member` resolved a project to its room through `rooms.project_id`, which `materialise_plan` writes once, so only the first project approved in a room was visible to anybody. Measured before the fix: **6 projects with 3 reachable, and 47 tasks and 28 of 58 artifacts unreachable by any client, including their owner.** The identical mistake had already been found and fixed in the delivery path (`roomForProject`) two weeks earlier, and nobody carried it into the policy.

  It survived because **it failed as zero rows rather than as an error**: through PostgREST an invisible project and an empty one are the same response, no advisor lints a predicate for asking the wrong question, and a type checker cannot see one. `20260827110000` accepts either link, and neither widens tenancy since both still terminate in a live `room_members` row. Covered by `supabase/tests/project_membership.sql` (13 assertions, verified green), which asserts the outsider and expired-node cases alongside the regression, because a predicate rewritten to simply return true would pass any one-sided version of that suite.

- **File artifacts are private, signed per request, and never logged.** The `artifacts` bucket (`20260829124000`) is not public, so there is no fetchable object URL. `GET /api/projects/:projectId/artifacts/:artifactId/file-url` reads the artifact row **as the caller**, which is the authorization: RLS row visibility decides whether the file may be handed over, and the service key appears only afterwards to sign. The `storage.objects` select policy is the second layer, and both terminate in `private.is_project_member` so the policy and the route cannot drift apart. The signed URL is a **bearer capability**, treated like a token: ten-minute lifetime, minted per request rather than stored, and kept out of the logs (the route's catch logs `err.message` rather than the error object, because a storage client's error can carry a response body). Covered by `supabase/tests/storage_artifacts.sql` (11 assertions, verified green), including that an object whose path names no tenant is invisible rather than an error, that an expired node sees no file, and that a member can neither insert, delete nor move an object.

  > **Recorded finding, deliberately not changed here.** `anon`, `authenticated` and `service_role` all hold the full table privilege set on `storage.objects`, `TRUNCATE` included, from Supabase's own defaults. That is the same class `20260812120100` closed for `public`, and `TRUNCATE` matters for the same reason: it is not row-level and ignores RLS entirely. Not remotely exploitable, since PostgREST does not expose the `storage` schema and the Storage service reaches Postgres by its own path. Untouched because `storage.objects` is owned by `supabase_storage_admin` rather than `postgres`, and revoking `INSERT`/`UPDATE`/`DELETE` from `authenticated` there would break user-scoped uploads across every future bucket. **Trigger to revisit: the first bucket that clients write to directly**, which is when the grant set actually has to be reasoned about rather than inherited.

- **Run the Supabase advisors after every migration, not just the tests.** `20260813120000` passed all 33 assertions and still introduced six lints. A test suite asserts the properties somebody thought to assert; the advisor checks the ones everybody forgets.

  The one worth remembering: `task_deps_satisfied` was created in `public` as `SECURITY DEFINER` with `EXECUTE` granted to `authenticated`, publishing the scheduler's READY predicate at `/rest/v1/rpc/`. That is lint 0028/0029, **the same lint `20260728160000_harden_security_definer.sql` exists to clear**, reintroduced by someone who had read that migration. It repeats because it looks like ordinary least privilege, and because in Supabase `public` is the API schema, so granting EXECUTE is also publishing. Fixed in `20260813130000` by moving it to `private` and dropping it to `SECURITY INVOKER`: unlike `is_room_member` it is never evaluated inside a policy, so it never needed to bypass RLS at all.

## Agent guardrails (layered defense)

Applied fast→smart as pre-checks on inputs and post-checks on every tool output/artifact — never a single LLM self-judgement.

1. **Deterministic rule checks** → allow-lists, spend caps, PII patterns.
2. **Small classifier** → policy/injection screening.
3. **LLM-judge critic** → maker-checker validation against `acceptance_criteria`.

Key rules:

- **Authorization + spend caps live in tool code, not prompts.** Payment tools check Postgres (escrow balance, budget ceiling, RBAC), not the model's intent. A jailbroken prompt still cannot overspend or move money.
- **Tool risk tiers:** `read-only` (auto) · `reversible` · `external` · `high-risk/irreversible` (mandatory human/user approval via durable interrupt).
- **Injection quarantine:** all tool-returned content (web pages, supplier emails, documents, node proof, chat) is **untrusted data**, kept off the instruction channel.
- **Idempotency / exactly-once** side effects (durable activity + DB unique constraint) so retries never double-register a company, double-notify, or double-pay.
- **Kill switch / pause:** the user can pause any task/project from chat; the durable workflow honors cancellation at the next safe checkpoint.
- **Full audit trail:** every plan diff, tool call, decision, confidence, escalation, and payout is event-sourced and immutable.

## Escalation triggers (must route to human/user)

Legal restriction · physical presence · high-risk/irreversible action · low AI confidence (failed acceptance after 2–3 tries / critic reject / low retrieval confidence) · local/tacit-knowledge gap · missing user-only fact · user opt-in · policy/compliance flag · time/SLA breach. Full list in [ai-orchestrator.md](../30-modules/ai-orchestrator.md).

## Privacy & data minimization

- Comply with **GDPR** (EU users) and equivalent US state laws (e.g. CCPA); Georgian Personal Data law for the future pack.
- **Never** place PII (passport, SSN/tax ID, source-of-wealth, banking, card) in URLs/query strings, logs, or the RAG index.
- Sensitive KYC data is handled by the **licensed party / provider / bank**, not stored by us or used to train/enrich RAG.
- Data-subject rights (access/erasure) supported via the event-sourced model + hard-delete tooling where legally required.

## KYC / AML (marketplace)

- **Node identity verification** (Persona or Stripe Identity): document + passive liveness + **Face Match 1:1** and **Face Search 1:N** across enrolled nodes to kill account-renting / duplicate identity — the defining gig-fraud vector.
- **Sanctions / PEP screening** of both users and nodes.
- **Anti-fraud at match time:** Face Search dedup, geo/IP consistency, collusion/fake-proof detection.
- Verified professional licenses (lawyer/accountant/notary) are checked before a node is eligible for regulated tasks.

**What the schema stores, as of `20260831123000`.** `node_verifications` holds **provider verdicts, scores and references only — never the document, the image, a date of birth or an identifier**, which is how the "sensitive KYC data is handled by the licensed party, not stored by us" line above is kept rather than merely stated. `kind` separates `face_match` (1:1, against the document) from `face_search` (1:N, across enrolled nodes) because **only the second can name a third party**, and a table constraint enforces that `matched_node_id` is set on nothing else and never on the subject themselves.

The table has **no policy and no grant to any client role**, so a read returns `permission denied` rather than zero rows, and that is asserted **for the subject of the record**, not only for an outsider. A node's legitimate view of their own status is `node_profiles.kyc_status`. It is append-only including for `service_role`: a verification is the evidence behind a decision that can stop somebody earning, and a record trusted code can rewrite is not evidence. A re-check is a new row, which is also the anti-fraud history worth having.

**No real provider is registered, and that is now enforced rather than planned.** Persona and Stripe Identity are both paid and neither is wired. `packages/marketplace/src/verification-registry.ts` holds one entry, the in-repo `fake`, and both `verifierFor` and `carriesRealPii` **raise on an unregistered name rather than answering falsy** — because "a provider we have never heard of certainly collects no real documents" is the exact inversion that matters. `decideNodeKyc` in `apps/api/src/lib/nodes.ts` refuses on `carriesRealPii` before the RPC, so the first person to wire a real vendor hits a failing write rather than a paragraph they did not read. That is the `carriesRealCredentials` pattern extended from tokens to PII, and the accepted risk it guards is heavier: there, a plaintext token in a column; here, a stranger's identity documents existing at all.

**What a real verifier must arrive with, in the same change and not after it:** a data-processing agreement, a retention schedule, a recorded lawful basis for the processing, and the deletion path a person can ask us to walk. The interval between real PII being collected and those existing is exactly the exposure, which is the same argument the plaintext-token risk makes about encryption.

**The seam keeps documents out by construction.** `IdentityVerifier.verify` returns verdicts, scores and provider references and has nowhere to put an image, so a provider wanting to hand us a passport scan would have to change the interface in a diff somebody reads. The fake runs no `face_search` and therefore never writes a `matched_node_id`: a duplicate-identity finding names a third party, and inventing one from a fake would put a real accusation in an append-only table on the strength of nothing.

**The node's own surface shows the status and never the log** (`apps/web/app/node`), and says so in words rather than rendering an empty list that looks like a bug. `node_profiles.kyc_status` is a node's legitimate view of themselves; the evidence behind it is not theirs to read, for the reason above.

**GDPR erasure vs. AML retention, recorded rather than assumed.** `node_verifications.node_id` cascades on user delete. That is defensible **only** while we store references and verdicts and the provider is the record-keeper. **Trigger to revisit:** the first jurisdiction that requires _us_ to retain, at which point the foreign key becomes `on delete restrict` and erasure becomes a redaction rather than a delete.

## Payments / money-transmission exposure

- Holding escrow and routing payouts is likely a **regulated money-services activity**. Stripe is **not** a licensed escrow provider — we use _separate charges & transfers_ with delayed payouts as an escrow-equivalent.
- **Counsel action items (do not hand-wave):** money-transmission / escrow-licensing analysis per jurisdiction (US state MTL regime, EU e-money/payment-institution rules; GEL/FX for the future Georgia pack); platform-of-record determination; tax reporting (1099-K / DAC7).
- Nodes onboard via **Stripe Connect Express** so the provider handles their KYC/tax and payout compliance.

## Regulated-advice boundaries (UPL / accountancy)

- The AI provides **information/research only** and never presents legal/tax/accounting/investment output as **authoritative** — the binding version comes from a licensed human node carrying professional indemnity.
- **Persistent disclaimers** ("informational, not legal/financial advice; verify with a licensed professional") on every regulated output, logged with the message.
- **Hard prohibitions:** the AI never signs/notarizes, never authenticates _as_ the user, never enters banking/ID/card data, never completes KYC/source-of-wealth for the owner.
- **Per-action confirmation:** any message sent on the user's behalf, public content published, form submitted, or purchase made requires explicit user approval — **per-action, not blanket.**
- Consumer-protection / advertising compliance for AI-generated marketing (truthful claims, alcohol-ad rules, labeling AI-generated content where required).

## Auditability & incident response

- Every recommendation, citation, disclaimer, hand-off, and approval is timestamped and recorded so responsibility is traceable (liability + dispute defense).
- **Secrets:** Doppler/Infisical; env schema Zod-validated; no secrets in the repo or client bundle.
- **Dependency security:** Renovate/Dependabot; majors reviewed.
- **Incident response:** documented in [`docs/50-runbooks/`](../50-runbooks/); Sentry alerting; kill switch for runaway agents.

## Enforcement checklist (per PR)

- [ ] RLS on for new tables; pgTAP membership tests added.
- [ ] No `service_role` in any client-reachable path.
- [ ] Side-effecting tools enforce allow-lists + spend caps + idempotency in code.
- [ ] Retrieved/external content treated as data; no PII in URLs/logs/RAG.
- [ ] Regulated output carries disclaimer + escalation path.
- [ ] Money movement idempotent + event-sourced.

### Offer visibility (marketplace slice 4)

`public.offers` has **one policy**, `node_id = auth.uid()`, and `grant select` to
`authenticated`. Three consequences are deliberate and asserted rather than
reviewed:

- **The node sees only their own offers.** A plain equality with no join, because
  `node_profiles` is keyed on `user_id`.
- **The project owner sees none**, including for their own project's steps. An
  offer names a node, and `20260901122000` narrowed `private.shares_room_with` to
  close the owner-sees-node and node-sees-owner halves together. Handing the owner
  a row carrying `node_id` would reopen that pair through a side door one slice
  before the engagement slice decides what it should show. The panel shows
  `tasks.state`, which is what the owner needs.
- **Nothing is deleted, including by `service_role`.** `delete` and `truncate` are
  revoked from every role: the offer trail is what a dispute reads.

The node-facing projection is the second control and is asserted directly, the way
the channel-connection projection is: `NodeOffer` carries three task fields and
**no task id, no project id and nothing identifying the owner**. The node holds no
RLS grant on `tasks` or `projects` and gains none, so those fields are read
service-side and copied in.
