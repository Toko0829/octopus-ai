'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '../../lib/supabase/client';
import './sign-in.css';

/**
 * Sign-in / sign-up. Supabase GoTrue is the sole IdP
 * (docs/30-modules/auth-identity.md); the session lands in httpOnly cookies via
 * @supabase/ssr, and middleware redirects here for any /app route without one.
 *
 * Copy convention: no em dashes in user-facing text (AGENTS.md rule 22).
 */
type Mode = 'signin' | 'signup';
type Msg = { tone: 'error' | 'ok'; text: string } | null;

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/app';

  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const supabase = createClient();

    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setMsg({ tone: 'error', text: error.message });
          return;
        }
        router.push(next);
        router.refresh();
        return;
      }

      // handle_new_user() copies display_name out of this metadata into the
      // profile row, and the member list reads it from there.
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName.trim() } },
      });
      if (error) {
        setMsg({ tone: 'error', text: error.message });
        return;
      }
      // No session back means the project requires email confirmation. Say so
      // rather than dumping the person on a workspace they cannot load.
      if (!data.session) {
        setMsg({
          tone: 'ok',
          text: 'Check your email to confirm the account, then sign in.',
        });
        setMode('signin');
        return;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setMsg({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Something went wrong. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="auth-mark">Octopus</div>
        <h1 className="auth-title">
          {mode === 'signin' ? 'Sign in to your workspace' : 'Create your workspace'}
        </h1>
        <p className="auth-sub">
          {mode === 'signin'
            ? 'Your projects, your agent, and the people working on them.'
            : 'One account runs every business you start here.'}
        </p>

        <form onSubmit={onSubmit}>
          {mode === 'signup' && (
            <label className="auth-field">
              <span className="auth-label">Your name</span>
              <input
                className="auth-input"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
              />
            </label>
          )}

          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              className="auth-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>

          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={8}
              required
            />
          </label>

          <button className="auth-submit" type="submit" disabled={busy}>
            {busy ? 'Working...' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        {msg && (
          <div className="auth-msg" data-tone={msg.tone} role="status">
            {msg.tone === 'error' ? 'Problem: ' : ''}
            {msg.text}
          </div>
        )}

        <div className="auth-toggle">
          {mode === 'signin' ? (
            <>
              No account yet?{' '}
              <button type="button" onClick={() => (setMode('signup'), setMsg(null))}>
                Create one
              </button>
            </>
          ) : (
            <>
              Already have one?{' '}
              <button type="button" onClick={() => (setMode('signin'), setMsg(null))}>
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * `useSearchParams` (we read `?next=`) opts a route out of prerendering unless it
 * sits behind a Suspense boundary. Without this the production build fails on
 * /sign-in, which `next dev` never reveals because dev does not prerender.
 */
export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-wrap">
          <div className="auth-card">
            <div className="auth-mark">Octopus</div>
          </div>
        </main>
      }
    >
      <SignInForm />
    </Suspense>
  );
}
