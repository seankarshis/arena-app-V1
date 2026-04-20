'use client';

import { cn } from '@/lib/utils';

interface ThinkingIndicatorProps {
  className?: string;
}

export function ThinkingIndicator({ className }: ThinkingIndicatorProps) {
  return (
    <span
      role="status"
      aria-label="Interviewer is thinking"
      className={cn('inline-flex items-center gap-1.5 align-middle', className)}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-ivory/60 animate-arena-thinking-dot"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}
