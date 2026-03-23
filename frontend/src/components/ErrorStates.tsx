'use client';

// ---------------------------------------------------------------------------
// NetworkOfflineBanner — shown when navigator.onLine is false
// ---------------------------------------------------------------------------

export function NetworkOfflineBanner() {
  return (
    <div
      role="alert"
      style={{
        padding: '12px 24px',
        backgroundColor: '#FEF2F2',
        borderBottom: '1px solid #FECACA',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: '#DC2626',
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: 14, color: '#991B1B' }}>
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
      style={{
        padding: '8px 24px',
        backgroundColor: '#FFFBEB',
        borderBottom: '1px solid #FDE68A',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: '#F59E0B',
          animation: 'arena-reconnect-pulse 1.5s ease-in-out infinite',
        }}
      />
      <span style={{ fontSize: 13, color: '#92400E' }}>Reconnecting…</span>
      <style>{`
        @keyframes arena-reconnect-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
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
        style={{
          padding: '20px 24px',
          backgroundColor: '#FEF2F2',
          borderBottom: '1px solid #FECACA',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        <p
          style={{
            fontSize: 15,
            color: '#991B1B',
            fontWeight: 500,
            marginBottom: 8,
          }}
        >
          We&apos;re experiencing technical difficulties.
        </p>
        <p style={{ fontSize: 14, color: '#B91C1C', marginBottom: 16 }}>
          Your interview has been saved — you can resume later.
        </p>
        {onResume && (
          <button
            onClick={onResume}
            style={{
              padding: '10px 24px',
              borderRadius: 999,
              border: 'none',
              backgroundColor: 'var(--horizon-red)',
              color: 'var(--white)',
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Resume Later
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="alert"
      style={{
        padding: '16px 24px',
        backgroundColor: '#FEF2F2',
        borderBottom: '1px solid #FECACA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexShrink: 0,
      }}
    >
      <div>
        <p style={{ fontSize: 14, color: '#991B1B', marginBottom: 4 }}>
          {errorMessage}
        </p>
        <p style={{ fontSize: 12, color: '#B91C1C' }}>
          Attempt {retryCount} of {maxRetries}
        </p>
      </div>
      <button
        onClick={onRetry}
        style={{
          padding: '8px 20px',
          borderRadius: 999,
          border: 'none',
          backgroundColor: 'var(--horizon-red)',
          color: 'var(--white)',
          fontFamily: 'var(--font-primary)',
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
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
    <div
      role="alert"
      style={{
        padding: '8px 16px',
        backgroundColor: '#FFFBEB',
        borderRadius: 6,
        border: '1px solid #FDE68A',
        marginBottom: 8,
      }}
    >
      <p style={{ fontSize: 13, color: '#92400E' }}>
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
      style={{
        padding: '12px 24px',
        backgroundColor: '#FEF2F2',
        borderBottom: '1px solid #FECACA',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexShrink: 0,
      }}
    >
      <p style={{ fontSize: 14, color: '#991B1B' }}>{errorMessage}</p>
      <button
        onClick={onRetry}
        style={{
          padding: '6px 16px',
          borderRadius: 999,
          border: '1px solid #991B1B',
          backgroundColor: 'transparent',
          color: '#991B1B',
          fontFamily: 'var(--font-primary)',
          fontWeight: 500,
          fontSize: 13,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Retry Microphone
      </button>
    </div>
  );
}
