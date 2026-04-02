'use client';

// ---------------------------------------------------------------------------
// NetworkOfflineBanner — shown when navigator.onLine is false
// ---------------------------------------------------------------------------

export function NetworkOfflineBanner() {
  return (
    <div
      role="alert"
      className="py-3 px-6 bg-horizon-red/5 border-b border-horizon-red/30 flex items-center gap-2 shrink-0"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-horizon-red shrink-0" />
      <span className="text-sm text-horizon-red">
        You appear to be offline. Your interview will resume when your connection
        returns.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReconnectingBanner — shown when SSE is attempting to reconnect
// ---------------------------------------------------------------------------

export function ReconnectingBanner() {
  return (
    <div
      role="status"
      className="py-2 px-6 bg-ivory-tint border-b border-grey/30 flex items-center gap-2 shrink-0"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-grey animate-arena-reconnect-pulse" />
      <span className="text-[13px] text-graphite">Reconnecting…</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LLMRetryPanel — retryable LLM error with retry button + counter,
// or auto-paused message after 3 failures
// ---------------------------------------------------------------------------

interface LLMRetryPanelProps {
  errorMessage: string;
  retryCount: number;
  maxRetries?: number;
  onRetry: () => void;
  autoPaused: boolean;
  onResume?: () => void;
}

export function LLMRetryPanel({
  errorMessage,
  retryCount,
  maxRetries = 3,
  onRetry,
  autoPaused,
  onResume,
}: LLMRetryPanelProps) {
  if (autoPaused) {
    return (
      <div
        role="alert"
        className="py-5 px-6 bg-horizon-red/5 border-b border-horizon-red/30 text-center shrink-0"
      >
        <p className="text-[15px] text-horizon-red font-medium mb-2">
          We&apos;re experiencing technical difficulties.
        </p>
        <p className="text-sm text-horizon-red mb-4">
          Your interview has been saved — you can resume later.
        </p>
        {onResume && (
          <button onClick={onResume} className="btn-primary">
            Resume Later
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="py-4 px-6 bg-horizon-red/5 border-b border-horizon-red/30 flex items-center justify-between gap-3 shrink-0"
    >
      <div>
        <p className="text-sm text-horizon-red mb-1">{errorMessage}</p>
        <p className="text-xs text-horizon-red">
          Attempt {retryCount} of {maxRetries}
        </p>
      </div>
      <button onClick={onRetry} className="btn-primary shrink-0 py-2 px-5 text-[13px]">
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// STTPartialWarning — shown in REVIEW when STT dropped mid-recording
// ---------------------------------------------------------------------------

export function STTPartialWarning() {
  return (
    <div role="alert" className="alert-warning mb-2">
      <p className="text-[13px] text-graphite">
        Connection interrupted — your response may be incomplete. You can redo to
        try again.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MediaErrorBanner — microphone error with retry button
// ---------------------------------------------------------------------------

interface MediaErrorBannerProps {
  errorMessage: string;
  onRetry: () => void;
}

export function MediaErrorBanner({ errorMessage, onRetry }: MediaErrorBannerProps) {
  return (
    <div
      role="alert"
      className="py-3 px-6 bg-horizon-red/5 border-b border-horizon-red/30 flex items-center justify-between gap-3 shrink-0"
    >
      <p className="text-sm text-horizon-red">{errorMessage}</p>
      <button
        onClick={onRetry}
        className="btn-secondary shrink-0 py-1.5 px-4 text-[13px] border-horizon-red text-horizon-red
                   hover:bg-horizon-red/5"
      >
        Retry Microphone
      </button>
    </div>
  );
}
