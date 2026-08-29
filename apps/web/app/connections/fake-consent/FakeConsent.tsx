'use client';

import { useState } from 'react';
import { fakeAuthorizationCode } from '@octopus/marketing/fake-consent-code';

/**
 * What the fake provider shows before it hands back a code.
 *
 * Imports from `@octopus/marketing/fake-consent-code`, the subpath export that
 * exists precisely for this: the code format has to agree with the server that
 * decodes it, and the rest of that package reaches for `node:crypto`, which has
 * no business in a browser bundle.
 *
 * **It never sees the state, it only carries it.** The value round-trips
 * untouched, because the party that verifies a state is the party that signed
 * it, and this page is standing in for a third party that could not verify it
 * anyway.
 */
export function FakeConsent({
  state,
  redirectUri,
  scopes,
}: {
  state: string;
  redirectUri: string;
  scopes: string[];
}) {
  const [granted, setGranted] = useState<string[]>(scopes);

  // A malformed link is refused rather than rendered with dead buttons. This
  // page is only ever reached from a URL the API composed, so arriving without
  // the two things that make it work means somebody is poking at it.
  if (!state || !redirectUri) {
    return (
      <main className="consent" data-skin="light">
        <h1 className="consent-title">This authorisation link is incomplete</h1>
        <p className="consent-body">
          Start again from Connected accounts in the workspace you want to connect.
        </p>
      </main>
    );
  }

  function leave(params: Record<string, string>) {
    const url = new URL(redirectUri);
    url.searchParams.set('state', state);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    window.location.assign(url.toString());
  }

  function toggle(scope: string) {
    setGranted((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  return (
    <main className="consent" data-skin="light">
      <p className="consent-eyebrow">Test provider</p>
      <h1 className="consent-title">Connect this account to Octopus?</h1>
      <p className="consent-body">
        This is a built-in stand-in for a real ad platform. It authorises nothing, reaches no real
        service, and the credentials it issues cannot spend money or publish anything.
      </p>

      <fieldset className="consent-scopes">
        <legend className="consent-legend">Permissions Octopus is asking for</legend>
        {scopes.length === 0 && <p className="consent-body">No permissions were requested.</p>}
        {scopes.map((scope) => (
          <label key={scope} className="consent-scope">
            <input
              type="checkbox"
              checked={granted.includes(scope)}
              onChange={() => toggle(scope)}
            />
            <span className="mono">{scope}</span>
          </label>
        ))}
        {/* Said plainly, because a person unticking a box should know what it
            costs rather than discovering it when a step fails later. */}
        {granted.length < scopes.length && (
          <p className="consent-note">
            Anything you leave unticked will be recorded as not granted, and steps needing it will
            stop and ask you.
          </p>
        )}
      </fieldset>

      <div className="consent-actions">
        {/* Cancel first in the DOM and visually secondary: the refusal must be
            at least as reachable as the approval, on a screen whose entire job
            is asking permission. */}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => leave({ error: 'access_denied' })}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => leave({ code: fakeAuthorizationCode(granted) })}
        >
          Approve
        </button>
      </div>
    </main>
  );
}
