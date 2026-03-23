'use client';

import { useEffect, useRef } from 'react';
import type { Turn } from '@/hooks/useInterviewState';

interface Props {
  transcript: Turn[];
}

export default function TranscriptArea({ transcript }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever a new turn is added
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript.length]);

  if (transcript.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <p
          style={{
            color: 'var(--grey)',
            fontFamily: 'var(--font-primary)',
            fontSize: 14,
            fontStyle: 'italic',
          }}
        >
          Your conversation will appear here as you progress.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '24px 32px',
      }}
    >
      {transcript.map((turn, index) => {
        // De-emphasise all turns except the most recent
        const isPast = index < transcript.length - 1;

        return (
          <div
            key={index}
            style={{
              marginBottom: 28,
              opacity: isPast ? 0.55 : 1,
              transition: 'opacity 0.2s ease',
            }}
          >
            {/* Question */}
            <p
              style={{
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                color: 'var(--graphite)',
                fontSize: 14,
                marginBottom: 6,
                lineHeight: 1.5,
              }}
            >
              Q{index + 1}: {turn.questionText}
            </p>

            {/* Answer */}
            {turn.isSkipped ? (
              <p
                style={{
                  color: 'var(--grey)',
                  fontSize: 14,
                  fontStyle: 'italic',
                }}
              >
                [Skipped]
              </p>
            ) : turn.answerText !== null ? (
              <p
                style={{
                  fontFamily: 'var(--font-primary)',
                  fontWeight: 400,
                  color: 'var(--graphite)',
                  fontSize: 16,
                  lineHeight: 1.6,
                }}
              >
                {turn.answerText}
              </p>
            ) : null}
          </div>
        );
      })}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
