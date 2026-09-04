'use client';

import { useState, type FormEvent } from 'react';
import {
  MODEL_PROVIDERS,
  ModelRole,
  type ModelConnection,
  type ModelProviderId,
  type ModelSettingsResponse,
} from '@octopus/contracts';
import { connectModel, disconnectModel, patchModelRoutes } from '../../lib/api-client';
import {
  connectableProviders,
  labelForRoute,
  optionsForRole,
  routesByRole,
} from '../../lib/model-labels';
import {
  MODELS_COPY,
  MODEL_ROLE_LABELS,
  MODEL_ROLE_NOTES,
  MODEL_STATUS_COPY,
  autoOptionLabel,
} from '../../lib/models-copy';

/**
 * The workspace's own models: which providers are connected, and which one
 * answers for each of the six roles (ADR-0032).
 *
 * **In the rail, beside connected accounts, and that placement is inherited
 * rather than re-argued.** `ConnectedAccounts` was first built into the project
 * panel and could not be found there, because that panel is a modal called "The
 * work" and nobody hunting for settings opens it. A model connection is the same
 * kind of fact as an ad account: room-scoped, set once, read often. It sits in
 * the same column for the same reason.
 *
 * **A route is a preference, not a grant**, and this component is the surface
 * most likely to tempt a later change into treating it as one. Choosing the
 * strongest model for the Ads voice gives that voice exactly the authority it
 * had before, which is none: `routeTask`, the spend cap and the plan card as the
 * authorisation boundary do not read a route. All a route decides is which
 * endpoint composes a proposal that a person still has to approve.
 *
 * **The key is typed here and never comes back.** `ModelSettingsResponse` has no
 * field for one, so this component could not render a stored key even if a later
 * edit tried; what it shows is the last four characters, which exist so a person
 * can tell two keys apart and complete into nothing.
 *
 * **Owner-only controls are absent for everybody else, never disabled.** A member
 * sees which model each voice runs on, as text, because that is a fact about the
 * answers they are reading. They do not see a greyed-out form telling them what
 * they are not allowed to do.
 */
