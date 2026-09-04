import { labelForModel, type ModelConnection, type ModelRole } from '@octopus/contracts';

/**
 * Every sentence the Models block says, in one file.
 *
 * **The copy is here rather than inline for the same reason
 * `notification-copy.ts` exists**: AGENTS.md rule 22 bans em dashes in product
 * copy and this block is the surface where somebody pastes a paid credential,
 * so its wording is the part most worth checking on every push. Strings
 * scattered through JSX can only be checked by a person reading the component;
 * strings in an exported object can be walked by a test.
 *
 * The rules the wording follows, so a later edit keeps them: a status is a word
 * plus a dot and never a colour on its own (rule 15); nothing claims a thing was
 * saved that was not; and the two sentences about the key say what happens to it
 * rather than reassuring the reader that it is safe.
 */
export const MODELS_COPY = {
  heading: 'Models',
  loading: 'Loading.',
  loadFailed: 'Could not load the model settings.',

  /* The empty state names what actually happens next, because "none connected"
     on its own reads as broken when the product is in fact working. */
  none: 'No provider connected. Octopus runs on its default model until you connect one.',

  connectOpen: 'Connect a model',
  connectCancel: 'Cancel',
  providerLabel: 'Provider',
  keyLabel: 'API key',
  keyPlaceholder: 'Paste your key',
  /* Two facts, both checkable in the code: the key is sealed before it is
     written (`20260913120000`), and it is only ever sent to the provider it
     belongs to, for this room. Neither sentence promises anything else. */
  keyStorage: 'Stored encrypted. Used only to call this provider for this workspace.',
  connectSubmit: 'Connect',
  /* "Checking" rather than "Saving", because that is what the wait is: the key
     is verified against the provider's own models endpoint before a row exists. */
  connectBusy: 'Checking',
  connectFailed: 'Could not connect that.',

  disconnect: 'Disconnect',
  disconnectBusy: 'Disconnecting',
  disconnectFailed: 'Could not disconnect that.',
  /* Said before the click, because revoking a key also drops every role routed
     to it and a person should not learn that from the list going quiet. */
  disconnectNote: 'Disconnecting a provider also clears every role routed to it.',

  routesHeading: 'Who runs on what',
  routeSaved: 'saved',
  routeBusy: 'saving',
  routeFailed: 'Could not save that choice.',
  routesLocked: 'Connect a provider to choose who runs on what.',

  /* Auto with no house default to name. The AI service was unreachable when the
     settings were read, and guessing a model name here would be inventing the
     one fact this line exists to report. */
  autoNoHouse: 'Auto (house default)',
  unknownDefault: 'the default model',

  fakeNote: 'Built-in test provider. Returns canned answers.',
} as const;

/** A connection's state, in words. `revoked` reads as the action somebody took. */
export const MODEL_STATUS_COPY: Record<ModelConnection['status'], string> = {
  active: 'Connected',
  revoked: 'Disconnected',
};

/**
 * The six roles, named as a person would describe the job rather than as the
 * enum spells it. The first four are the agent voices (ADR-0031) and carry the
 * same names the members panel and the composer's mention list use, because a
 * picker that renamed them would be a second vocabulary for the same four
 * things.
 */
export const MODEL_ROLE_LABELS: Record<ModelRole, string> = {
  strategist: 'Strategist',
  content: 'Content',
  ads: 'Ads',
  analyst: 'Analyst',
  fallback: 'Fallback answers',
  creative: 'Creative',
};

/**
 * The two roles that are not one of the four voices need a line, because their
 * names do not tell you what routing them would do.
 *
 * The Creative note said "nothing produces an image yet" for one slice, which was
 * the honest thing while it was true. It now says what routing it actually does,
 * and it names the brief, because the brief is still the deliverable and the
 * images are what comes with it (ADR-0033).
 */
export const MODEL_ROLE_NOTES: Partial<Record<ModelRole, string>> = {
  fallback: 'Answers when the corpus cannot. Never cited, and never about a regulated act.',
  creative: 'Draws the images for a creative step, on your own key. The brief is written anyway.',
};

/**
 * What Auto means right now, named rather than left as a word.
 *
 * The house default comes from the AI service's own `/health`, so this is a
 * report and not a second copy of the model id. When the service could not be
 * reached the option still exists and still works; it simply does not claim to
 * know which model will answer.
 */
export function autoOptionLabel(houseDefault: { provider: string; model: string } | null): string {
  if (!houseDefault) return MODELS_COPY.autoNoHouse;
  return `Auto (house default: ${labelForModel(houseDefault.model)})`;
}
