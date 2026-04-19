'use client';

import { useState } from 'react';
import { cn, formatQuestionRef } from '@/lib/utils';

interface QuestionRefBadgeProps {
  displayNumber: number;
  className?: string;
}

export function QuestionRefBadge({ displayNumber, className }: QuestionRefBadgeProps) {
  const [copied, setCopied] = useState(false);
  const ref = formatQuestionRef(displayNumber);

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(ref);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — noop */
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? 'Copied!' : `Copy reference ${ref}`}
      className={cn(
        'font-mono text-[10.5px] tracking-wide text-grey bg-ivory-tint/60 hover:bg-ivory-tint border border-ivory-tint hover:text-graphite rounded px-1.5 py-[1px] leading-none cursor-pointer select-none transition-colors duration-100 shrink-0',
        copied && 'bg-horizon-red/10 text-horizon-red border-horizon-red/30',
        className,
      )}
    >
      {copied ? 'Copied!' : ref}
    </button>
  );
}