export function ModelSettings({
  roomId,
  canAct,
  settings,
  error,
  onChanged,
}: {
  roomId: string;
  /** True for the workspace owner. Connecting a key and routing are owner-only. */
  canAct: boolean;
  /** Null while the first read is in flight, or after it failed. */
  settings: ModelSettingsResponse | null;
  /** The read's own failure, reported here rather than swallowed by the shell. */
  error: string | null;
  /**
   * Re-read the settings. Called after every write, including the ones whose
   * response already carries the new state: connections and routes move together
   * (revoking a key clears its routes) and one refetch is easier to reason about
   * than four places that each patch half of it.
   */
  onChanged: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [provider, setProvider] = useState<ModelProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedRole, setSavedRole] = useState<ModelRole | null>(null);

  const connections = settings?.connections ?? [];
  const live = connections.filter((c) => c.status !== 'revoked');
  const byRole = routesByRole(settings?.routes ?? []);
  const houseDefault = settings?.houseDefault ?? null;

  async function connect(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key) return;
    setBusy('connect');
    setFormError(null);
    try {
      await connectModel(roomId, { provider, apiKey: key });
      // Cleared on success only. A refused key stays in the field, because
      // retyping a hundred-character secret to fix a trailing space punishes the
      // wrong mistake.
      setApiKey('');
      setPicking(false);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : MODELS_COPY.connectFailed);
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(connection: ModelConnection) {
    setBusy(connection.id);
    setFormError(null);
    try {
      await disconnectModel(roomId, connection.id);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : MODELS_COPY.disconnectFailed);
    } finally {
      setBusy(null);
    }
  }

  /**
   * One role, saved on change.
   *
   * The `AboutBusiness` pattern: no Save button beside six selects, because a
   * picker whose choice is not yet the state of the system is a picker people
   * misread. The empty value clears the role, which is what Auto is: no row, and
   * the house default answers.
   *
   * The option value carries a pair in one string and is split on the **first**
   * colon. Provider ids are a closed enum with no colon in them; model ids are
   * the vendor's own, and one of them will eventually have a colon in it, which
   * is exactly the case a naive split would get wrong.
   */
  async function route(role: ModelRole, value: string) {
    setBusy(role);
    setFormError(null);
    setSavedRole(null);
    const cut = value.indexOf(':');
    const nextProvider = cut === -1 ? null : (value.slice(0, cut) as ModelProviderId);
    const nextModel = cut === -1 ? null : value.slice(cut + 1);
    try {
      await patchModelRoutes(roomId, {
        routes: [{ role, provider: nextProvider, model: nextModel }],
      });
      setSavedRole(role);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : MODELS_COPY.routeFailed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="ctx-models">
      {/* `ctx-label` rather than a heading of its own, so this reads as another
          section of the rail beside "In this room" and "Connected accounts". */}
      <h3 className="ctx-label">{MODELS_COPY.heading}</h3>

      {(error ?? formError) && (
        <p className="ctx-conn-error" role="alert">
          {error ?? formError}
        </p>
      )}

      {/* Loading and empty are different answers. "No provider connected" while
          the request is still in flight is a false statement about somebody's
          workspace, and this is the one block where that statement would send
          them to paste a key they have already pasted. */}
      {settings === null && !error && <p className="ctx-empty">{MODELS_COPY.loading}</p>}

      {settings !== null && live.length === 0 && <p className="ctx-empty">{MODELS_COPY.none}</p>}

      {live.length > 0 && (
        <ul className="ctx-conn-list">
          {live.map((c) => (
            <li key={c.id} className="ctx-conn">
              <div className="ctx-conn-head">
                <span className="ctx-conn-name">{MODEL_PROVIDERS[c.provider].label}</span>
                <span className={`ctx-conn-status ${c.status}`}>
                  <span aria-hidden="true" className="ctx-conn-dot" />
                  {MODEL_STATUS_COPY[c.status]}
                </span>
              </div>
              {/* Four characters, rendered mono so it reads as an identifier
                  rather than as part of the sentence around it. */}
              <p className="ctx-conn-detail mono">Key ending {c.keyHint}</p>
              {canAct && (
                <button
                  type="button"
                  className="ctx-conn-link"
                  disabled={busy !== null}
                  onClick={() => disconnect(c)}
                >
                  {busy === c.id ? MODELS_COPY.disconnectBusy : MODELS_COPY.disconnect}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* A disclosure rather than a form always on show, the same argument the
          accounts block makes: the rail is a narrow column on screen the whole
          time, and this is an action most people take once. */}
      {canAct && (
        <div className="ctx-conn-actions">
          {!picking ? (
            <button type="button" className="ctx-conn-link" onClick={() => setPicking(true)}>
              {MODELS_COPY.connectOpen}
            </button>
          ) : (
            <form className="ctx-model-form" onSubmit={connect}>
              <label className="sr-only" htmlFor={`models-${roomId}-provider`}>
                {MODELS_COPY.providerLabel}
              </label>
              <select
                id={`models-${roomId}-provider`}
                className="auth-input"
                value={provider}
                disabled={busy !== null}
                onChange={(e) => setProvider(e.target.value as ModelProviderId)}
              >
                {connectableProviders().map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>

              <label className="sr-only" htmlFor={`models-${roomId}-key`}>
                {MODELS_COPY.keyLabel}
              </label>
              <input
                id={`models-${roomId}-key`}
                className="auth-input"
                type="password"
                /* Off, and it matters more here than on a sign-in form: a browser
                   offering to remember an API key it saw in a settings panel puts
                   a paid credential in a second store nobody audits. */
                autoComplete="off"
                spellCheck={false}
                maxLength={512}
                value={apiKey}
                disabled={busy !== null}
                placeholder={MODELS_COPY.keyPlaceholder}
                onChange={(e) => setApiKey(e.target.value)}
              />

              {/* Where to get the key, from the registry rather than restated
                  here, so a provider's own entry owns its instructions. */}
              <p className="ctx-conn-detail">{MODEL_PROVIDERS[provider].keyHelp}</p>
              {!MODEL_PROVIDERS[provider].carriesRealCredentials && (
                <p className="ctx-conn-detail">{MODELS_COPY.fakeNote}</p>
              )}
              <p className="ctx-conn-detail">{MODELS_COPY.keyStorage}</p>

              <div className="ctx-model-form-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy !== null || apiKey.trim().length === 0}
                >
                  {busy === 'connect' ? MODELS_COPY.connectBusy : MODELS_COPY.connectSubmit}
                </button>
                <button
                  type="button"
                  className="ctx-conn-link"
                  disabled={busy !== null}
                  onClick={() => {
                    setPicking(false);
                    setApiKey('');
                    setFormError(null);
                  }}
                >
                  {MODELS_COPY.connectCancel}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <h3 className="ctx-label">{MODELS_COPY.routesHeading}</h3>

      {/* An owner with nothing connected reads the roles as text too, rather than
          six selects whose only option is the one they already have. */}
      {canAct && settings !== null && live.length === 0 && (
        <p className="ctx-empty">{MODELS_COPY.routesLocked}</p>
      )}

      <ul className="ctx-model-list">
        {ModelRole.options.map((role) => {
          const current = byRole[role];
          const options = optionsForRole(role, connections);
          // No connected provider offers a model this role could use, so there is
          // nothing to choose between. Creative reaches this state on a workspace
          // that has connected only a text provider.
          const editable = canAct && options.length > 0;
          const note = MODEL_ROLE_NOTES[role];

          return (
            <li key={role} className="ctx-model">
              <div className="ctx-model-head">
                <span className="q-label">{MODEL_ROLE_LABELS[role]}</span>
                {busy === role && <span className="q-state mono">{MODELS_COPY.routeBusy}</span>}
                {busy !== role && savedRole === role && (
                  <span className="q-state mono">{MODELS_COPY.routeSaved}</span>
                )}
              </div>

              {editable ? (
                <>
                  <label className="sr-only" htmlFor={`models-${roomId}-${role}`}>
                    {MODEL_ROLE_LABELS[role]}
                  </label>
                  <select
                    id={`models-${roomId}-${role}`}
                    className="auth-input"
                    disabled={busy !== null}
                    value={current ? `${current.provider}:${current.model}` : ''}
                    onChange={(e) => void route(role, e.target.value)}
                  >
                    <option value="">{autoOptionLabel(houseDefault)}</option>
                    {/* The provider names the group and the option names the
                        model. Both said the provider at first, which read as
                        "Fake (testing) > Fake (testing) · Fake strong": the
                        grouping already carries that half, so repeating it inside
                        every option was noise in a column this narrow. */}
                    {options.map((group) => (
                      <optgroup key={group.provider.id} label={group.provider.label}>
                        {group.models.map((model) => (
                          <option key={model.id} value={`${group.provider.id}:${model.id}`}>
                            {model.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </>
              ) : (
                <p className="ctx-model-route">{labelForRoute(current, houseDefault)}</p>
              )}

              {note && <p className="ctx-conn-detail">{note}</p>}
            </li>
          );
        })}
      </ul>

      {canAct && live.length > 0 && <p className="ctx-conn-detail">{MODELS_COPY.disconnectNote}</p>}
    </section>
  );
}
