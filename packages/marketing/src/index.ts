/**
 * `@octopus/marketing` — the first vertical's domain logic, and nothing else.
 *
 * The `@octopus/core` split applied to marketing: what belongs here is the
 * reasoning a reader should be able to check without running anything, and what
 * does not belong here is IO. **There is no Supabase client, no `fetch`, no
 * filesystem access and no clock anywhere in this package**, and that is a
 * property to keep rather than a coincidence of it being early. The reads that
 * feed `checkSpendCap` are queries in `apps/api`; the calls an adapter would make
 * are the provider implementation's problem, and the only implementation today
 * makes none.
 *
 * Two authorisation decisions and two seams live here.
 *
 * **The spend cap** (`spend.ts`), because rule 7 puts money limits in tool code
 * and a limit nobody can read is not a control.
 *
 * **The scope check** (`scopes.ts`), the same rule applied to permission rather
 * than to money: whether a connection may do a thing is answered from what the
 * platform granted, before the call, rather than learned from its 403.
 *
 * **The publish decisions** (`publish.ts`), which is the seam's first caller and
 * the reason it was written early. The idempotency key, which account to publish
 * through, and what to do about what the platform answered: all three are
 * checkable without a database, a platform account, or a running ticker.
 *
 * **The adapter seam** (`adapter.ts`), written before any executor so that
 * slice-3 code is written against an interface rather than against whichever
 * provider happened to arrive first.
 *
 * **The auth seam** (`auth.ts`), the same discipline for the act of connecting
 * an account. Separate from the adapter because the two change for different
 * reasons: a platform can rewrite its campaign API without touching its OAuth
 * endpoints, and the reverse.
 *
 * **Two registries** (`adapter-registry.ts`, `auth-registry.ts`), checked in
 * rather than stored, because which implementation may touch somebody's ad
 * account is an editorial and security judgement and a file gets reviewed in a
 * diff. The auth registry carries one flag more than its sibling:
 * `carriesRealCredentials` is the enforced half of the plaintext-token accepted
 * risk, and the writer refuses on it.
 *
 * `@octopus/contracts` **is** a dependency now, and it was not before. The
 * campaign card is the slice this file's previous note named as the moment that
 * would change: `MarketingChannel` is on a card payload, in an action route and
 * in the project panel, so it moved to `contracts` and is re-exported from
 * `adapter.ts`. Only that one type moved. `CreateCampaignSpec` and the rest of
 * the seam still face an adapter rather than a wire, and moving them now would
 * be the unused edge rule 20 asks us not to add.
 *
 * See docs/30-modules/marketing-growth-engine.md.
 */

export {
  checkSpendCap,
  type SpendCapInput,
  type SpendCapRule,
  type SpendCapVerdict,
} from './spend';

export {
  MarketingChannel,
  MetricsPeriod,
  CreateCampaignSpec,
  CreateAdSetSpec,
  CreateAdSpec,
  AdapterEntityRef,
  MetricsRow,
  AdapterError,
  type AdapterResult,
  type AdChannelAdapter,
} from './adapter';

export { createFakeAdapter, FAKE_PROVIDER, POLICY_VIOLATION_MARKER } from './fake-adapter';

export {
  ADAPTER_REGISTRY,
  adapterFor,
  isRegisteredProvider,
  registeredProviders,
} from './adapter-registry';

export {
  AuthorizeRequest,
  AuthError,
  ChannelCredential,
  ExchangeRequest,
  type AuthResult,
  type ChannelAuthProvider,
} from './auth';

export {
  createFakeAuthProvider,
  fakeAuthorizationCode,
  DENY_MARKER,
  FAKE_AUTH_PROVIDER,
} from './fake-auth-provider';

export {
  AUTH_PROVIDER_REGISTRY,
  authProviderFor,
  carriesRealCredentials,
  defaultScopesFor,
  isRegisteredAuthProvider,
  registeredAuthProviders,
  type AuthProviderEntry,
} from './auth-registry';

export {
  checkScopes,
  PUBLISH_REQUIRED_SCOPES,
  type ScopeCheckInput,
  type ScopeRule,
  type ScopeVerdict,
} from './scopes';

export {
  chooseConnection,
  decidePublishOutcome,
  publishIdempotencyKey,
  type ConnectionChoice,
  type ConnectionChoiceRule,
  type PublishConnectionCandidate,
  type PublishDecision,
} from './publish';
