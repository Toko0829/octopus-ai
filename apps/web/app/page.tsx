import Link from 'next/link';
import { FIRST_VERTICAL } from '@octopus/config';

/**
 * Landing — editorial / calm minimal (design-system.md). The real product surface
 * is the Discord-style chat at /app.
 */
export default function Home() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '10vh 8vw',
        maxWidth: '1000px',
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 12,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--accent-text)',
          marginBottom: 28,
        }}
      >
        ✦ Octopus
      </div>

      <h1
        className="display"
        style={{
          fontSize: 'clamp(2.6rem, 6.5vw, 4.5rem)',
          lineHeight: 1.02,
          fontWeight: 460,
          letterSpacing: '-0.02em',
          margin: 0,
          maxWidth: '15ch',
        }}
      >
        Octopus runs your business.{' '}
        <span style={{ color: 'var(--text-muted)' }}>You just decide.</span>
      </h1>

      <p
        style={{
          fontSize: 'clamp(1rem, 2.2vw, 1.25rem)',
          color: 'var(--text-secondary)',
          maxWidth: '58ch',
          marginTop: 28,
        }}
      >
        An AI that runs full-funnel digital marketing end-to-end for solo founders and creators —
        with expert humans dropped in only where judgment, taste, or access is required. It gets
        smarter with every campaign it runs.
      </p>

      <div
        style={{ display: 'flex', gap: 14, marginTop: 40, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Link
          href="/app"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--text)',
            color: 'var(--bg)',
            textDecoration: 'none',
            padding: '11px 20px',
            borderRadius: 'var(--r-full)',
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          Open the app →
        </Link>
        <span
          className="mono"
          style={{
            fontSize: 12,
            padding: '7px 13px',
            borderRadius: 'var(--r-full)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
          }}
        >
          Phase 1 · planner preview
        </span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          first vertical: {FIRST_VERTICAL}
        </span>
      </div>
    </main>
  );
}
