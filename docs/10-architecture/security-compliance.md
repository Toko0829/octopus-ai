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
  >
  > **There are three flags of this shape now, and the third guards a regulator.** `carriesRealCredentials` guards plaintext channel tokens, `carriesRealPii` guards identity documents, and **`carriesRealMoney`** (`packages/payments/src/provider-registry.ts`, slice 5) guards the counsel gate in [payments-billing.md](../30-modules/payments-billing.md): before real, non-test money moves, money-transmission and escrow-licensing must be cleared per jurisdiction, platform-of-record determined and tax reporting settled. `apps/api/src/lib/engagements.ts` refuses on it **before any rpc**, so the first person to register Stripe hits a failing write rather than a paragraph they did not read. Like both siblings it raises on an unregistered provider rather than answering `false`. The only registered provider is a deterministic in-repo fake that makes no network call, holds no key and settles nothing, and its reference is visibly `ch_fake_…` in every `escrow_holds` row this build writes.

- **`channel_connections` is the one table with no reader at all**, and it is a stronger version of the `events` stance rather than the same one. RLS filters rows, not columns, so any select policy that returned the row would return the secrets with it. A member's legitimate view ("Meta account connected, scopes X, expires Y") is an API projection that never selects the token columns.

  > **That projection exists now, and it is the only control on its own path.** `GET /api/rooms/:roomId/connections` is the one route group in this system where RLS defends nothing: the table has no grant to `authenticated`, so the read cannot run as the caller and must use the service client. Membership is therefore established separately and first, by reading the room as the caller so RLS decides visibility, and a room it hides yields 404 before anything else runs. The column list lives in one constant in `apps/api/src/lib/connections.ts` and is **asserted directly in the tests**, both by naming the eight columns and by checking that neither token column nor a `*` appears, because a `select *` written while debugging would be a silent, total credential leak to every member of the room. `ChannelConnection` in `packages/contracts` has no field for a token either, so a projection that started returning one would fail to typecheck before it reached a browser.
  >
  > Reading is open to any member, which is what the table's own comment promised. **Connecting and disconnecting are owner-only**, because `connect_channel` is `high_risk` in exactly the way `create_campaign` is: it hands a system access to somebody's real account.

- **Dynamic group-chat RLS** is tested with **pgTAP** in `supabase/tests/rls_membership.sql` (26 assertions, verified green against the live database). Covers a room shared by an owner, an unexpired node, an **expired** node and an outsider, across `rooms`, `messages`, `action_embeds` and `feedback_events`.

  The load-bearing case is that an **expired node sees nothing at all**: not the room, not the messages, not the plan card. Time-boxed access is what the entire marketplace model rests on, and until this file existed the only evidence it worked was that nothing had visibly leaked.

- **What a workspace knows about its business is the owner's alone to read** (`supabase/tests/room_profiles.sql`, 10 assertions, verified green against the live database). `room_profiles` carries the first owner-only policy in the database: a member of the room reads zero rows, because a budget band is the one thing a human node admitted to the room has no business seeing and RLS filters rows, not columns. No client write grant; the API writes after an ownership check.

