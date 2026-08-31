'use client';

import { useMemo, useState } from 'react';
import type { NodeCredential, NodeProfile } from '@octopus/contracts';
import {
  NO_WORK_YET,
  SKILL_TAXONOMY,
  ineligibilityReason,
  isEligibleForWork,
  skillRejectionReason,
} from '@octopus/marketplace';
import {
  addNodeCredential,
  addNodeSkill,
  patchNode,
  removeNodeSkill,
  revokeNodeCredential,
} from '../../lib/api-client';

/**
 * A node's own record, and the only surface in the product that belongs to them.
 *
 * Three rules from the design system are load-bearing here rather than
 * decorative, and each one is a place this screen could have lied.
 *
 *   1. **Status is words plus a dot, never colour alone** (rule 15). Somebody
 *      reading "verified" in green and somebody reading it in grey have to reach
 *      the same conclusion.
 *   2. **A disabled control says why.** `availability` cannot be set to available
 *      until `kyc_status` is verified, because a table constraint says so. A
 *      toggle that silently did nothing is how a person concludes the product is
 *      broken, so the reason is printed beside it.
 *   3. **Nothing here claims to be verified when it is not.** Every skill and
 *      every licence is a claim, `verified` is false on all of them today, and
 *      the surface says "claimed" rather than leaving the word out and letting
 *      the reader assume.
 *
 * **The verification log is absent and cannot be added.** `node_verifications`
 * has no policy and no client grant at all, and refuses `permission denied` to
 * the subject of the record, because a face-search result names a third party
 * they may be a duplicate of. What this screen shows is the status; what
 * happened to produce it is not the node's to read, and saying so is better than
 * an empty list that looks like a bug.
 */

const STATUS_COPY: Record<NodeProfile['kycStatus'], string> = {
  unverified: 'Not verified',
  pending: 'Being checked',
  verified: 'Verified',
  rejected: 'Not accepted',
  suspended: 'Suspended',
};

const AVAILABILITY_COPY: Record<NodeProfile['availability'], string> = {
  available: 'Taking work',
  paused: 'Paused',
  offboarded: 'Left the marketplace',
};

const CREDENTIAL_KINDS = ['lawyer', 'accountant', 'notary'] as const;

/**
 * The shape `private.is_jurisdiction_code` enforces, restated so a typo is a
 * sentence rather than a 409. The database remains the copy that cannot be
 * bypassed; this one only ever refuses more.
 */
const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,2}$/;

interface Props {
  initial: NodeProfile;
  email: string | null;
}

