'use client';

import type { InterviewSession } from '@/hooks/useInterviewState';

interface Props {
  session: InterviewSession;
  onGoHome: () => void;
}

// ---------------------------------------------------------------------------
// Stat card sub-component
// ---------------------------------------------------------------------------

function StatItem({ value, label }: { value: number | string; label: string }) {
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div
        style={{
          fontFamily: 'var(--font-primary)',
          fontWeight: 700,
          fontSize: 36,
          color: 'var(--graphite)',
          lineHeight: 1,
          marginBottom: 6,
          letterSpacing: '-0.02em',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-primary)',
          fontWeight: 400,
          fontSize: 12,
          color: 'var(--grey)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CompletionSummary({ session, onGoHome }: Props) {
  const answered = session.transcript.filter((t) => !t.isSkipped).length;
  const skipped = session.transcript.filter((t) => t.isSkipped).length;
  const total = session.transcript.length;
  const completionPct = total > 0 ? Math.round((answered / total) * 100) : 0;

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
        padding: '24px',
      }}
    >
      <div style={{ maxWidth: 520, width: '100%' }}>
        {/* Check icon */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            backgroundColor: 'var(--dark-maroon)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 32px',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--ivory)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        <h1
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 600,
            fontSize: 28,
            color: 'var(--graphite)',
            textAlign: 'center',
            marginBottom: 10,
            letterSpacing: '-0.01em',
          }}
        >
          Interview Complete
        </h1>

        <p
          style={{
            fontFamily: 'var(--font-primary)',
            fontWeight: 400,
            fontSize: 16,
            color: 'var(--grey)',
            textAlign: 'center',
            lineHeight: 1.6,
            marginBottom: 40,
          }}
        >
          Thank you for your time. Your responses are being reviewed.
        </p>

        {/* Stats card */}
        {total > 0 && (
          <div
            style={{
              backgroundColor: 'var(--white)',
              border: '1px solid var(--ivory-tint)',
              borderRadius: 12,
              padding: '28px 32px',
              marginBottom: 12,
            }}
          >
            <p
              style={{
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                fontSize: 11,
                color: 'var(--grey)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginBottom: 24,
              }}
            >
              Session Summary
            </p>

            <div
              style={{
                display: 'flex',
                gap: 0,
                alignItems: 'stretch',
              }}
            >
              <StatItem value={answered} label="Answered" />

              {skipped > 0 && (
                <>
                  <div
                    style={{
                      width: 1,
                      backgroundColor: 'var(--ivory-tint)',
                      margin: '4px 16px',
                      flexShrink: 0,
                    }}
                  />
                  <StatItem value={skipped} label="Skipped" />
                </>
              )}

              <div
                style={{
                  width: 1,
                  backgroundColor: 'var(--ivory-tint)',
                  margin: '4px 16px',
                  flexShrink: 0,
                }}
              />
              <StatItem value={total} label="Total" />

              <div
                style={{
                  width: 1,
                  backgroundColor: 'var(--ivory-tint)',
                  margin: '4px 16px',
                  flexShrink: 0,
                }}
              />
              <StatItem value={`${completionPct}%`} label="Completion" />
            </div>
          </div>
        )}

        <p
          style={{
            fontFamily: 'var(--font-primary)',
            fontSize: 13,
            color: 'var(--grey)',
            textAlign: 'center',
            marginBottom: 36,
            lineHeight: 1.55,
          }}
        >
          A member of the Elastic Horizon team will be in touch with next steps.
        </p>

        <div style={{ textAlign: 'center' }}>
          <button
            onClick={onGoHome}
            style={{
              padding: '14px 44px',
              borderRadius: 999,
              border: 'none',
              backgroundColor: 'var(--horizon-red)',
              color: 'var(--white)',
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 15,
              cursor: 'pointer',
              letterSpacing: '0.01em',
            }}
          >
            Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
