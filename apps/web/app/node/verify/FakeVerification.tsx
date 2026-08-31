'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { fakeVerificationRef, type FakeOutcome } from '@octopus/marketplace/fake-verification-ref';
import { submitNodeVerification } from '../../../lib/api-client';

/**
 * The test verifier's consent-equivalent, and it says what it is in the first
 * sentence on the screen.
 *
 * **Nothing is uploaded and nothing is checked.** The person picks what the
 * provider will report, the encoding turns that into a session reference the way
 * a real provider's flow returns an inquiry id, and the API hands it to the
 * verifier. The browser never chooses a `kyc_status`: the outcome travels as an
 * opaque reference, the provider decides the checks, and Postgres decides the
 * status from the rows it can see. Three separate decisions, none of them made
 * by this file.
 *
 * The reference is minted here rather than server-side because that is what a
 * real provider does, and because the alternative (posting an outcome and having
 * the API encode it) would be theatre: the API would be constructing a value in
 * order to immediately decode it.
 */

const OUTCOMES: { value: FakeOutcome; label: string; note: string }[] = [
  {
    value: 'pass',
    label: 'Everything passes',
    note: 'Document, liveness and sanctions screening all come back clear. You become verified.',
  },
  {
    value: 'fail',
    label: 'The document check fails',
    note: 'You are marked not accepted. You can submit again from your profile.',
  },
  {
    value: 'inconclusive',
    label: 'The provider cannot decide',
    note: 'Nothing is concluded about you and you go back to not verified, free to try again.',
  },
  {
    value: 'error',
    label: 'The provider errors',
    note: 'Same result as above. It exists so the unhappy path is something a person can click.',
  },
];

export function FakeVerification() {
  const router = useRouter();
  const [picked, setPicked] = useState<FakeOutcome>('pass');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await submitNodeVerification('fake', fakeVerificationRef(picked));
      router.push('/node');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <main className="consent" data-skin="light">
      <p className="consent-eyebrow">Built-in test verifier</p>
      <h1 className="consent-title">This checks nothing</h1>
      <p className="consent-body">
        Octopus has no identity provider wired yet, so this screen stands in for one. Nothing is
        uploaded, no document is read, and no third party is contacted. Choose what the pretend
        provider should report and Octopus will record that as if it were real.
      </p>

      <fieldset className="consent-scopes">
        <legend className="consent-eyebrow">What should it report</legend>
        {OUTCOMES.map((option) => (
          <label key={option.value} className="consent-scope">
            <input
              type="radio"
              name="outcome"
              value={option.value}
              checked={picked === option.value}
              onChange={() => setPicked(option.value)}
            />
            <span>
              <span className="consent-scope-name">{option.label}</span>
              <span className="consent-scope-note">{option.note}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p className="consent-error" role="alert">
          {error}
        </p>
      )}

      <div className="consent-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? 'Recording' : 'Record this result'}
        </button>
        <a className="btn btn-ghost" href="/node">
          Cancel
        </a>
      </div>

      <p className="consent-foot">
        A real provider replaces this page entirely, hosts its own flow, and returns its own
        reference. When one is wired, Octopus will still only ever store the verdicts.
      </p>
    </main>
  );
}
