'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { renderInterviewerText } from '@/lib/formatLlmText';
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

  useEffect(() => {
    if (userScrolledUpRef.current) {
      setShowScrollBtn(true);
    } else {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript.length]);

  if (transcript.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-8 flex items-center justify-center">
        <p className="text-grey text-sm italic">
          Your conversation will appear here as you progress.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 relative overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto py-6 px-8"
      >
        {transcript.map((turn, index) => {
          const isPast = index < transcript.length - 1;

          return (
            <div
              key={index}
              className={cn('mb-7 transition-opacity duration-200', isPast && 'opacity-55')}
            >
              {/* Question */}
              <p className="font-semibold text-graphite text-sm mb-1.5 leading-normal">
                Q{index + 1}: {renderInterviewerText(turn.questionText)}
              </p>

              {/* Answer */}
              {turn.isSkipped ? (
                <p className="text-grey text-sm italic">[Skipped]</p>
              ) : turn.answerText !== null ? (
                <p className="text-graphite text-base leading-relaxed">
                  {turn.answerText}
                </p>
              ) : null}
            </div>
          );
        })}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom button */}
      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          className="absolute bottom-4 right-5 w-9 h-9 rounded-full border border-ivory-tint
                     bg-white text-graphite cursor-pointer flex items-center justify-center
                     text-base leading-none hover:border-graphite transition-colors duration-150"
        >
          ↓
        </button>
      )}
    </div>
  );
}
