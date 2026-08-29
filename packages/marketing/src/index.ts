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
 * Three things live here.
 *
 * **The spend cap** (`spend.ts`), because rule 7 puts money limits in tool code
 * and a limit nobody can read is not a control.
 *
 * **The adapter seam** (`adapter.ts`), written before any executor so that
 * slice-2 and slice-3 code is written against an interface rather than against
 * whichever provider happened to arrive first.
 *
 * **The provider registry** (`adapter-registry.ts`), checked in rather than
 * stored, because which implementation may touch somebody's ad account is an
 * editorial and security judgement and a file gets reviewed in a diff.
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
