import { FIRST_VERTICAL } from '@octopus/config';

/**
 * Phase 0 placeholder landing — editorial / calm minimal (design-system.md).
 * The real product surface is the Discord-style chat, built in Phase 1.
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
        maxWidth: '980px',
      }}
    >
      <div
        className="mono"
        style={{
          fontSize: 12,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-accent)',
          marginBottom: 28,
        }}
      >
        Octopus
      </div>

      <h1
        style={{
          fontSize: 'clamp(2.4rem, 6vw, 4.2rem)',
          lineHeight: 1.05,
          fontWeight: 500,
          letterSpacing: '-0.02em',
          margin: 0,
          maxWidth: '16ch',
        }}
      >
        Octopus runs your business.{' '}
        <span style={{ color: 'var(--color-text-muted)' }}>You just decide.</span>
      </h1>

      <p
        style={{
          fontSize: 'clamp(1rem, 2.2vw, 1.25rem)',
          color: 'var(--color-text-muted)',
          maxWidth: 'var(--measure)',
          marginTop: 28,
        }}
      >
        An AI that runs full-funnel digital marketing end-to-end for solo founders and creators —
        with expert humans dropped in only where judgment, taste, or access is required. It gets
        smarter with every campaign it runs.
      </p>

      <div style={{ display: 'flex', gap: 12, marginTop: 40, alignItems: 'center' }}>
        <span
          className="mono"
          style={{
            fontSize: 12,
            padding: '6px 12px',
            borderRadius: 'var(--radius-full)',
            border: '1px solid var(--color-border)',
            color: 'var(--color-text-muted)',
          }}
        >
          Phase 0 · scaffold
        </span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          first vertical: {FIRST_VERTICAL}
        </span>
      </div>
    </main>
  );
}
