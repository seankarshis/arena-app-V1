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
    <div className="flex-1 text-center">
      <div className="font-bold text-4xl text-graphite leading-none mb-1.5 tracking-[-0.02em]">
        {value}
      </div>
      <div className="text-xs text-grey uppercase tracking-[0.06em]">
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
  const total = session.totalQuestions || session.transcript.length;
  const completionPct = total > 0 ? Math.round((answered / total) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-ivory p-6">
      <div className="max-w-[520px] w-full">
        {/* Check icon */}
        <div className="w-[72px] h-[72px] rounded-full bg-dark-maroon flex items-center justify-center mx-auto mb-8">
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

        <h1 className="font-semibold text-[28px] text-graphite text-center mb-2.5 tracking-[-0.01em]">
          Interview Complete
        </h1>

        <p className="text-base text-grey text-center leading-relaxed mb-10">
          Thank you for your time. Your responses are being reviewed.
        </p>

        {/* Stats card */}
        {total > 0 && (
          <div className="card p-7 px-8 mb-3">
            <p className="font-semibold text-2xs text-grey uppercase tracking-[0.08em] mb-6">
              Session Summary
            </p>

            <div className="flex items-stretch">
              <StatItem value={answered} label="Answered" />

              {skipped > 0 && (
                <>
                  <div className="w-px bg-ivory-tint my-1 mx-4 shrink-0" />
                  <StatItem value={skipped} label="Skipped" />
                </>
              )}

              <div className="w-px bg-ivory-tint my-1 mx-4 shrink-0" />
              <StatItem value={total} label="Total" />

              <div className="w-px bg-ivory-tint my-1 mx-4 shrink-0" />
              <StatItem value={`${completionPct}%`} label="Completion" />
            </div>
          </div>
        )}

        <p className="text-[13px] text-grey text-center mb-9 leading-relaxed">
          A member of the Elastic Horizon team will be in touch with next steps.
        </p>

        <div className="text-center">
          <button onClick={onGoHome} className="btn-copper py-3.5 px-11 text-[15px]">
            Back to Home
          </button>
        </div>
      </div>
    </div>
  );
}