export function NodeConsole({ initial, email }: Props) {
  const [node, setNode] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const eligible = isEligibleForWork(node);
  const reason = ineligibilityReason(node);

  async function run(key: string, work: () => Promise<NodeProfile | void>) {
    setBusy(key);
    setError(null);
    try {
      const updated = await work();
      if (updated) setNode(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="node">
      <p className="node-eyebrow">Octopus marketplace</p>
      <h1 className="node-title">Your expert profile</h1>
      {email && <p className="node-body mono">{email}</p>}

      {error && (
        <p className="node-error" role="alert">
          {error}
        </p>
      )}

      <Status node={node} eligible={eligible} reason={reason} />

      <section className="node-card">
        <h2 className="node-h2">Taking work</h2>
        <p className="node-note">
          {node.kycStatus === 'verified'
            ? 'Turn this off whenever you need to. Nothing already agreed is affected.'
            : 'You can turn this on once your identity is verified.'}
        </p>
        <div className="node-row">
          <button
            type="button"
            className="btn"
            disabled={node.kycStatus !== 'verified' || busy !== null}
            onClick={() =>
              void run('availability', async () => {
                const next = node.availability === 'available' ? 'paused' : 'available';
                const { node: updated } = await patchNode({ availability: next });
                return updated;
              })
            }
          >
            {busy === 'availability'
              ? 'Saving'
              : node.availability === 'available'
                ? 'Pause my availability'
                : 'Start taking work'}
          </button>
        </div>
      </section>

      <Places node={node} busy={busy} onRun={run} />
      <Rate node={node} busy={busy} onRun={run} />
      <Skills node={node} busy={busy} onRun={run} />
      <Credentials node={node} busy={busy} onRun={run} />

      <section className="node-card">
        <h2 className="node-h2">Identity</h2>
        <p className="node-note">
          Octopus records the verdicts of an identity check and never the documents behind them. The
          record of what was checked is not yours to read, which is deliberate: those records can
          name other people.
        </p>
        {node.kycStatus === 'verified' ? (
          <p className="node-body">Your identity is verified. Nothing further is needed.</p>
        ) : node.kycStatus === 'suspended' ? (
          <p className="node-body">Your account is suspended. Support has the details.</p>
        ) : (
          <a className="btn btn-primary node-cta" href="/node/verify">
            {node.kycStatus === 'rejected' ? 'Try the check again' : 'Verify my identity'}
          </a>
        )}
      </section>
    </main>
  );
}

function Status({
  node,
  eligible,
  reason,
}: {
  node: NodeProfile;
  eligible: boolean;
  reason: string | null;
}) {
  return (
    <section className="node-card">
      <h2 className="node-h2">Where you stand</h2>
      <ul className="node-status">
        <li>
          <span className={`node-dot node-dot-${node.kycStatus}`} aria-hidden="true" />
          <span className="node-status-label">Identity</span>
          <span className="node-status-value">{STATUS_COPY[node.kycStatus]}</span>
        </li>
        <li>
          <span className={`node-dot node-dot-${node.availability}`} aria-hidden="true" />
          <span className="node-status-label">Availability</span>
          <span className="node-status-value">{AVAILABILITY_COPY[node.availability]}</span>
        </li>
      </ul>
      {reason && <p className="node-note">{reason}</p>}
      {eligible && <p className="node-note">{NO_WORK_YET}</p>}
    </section>
  );
}

type Runner = (key: string, work: () => Promise<NodeProfile | void>) => Promise<void>;

function Places({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [draft, setDraft] = useState('');
  const [languages, setLanguages] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  return (
    <section className="node-card">
      <h2 className="node-h2">Where you work</h2>
      <p className="node-note">
        Codes rather than place names, so a task in Austin can find somebody licensed in Texas. US
        covers the whole country, US-TX covers the state, US-TX-AUSTIN covers the city.
      </p>
      <ul className="node-tags">
        {node.serviceJurisdictions.map((code) => (
          <li key={code} className="node-tag mono">
            {code}
            <button
              type="button"
              className="node-tag-x"
              aria-label={`Remove ${code}`}
              disabled={busy !== null || node.serviceJurisdictions.length === 1}
              onClick={() =>
                void onRun('places', async () => {
                  const { node: updated } = await patchNode({
                    serviceJurisdictions: node.serviceJurisdictions.filter((c) => c !== code),
                  });
                  return updated;
                })
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {node.serviceJurisdictions.length === 1 && (
        <p className="node-note">
          You need at least one. Add another before removing this one, or nobody could match you.
        </p>
      )}
      {local && <p className="node-error">{local}</p>}
      <div className="node-row">
        <label className="sr-only" htmlFor="node-jur">
          Add a jurisdiction code
        </label>
        <input
          id="node-jur"
          className="auth-input mono"
          value={draft}
          placeholder="US-TX"
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null || draft.length === 0}
          onClick={() => {
            if (!JURISDICTION.test(draft)) {
              setLocal('A code looks like US, US-TX or US-TX-AUSTIN, in capitals.');
              return;
            }
            setLocal(null);
            void onRun('places', async () => {
              const { node: updated } = await patchNode({
                serviceJurisdictions: [...new Set([...node.serviceJurisdictions, draft])],
              });
              setDraft('');
              return updated;
            });
          }}
        >
          Add
        </button>
      </div>

      <h3 className="node-h3">Languages</h3>
      <ul className="node-tags">
        {node.languages.map((lang) => (
          <li key={lang} className="node-tag mono">
            {lang}
          </li>
        ))}
      </ul>
      <div className="node-row">
        <label className="sr-only" htmlFor="node-lang">
          Add a language
        </label>
        <input
          id="node-lang"
          className="auth-input mono"
          value={languages}
          placeholder="en"
          onChange={(e) => setLanguages(e.target.value.toLowerCase())}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null || languages.length === 0}
          onClick={() =>
            void onRun('languages', async () => {
              const { node: updated } = await patchNode({
                languages: [...new Set([...node.languages, languages])],
              });
              setLanguages('');
              return updated;
            })
          }
        >
          Add
        </button>
      </div>
    </section>
  );
}

function Rate({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [amount, setAmount] = useState(node.rate === null ? '' : String(node.rate));
  const [period, setPeriod] = useState<'hour' | 'task'>(node.ratePeriod ?? 'hour');

  return (
    <section className="node-card">
      <h2 className="node-h2">What you charge</h2>
      <p className="node-note">
        Nothing is quoted on your behalf. A profile with no rate is not free, it is one the matcher
        cannot price, so it will not be offered work.
      </p>
      <div className="node-row">
        <label className="sr-only" htmlFor="node-rate">
          Rate
        </label>
        <input
          id="node-rate"
          className="auth-input mono tnum"
          inputMode="decimal"
          value={amount}
          placeholder="120.00"
          onChange={(e) => setAmount(e.target.value)}
        />
        <label className="sr-only" htmlFor="node-period">
          Per
        </label>
        <select
          id="node-period"
          className="auth-input"
          value={period}
          onChange={(e) => setPeriod(e.target.value as 'hour' | 'task')}
        >
          <option value="hour">per hour</option>
          <option value="task">per task</option>
        </select>
        <span className="node-currency mono">{node.currency}</span>
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() =>
            void onRun('rate', async () => {
              const parsed = amount.trim() === '' ? null : Number(amount);
              if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
                throw new Error('A rate is a number above zero, or blank for none.');
              }
              const { node: updated } = await patchNode({
                rate: parsed,
                ratePeriod: parsed === null ? null : period,
              });
              return updated;
            })
          }
        >
          {busy === 'rate' ? 'Saving' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function Skills({ node, busy, onRun }: { node: NodeProfile; busy: string | null; onRun: Runner }) {
  const [base, setBase] = useState(SKILL_TAXONOMY[0]!.tag);
  const [where, setWhere] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const entry = useMemo(() => SKILL_TAXONOMY.find((s) => s.tag === base)!, [base]);
  const claimed = new Set(node.skills.map((s) => s.tag));

  return (
    <section className="node-card">
      <h2 className="node-h2">What you do</h2>
      <p className="node-note">
        Chosen from a fixed list rather than typed, so that two people who do the same work are
        findable by the same search. Everything here is a claim: nothing is confirmed until you have
        finished work through Octopus.
      </p>

      {node.skills.length === 0 ? (
        <p className="node-body">Nothing claimed yet.</p>
      ) : (
        <ul className="node-list">
          {node.skills.map((skill) => (
            <li key={skill.tag} className="node-list-row">
              <span className="mono">{skill.tag}</span>
              <span className="node-muted">{skill.verified ? 'Confirmed' : 'Claimed'}</span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() =>
                  void onRun('skills', async () => {
                    await removeNodeSkill(skill.tag);
                    return {
                      ...node,
                      skills: node.skills.filter((s) => s.tag !== skill.tag),
                    };
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {local && <p className="node-error">{local}</p>}

      <div className="node-row">
        <label className="sr-only" htmlFor="node-skill">
          Skill
        </label>
        <select
          id="node-skill"
          className="auth-input"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        >
          {SKILL_TAXONOMY.map((s) => (
            <option key={s.tag} value={s.tag}>
              {s.label}
            </option>
          ))}
        </select>
        {entry.requiresJurisdiction && (
          <>
            <label className="sr-only" htmlFor="node-skill-where">
              Where
            </label>
            <input
              id="node-skill-where"
              className="auth-input mono"
              value={where}
              placeholder="US-TX"
              onChange={(e) => setWhere(e.target.value.toUpperCase())}
            />
          </>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            const tag = entry.requiresJurisdiction ? `${base}:${where}` : base;
            const why = skillRejectionReason(tag);
            if (why) {
              setLocal(why);
              return;
            }
            if (claimed.has(tag)) {
              setLocal('You have already claimed that.');
              return;
            }
            setLocal(null);
            void onRun('skills', async () => {
              const { skill } = await addNodeSkill(tag);
              setWhere('');
              return { ...node, skills: [...node.skills, skill] };
            });
          }}
        >
          Claim
        </button>
      </div>
      <p className="node-note">{entry.description}</p>
    </section>
  );
}

function Credentials({
  node,
  busy,
  onRun,
}: {
  node: NodeProfile;
  busy: string | null;
  onRun: Runner;
}) {
  const [kind, setKind] = useState<(typeof CREDENTIAL_KINDS)[number]>('notary');
  const [where, setWhere] = useState('');
  const [issuer, setIssuer] = useState('');
  const [number, setNumber] = useState('');
  const [local, setLocal] = useState<string | null>(null);

  const live = node.credentials.filter((c) => c.revokedAt === null);

  return (
    <section className="node-card">
      <h2 className="node-h2">Licences you hold</h2>
      <p className="node-note">
        Recorded as claims. Octopus does not check a licence register yet, so nothing here is
        confirmed and nothing here will be shown to a client as confirmed. There is nowhere to
        upload a document, on purpose: we do not want one until we can keep it properly.
      </p>

      {live.length === 0 ? (
        <p className="node-body">Nothing claimed yet.</p>
      ) : (
        <ul className="node-list">
          {live.map((credential: NodeCredential) => (
            <li key={credential.id} className="node-list-row">
              <span>
                <span className="mono">{credential.kind}</span> in{' '}
                <span className="mono">{credential.jurisdiction}</span>
                {credential.licenceNumber && (
                  <span className="node-muted mono"> · {credential.licenceNumber}</span>
                )}
              </span>
              <span className="node-muted">
                {credential.verified ? 'Confirmed' : 'Claimed, not verified'}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy !== null}
                onClick={() =>
                  void onRun('credentials', async () => {
                    const { credential: revoked } = await revokeNodeCredential(credential.id);
                    return {
                      ...node,
                      credentials: node.credentials.map((c) => (c.id === revoked.id ? revoked : c)),
                    };
                  })
                }
              >
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}

      {local && <p className="node-error">{local}</p>}

      <div className="node-row">
        <label className="sr-only" htmlFor="node-cred-kind">
          Kind
        </label>
        <select
          id="node-cred-kind"
          className="auth-input"
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof CREDENTIAL_KINDS)[number])}
        >
          {CREDENTIAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="node-cred-where">
          Jurisdiction
        </label>
        <input
          id="node-cred-where"
          className="auth-input mono"
          value={where}
          placeholder="US-TX"
          onChange={(e) => setWhere(e.target.value.toUpperCase())}
        />
        <label className="sr-only" htmlFor="node-cred-issuer">
          Issuer
        </label>
        <input
          id="node-cred-issuer"
          className="auth-input"
          value={issuer}
          placeholder="Issuer (optional)"
          onChange={(e) => setIssuer(e.target.value)}
        />
        <label className="sr-only" htmlFor="node-cred-number">
          Licence number
        </label>
        <input
          id="node-cred-number"
          className="auth-input mono"
          value={number}
          placeholder="Number (optional)"
          onChange={(e) => setNumber(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => {
            if (!JURISDICTION.test(where)) {
              setLocal('A jurisdiction looks like US or US-TX, in capitals.');
              return;
            }
            setLocal(null);
            void onRun('credentials', async () => {
              const { credential } = await addNodeCredential({
                kind,
                jurisdiction: where,
                ...(issuer.trim() ? { issuer: issuer.trim() } : {}),
                ...(number.trim() ? { licenceNumber: number.trim() } : {}),
              });
              setWhere('');
              setIssuer('');
              setNumber('');
              return node.credentials.some((c) => c.id === credential.id)
                ? node
                : { ...node, credentials: [...node.credentials, credential] };
            });
          }}
        >
          Claim
        </button>
      </div>
    </section>
  );
}
