import {
  MODEL_PROVIDERS,
  labelForModel,
  type ModelConnection,
  type ModelEntry,
  type ModelProviderProfile,
  type ModelRole,
  type ModelRoute,
  type ModelSettingsResponse,
} from '@octopus/contracts';
import { MODELS_COPY } from './models-copy';

/**
 * Turning the model settings into the words two surfaces render.
 *
 * **Pure, and in `lib/` rather than in the component, because these are the
 * decisions worth a test.** Which model a role actually runs on is a fact
 * assembled from three places (the room's routes, the registry, the house
 * default the AI service reports) and getting it wrong would be a confident
 * label naming the wrong model on a message somebody is about to act on. A
 * component can be reviewed by eye; this can be asserted.
 *
 * **An unknown id is rendered verbatim, never as "Unknown".** `labelForModel`
 * in the contracts registry already takes that stance (ADR-0032 decision 4) and
 * everything here inherits it: a model this build has never heard of is still
 * the true answer to "what wrote this", and a page that hides it hides the audit
 * trail rather than a defect.
 */

/** What the AI service says Auto currently means, or null when it was unreachable. */
export type HouseDefault = ModelSettingsResponse['houseDefault'];

/**
 * Everything the "runs on" line needs, as one argument.
 *
 * Grouped rather than passed as two, because a caller holding routes without the
 * house default beside them would have to invent what Auto means, which is the
 * one thing this pair exists to avoid.
 */
export interface ModelReadout {
  routes: readonly ModelRoute[];
  houseDefault: HouseDefault;
}

/** No connection and no reachable service. What a room looks like before any of this. */
export const NO_MODELS: ModelReadout = { routes: [], houseDefault: null };

/**
 * The routes as a lookup.
 *
 * Later rows win. The server writes at most one row per role, so this only ever
 * matters if that stops being true, and in that case the newest answer is the
 * less wrong one to render.
 */
export function routesByRole(
  routes: readonly ModelRoute[],
): Partial<Record<ModelRole, ModelRoute>> {
  const byRole: Partial<Record<ModelRole, ModelRoute>> = {};
  for (const route of routes) byRole[route.role] = route;
  return byRole;
}

/**
 * The model a role runs on, in words.
 *
 * Three answers, in order: the model the workspace routed, else the house
 * default the service named, else a phrase that says a default exists without
 * naming one. The third is not a failure state on the page: a room that has
 * routed nothing and a service that did not answer `/health` in time both land
 * here, and in both cases the true sentence is that some default answers.
 */
export function labelForRoute(route: ModelRoute | undefined, houseDefault: HouseDefault): string {
  if (route) return labelForModel(route.model);
  if (houseDefault) return labelForModel(houseDefault.model);
  return MODELS_COPY.unknownDefault;
}

/**
 * The providers offered on the connect form: everything registered, with the
 * ones that do not carry a real credential last.
 *
 * The ordering is the point. The fake provider is a real entry that a person can
 * genuinely use to walk the whole path without spending anything, so hiding it
 * would be dishonest, and putting it among the three that bill somebody would
 * invite the wrong click. `carriesRealCredentials` is the same flag the writer
 * fails closed on, read here for presentation only.
 */
export function connectableProviders(): ModelProviderProfile[] {
  const all = Object.values(MODEL_PROVIDERS);
  return [
    ...all.filter((p) => p.carriesRealCredentials),
    ...all.filter((p) => !p.carriesRealCredentials),
  ];
}

/** One optgroup: a connected provider and the models it offers for this role. */
export interface RoleOption {
  provider: ModelProviderProfile;
  models: readonly ModelEntry[];
}

/**
 * What a role may be routed to: every connected provider, and from each of them
 * only the models that can do this role's job.
 *
 * **Creative takes image models and the other five take text models**, which is
 * a filter on the registry rather than a rule in the picker: `images` is a
 * property of the model, and a text model routed to Creative would fail inside a
 * run, minutes later, in a system notice.
 *
 * Revoked connections are absent. A route to a provider whose key is gone cannot
 * normally exist (revoking deletes its routes) and offering one here would be
 * offering to create the case the server works to prevent.
 */
export function optionsForRole(
  role: ModelRole,
  connections: readonly ModelConnection[],
): RoleOption[] {
  const wantsImages = role === 'creative';
  const connected = new Set(
    connections.filter((c) => c.status === 'active').map((c) => c.provider),
  );

  const options: RoleOption[] = [];
  // Registry order rather than connection order, so the list does not reshuffle
  // itself because somebody reconnected a key.
  for (const provider of Object.values(MODEL_PROVIDERS)) {
    if (!connected.has(provider.id)) continue;
    const models = provider.models.filter((m) => m.images === wantsImages);
    if (models.length > 0) options.push({ provider, models });
  }
  return options;
}
