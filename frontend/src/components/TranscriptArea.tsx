'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Turn } from '@/hooks/useInterviewState';

interface Props {
  transcript: Turn[];
}

// Distance from bottom (px) within which the user is considered "at bottom"
const SCROLL_THRESHOLD = 80;

export default function TranscriptArea({ transcript }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // Tracks whether the user has manually scrolled up; prevents auto-scroll
  // from hijacking their reading position when new content arrives.
  const userScrolledUpRef = useRef(false);

  const isNearBottom = (): boolean => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
  };

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    userScrolledUpRef.current = false;
    setShowScrollBtn(false);
  }, []);

  const handleScroll = useCallback(() => {
    const atBottom = isNearBottom();
    if (atBottom) {
      userScrolledUpRef.current = false;
      setShowScrollBtn(false);
    } else {
      userScrolledUpRef.current = true;
      setShowScrollBtn(true);
    }
  }, []);

  // When a new turn is appended: auto-scroll only if user was already at bottom
  useEffect(() => {
    if (userScrolledUpRef.current) {
      // User is scrolled up — surface the button instead of forcing scroll
      setShowScrollBtn(true);
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
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
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          height: '100%',
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

      {/* Scroll-to-bottom button — visible when user has scrolled up */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          style={{
            position: 'absolute',
            bottom: 16,
            right: 20,
            width: 36,
            height: 36,
            borderRadius: '50%',
            border: '1px solid var(--ivory-tint)',
            backgroundColor: 'var(--white)',
            color: 'var(--graphite)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ↓
        </button>
      )}
    </div>
  );
}