- **Answering a question card is owner-only on the route, and the functions behind it are `service_role`-only** (`supabase/tests/question_answers.sql`, 12 assertions, verified green against the live database). An answer used to be a chat message that never reached the action route, so the owner-only rule lived inside the agent run; it is now checked on the route before anything is written, and `answer_question_slot` / `answer_question_task` refuse `authenticated` outright, so the only path to a card's payload is through that check.

  The suite also asserts **privileges, not only policies**, because RLS filters rows a grant already permits and the two fail very differently. `TRUNCATE` is checked explicitly since it bypasses RLS entirely.

  Tests run as `authenticated` with `request.jwt.claims` set, exactly as PostgREST would. Running them as `postgres` would prove nothing: that role bypasses RLS, which is precisely how a policy bug survives review. Everything is inside a transaction that `ROLLBACK`s, so it is safe against a live database.

  Four of the assertions cover a different property and were added with `20260831110000`: **a role is never self-service.** `20260724000000:21` promised a trigger preventing self role changes and no migration ever wrote one, so `update public.profiles set role = 'admin' where user_id = auth.uid()` succeeded for any signed-in person — measured on the live database, where it completed with no error and the row read back `admin`, before being rolled back. Latent only because nothing authorises on `profiles.role` yet; it stops being latent the moment `human_node` means "eligible for paid work funded from somebody else's budget". Fixed with a column grant **and** a trigger, because the table-wide grant has already been silently restated once (`20260812120100:31`) and a `grant` line cannot undo a trigger. The sharp assertion runs **as `postgres` with a person's claims set**, bypassing both the grant and RLS so that only the trigger can refuse: run as `authenticated` it would be stopped by the column grant first and would still pass with the trigger deleted.

  **Ops/admin access paths are covered as of marketplace slice 8**, and they are the first ones that existed. `apps/api/src/plugins/require-ops.ts` is the first authorisation in this system to read `profiles.role`, and it reads it **from the database rather than from the JWT** — the claim does not carry it (`toRole()` maps Supabase's `role = 'authenticated'` to `'user'`, so a check against the claim would refuse everybody while looking like a working deny-by-default).

There is deliberately **no RLS policy that tests `profiles.role`**, on any of the four tables the ops console reads. Such a policy needs a `SECURITY DEFINER` helper in `public`, which is exactly the shape recorded above as having been reintroduced once by somebody who had already read the migration that removed it. The layering instead is: the route check is the control, and **no client grant at all** is the backstop — `ledger_entries`' posture, which fails safe, since dropping the preHandler would still leave the route's own `service_role` reads as the only path to the data. `disputes` and `ratings` carry policies for the two _parties_ only; `ops_actions` carries none.

`ops_actions` is append-only **including for `service_role`**, which is stricter than every money table in this schema: those keep UPDATE because settling is an update, and nothing in an ops trail is ever settled. The account being protected from is the one the operator is using. Covered by `supabase/tests/marketplace_disputes.sql` (62 assertions, including that no client role reads the trail and that `service_role` cannot edit or delete it).

**The least-privilege Postgres role is deliberately not built for this.** The precedent above was written about giving an eval harness database access, where the alternative was handing a scheduled job the service key. The ops routes run inside `apps/api`, which is already the writer of every marketplace RPC with that same key, so a second narrower connection would narrow nothing this process does not already hold. The trigger to build one is ops moving out of this API into its own deployment.

**Still uncovered:** the six ops consoles that do not exist yet (moderation, node ops, payments reconciliation, task-queue ops, RAG source ops, audit-trail explorer). Thread-scoped membership (`room_members.scope`) is no longer among them: it is covered by `supabase/tests/thread_scope.sql` (46 assertions, verified green against the live database), described below.

- **The workflow DAG** is covered by `supabase/tests/rls_workflow.sql` (33 assertions, verified green). Same four actors against `projects` / `tasks` / `task_deps` / `task_runs`, plus the two triggers. Its RLS half runs as a client and its **trigger half runs as `postgres` deliberately**, which is the opposite rule for the opposite reason: RLS must be tested as a client because `postgres` bypasses it, and the state-machine and acyclicity guards must be tested as `postgres` because they are meant to bind trusted server code too. If those ever start passing merely because the caller was privileged, the guard has been lost.

  **Known narrowing, closed.** Project visibility was inherited from room membership, which is coarser than the thread-scoped, time-boxed access this document requires of a node. **It closed in slice 2 of the marketplace sequence** (`20260901120000` … `20260901123000`), and the sequence was ordered so the narrowing was never actually taken: threads landed before any writer existed that could admit anybody. `private.is_project_member` now requires `scope = 'room'`, so **a thread-scoped member is not a project member at all** — not their own task, not their project. Task-level project visibility would join through `engagements`, which does not exist, and a policy that cannot yet be written correctly is not written approximately. `private.artifact_object_project` terminates in the same helper and inherited the narrowing with no edit.

  **`private.shares_room_with` was the half nobody had named.** It backs `profiles_select_co_member` and asked only whether two people share a room, so a thread-scoped node would have read the display name, jurisdiction and languages of **every member of the whole room**. Neither of the two KNOWN NARROWING comments mentioned it. It now requires `scope = 'room'` on both sides. The consequence was a named obligation rather than a gap, and **slice 5 discharged it** (`20260904126000`): `private.engaged_counterparty` joins through `engagements` and backs `profiles_select_counterparty`, a **second** policy on `public.profiles`, so `shares_room_with` keeps answering the roster question alone and the narrowing cannot be lost by editing the counterparty rule. `ended_at is null` is the entire time-box: ending the engagement closes the pair again, with no second copy of any expiry rule. **`node_profiles` and `offers` stay closed** — see below.

- **A policy is only as narrow as the direction somebody asserted.** `20260906125000` corrects `room_members_select_member` for the second time: it gave every **room-scoped** caller sight of every membership row in the room, thread-scoped ones included, while `design-system-frontend.md` said a thread-scoped membership was invisible to the owner. The misreading is `20260901123000`'s, surviving on the other side of the same predicate: `member_scope_covers` asks about the **caller**, not the row, and on `room_members` the rows are themselves the scopes. Nothing caught it because the suite pinned only what a thread-scoped member sees and **never what the owner sees**, so a predicate too generous to room-scoped callers had nothing watching it. Found by looking at a real room with a real node in it, which had never existed before. The lesson is the general one: a narrowing needs assertions on **both** sides, because the wide side fails silently and looks like the product working.

- **Thread-scoped membership** is covered by `supabase/tests/thread_scope.sql` (46 assertions, verified green against the live database). A thread-scoped member sees the room shell, their own thread, its channel, only messages carrying their `thread_id` (**never the null-thread room stream**), only the embeds on messages they can already see, only their own membership row, and no `feedback_events`, project, task, artifact or realtime. The regression half is asserted just as hard, because a predicate narrowed one conjunct too far presents as "nothing loads" rather than as a security change.

  Two findings are recorded rather than smoothed over. **`room_members` is the one table where the row is itself a scope**, so the predicate that is right for `messages` is wrong for it: reused verbatim it let a thread-scoped member read every membership row pointing at their own thread, including that of a node whose access had already lapsed. Caught by this suite asserting 1 and measuring 2, and corrected in `20260901123000`. And the suite's own first run returned `23505` where it expected `23503`, because the fixture used a user who already held a row in the target room, so the primary key refused the insert before the foreign key was ever consulted — a test that would have passed for a reason unrelated to threads.

  **Realtime was extended, not replaced.** Both `realtime.messages` policies inline their membership predicate rather than calling a helper, because the input is `realtime.topic()`, so neither picks up a helper rewrite for free. Both gained `and m.scope = 'room'` in place via `alter policy`, preserving the time-box: an expired node cannot keep a live socket while correctly losing the rows. Note that the receive policy lives in `20260728120000` and `20260728200000` holds the **send** (presence `INSERT`) policy; an earlier version of this document attributed both to the latter. **Thread topics landed in slice 6** (`20260906120000`), as an `OR` inside these same two policies rather than as a third one, which is what keeps the `expires_at` time-box written once per policy: a separate additive policy would union to the same rows and leave a second copy to keep in step, so an expired node could keep a live socket while correctly losing the rows. `broadcast_message` emits the thread topic **beside** the room topic, never instead of it, because the room-scoped owner is entitled to read thread messages and reads them there. `thread_scope.sql` now asserts the narrowing in both directions rather than asserting the absence: a thread-scoped member reaches their own thread topic and not the room topic, not another thread's, and not their own once expired; the owner reaches the room topic and no thread topic. Verified green against the live database (11/11 on the realtime and absence assertions).

  > **Amended 2026-09-09: there is a third policy now, and it is not an exception to the rule above.** Notifications slice 1 (`20260909122000`) adds `realtime_own_inbox_can_receive` for the per-user topic `notify:user:<uid>`. The rule the paragraph above states is about the **`expires_at` time-box**, which lives on `room_members` and is what a second policy over the same rows would have had to keep in step. This topic has no membership row and no time-box: its whole predicate is `realtime.topic() = 'notify:user:' || auth.uid()`, which cannot go stale and has no second copy anywhere. Folding it into the two chat policies would have bolted a predicate about a person onto two predicates about rooms, so the next person to edit either would have to reason about all three. **No send policy** is added, because nobody is present in their notifications: the client subscribes and never calls `track()`, and `notifications.sql` pins that a node cannot push to their own inbox topic. `thread_scope.sql`'s exactly-two assertion is **scoped to the two chat policies rather than deleted**, and both suites now assert the total of three, so changing that count still costs somebody an argument. Full reasoning in [ADR-0028](../40-adr/0028-a-notification-is-derived-from-the-event.md).

- **The marketplace domain** is covered by `supabase/tests/marketplace_rls.sql` (46 assertions, verified green against the live database). The slice has no writer, so this file is its only caller — which is what makes four tables landing ahead of their writers defensible rather than dead: every constraint and both triggers are exercised here.

  Two assertions are unlike anything else in the suite set. **The subject of a verification record is refused their own row** (`42501`, not zero rows): `node_verifications` names a third party the node may duplicate and carries adverse-inference scores about the node, and RLS filters rows rather than columns, so there is no policy that could return the row safely. And **`service_role` is refused `UPDATE`, `DELETE` and `TRUNCATE`** on the same table, `TRUNCATE` included because `grant all` includes it and it ignores RLS entirely.

  A third is about an absence being deliberate: **an owner sharing a room with a node sees zero node profiles.** That verdict is unchanged after slice 5 and its stated reason moved. The counterparty policy now exists and opens `public.profiles`; `node_profiles` stays shut, because a rate card, a jurisdiction list, an availability flag and a trust score are not facts about a deal. What the owner gets is the engagement projection: a display name, the frozen price, the date.

- **Engagements, escrow and the ledger** are covered by `supabase/tests/marketplace_engagements.sql` (70 assertions, verified green against the live database). The happy path is asserted end to end through `public.accept_offer` (offer settled, task at `escrow_funded` after **two** audited moves, price frozen against a later rate change, hold `held` under its derived key, **ledger pair balancing**, thread created in a deterministically chosen channel, node admitted thread-scoped with `expires_at` null), and **every refusal is also asserted to leave nothing behind**, because the whole reason acceptance is one database function is atomicity.

  Three assertions pin absences that somebody could reasonably "fix" later. **`held → released` is refused**, worded descriptively rather than as a promise: release is a payout act and its producer does not exist, and a map permitting an arc nothing can walk is the `task_deps` defect. **A client has no grant on `ledger_entries` at all** and the table has RLS enabled with zero policies, the `events` posture, because the reader of raw entries is the Phase-3 ops console. **The project owner still reads zero offer rows**, because an offer names everybody who was _asked_, including the people who declined, and that is a separate disclosure decision from naming the one person who took the work.

  The counterparty pair is asserted **in both directions and in both states**: a live engagement lets the owner read the node's `profiles` row and the node read the owner's, a stranger reads neither, and ending the engagement closes it again.

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
