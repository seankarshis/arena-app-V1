'use client';

import { useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import type {
  InterviewState,
  InterviewSession,
  InterviewActions,
} from '@/hooks/useInterviewState';
import TranscriptArea from './TranscriptArea';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  state: InterviewState;
  session: InterviewSession;
  actions: InterviewActions;
}

// ---------------------------------------------------------------------------
// Shared loading overlay
// ---------------------------------------------------------------------------

function LoadingScreen({ message }: { message: string }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
      }}
    >
      <p style={{ color: 'var(--grey)', fontSize: 16 }}>{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InterviewUI({ state, session, actions }: Props) {
  const router = useRouter();
  const [inputText, setInputText] = useState('');

  // ---- Event handlers ----

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    await actions.submitText(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handlePause = async () => {
    if (
      window.confirm(
        'Pause your interview? You can resume within 72 hours from this page.'
      )
    ) {
      await actions.pauseInterview();
    }
  };

  const handleEnd = async () => {
    if (
      window.confirm(
        'End your interview now? Your answers so far will be saved.'
      )
    ) {
      await actions.endInterview();
    }
  };

  // =========================================================================
  // Full-screen overlay states
  // =========================================================================

  if (state === 'STARTING') {
    return <LoadingScreen message="Starting your interview…" />;
  }

  if (state === 'UPLOADING') {
    return <LoadingScreen message="Finishing up…" />;
  }

  if (state === 'RESUMING') {
    return <LoadingScreen message="Resuming your interview…" />;
  }

  if (state === 'COMPLETED') {
    const answered = session.transcript.filter((t) => !t.isSkipped).length;
    const skipped = session.transcript.filter((t) => t.isSkipped).length;
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
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 480 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              backgroundColor: 'var(--dark-maroon)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 24px',
            }}
          >
            <svg
              width="28"
              height="28"
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
          <h2
            style={{
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 24,
              color: 'var(--graphite)',
              marginBottom: 12,
            }}
          >
            Interview Complete
          </h2>
          <p
            style={{ color: 'var(--grey)', fontSize: 16, lineHeight: 1.6, marginBottom: 8 }}
          >
            You answered {answered} question{answered !== 1 ? 's' : ''}.
            {skipped > 0 && ` (${skipped} skipped)`}
          </p>
          <p
            style={{ color: 'var(--grey)', fontSize: 14, marginBottom: 40 }}
          >
            Your responses are being processed. Thank you for your time.
          </p>
          <button
            onClick={() => router.push('/')}
            style={{
              padding: '12px 32px',
              borderRadius: 999,
              border: 'none',
              backgroundColor: 'var(--horizon-red)',
              color: 'var(--white)',
              fontFamily: 'var(--font-primary)',
              fontWeight: 600,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  if (state === 'PAUSED' || state === 'AUTO_PAUSED') {
    const isAuto = state === 'AUTO_PAUSED';
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
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 480 }}>
          <h2
            style={{
              fontWeight: 600,
              fontSize: 22,
              color: 'var(--graphite)',
              marginBottom: 12,
            }}
          >
            Interview Paused
          </h2>
          <p
            style={{
              color: 'var(--grey)',
              fontSize: 16,
              lineHeight: 1.6,
              marginBottom: isAuto ? 8 : 40,
            }}
          >
            {isAuto
              ? 'Your interview was paused due to inactivity.'
              : 'Your progress has been saved.'}
          </p>
          {isAuto && (
            <p style={{ color: 'var(--grey)', fontSize: 14, marginBottom: 40 }}>
              Click Resume when you are ready to continue. You have 72 hours
              before this session expires.
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <button
              onClick={() => void actions.resumeInterview()}
              style={{
                padding: '12px 32px',
                borderRadius: 999,
                border: 'none',
                backgroundColor: 'var(--horizon-red)',
                color: 'var(--white)',
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              Resume Interview
            </button>
            <button
              onClick={() => router.push('/')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontSize: 14,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (state === 'ERROR') {
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
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 480 }}>
          <h2
            style={{
              fontWeight: 600,
              fontSize: 22,
              color: 'var(--horizon-red)',
              marginBottom: 12,
            }}
          >
            Something went wrong
          </h2>
          <p style={{ color: 'var(--grey)', fontSize: 15, marginBottom: 32 }}>
            {session.errorMessage ?? 'An unexpected error occurred.'}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '12px 32px',
                borderRadius: 999,
                border: 'none',
                backgroundColor: 'var(--horizon-red)',
                color: 'var(--white)',
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              Retry
            </button>
            <button
              onClick={() => router.push('/')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontSize: 14,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Back to Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // Main interview layout
  // States: LLM_STREAMING, AWAITING_INPUT, PROCESSING, SKIPPING, COMPLETING,
  //         IDLE_WARNING
  // =========================================================================

  const isInputEnabled =
    state === 'AWAITING_INPUT' ||
    state === 'IDLE_WARNING' ||
    state === 'COMPLETING';

  const isStreaming = state === 'LLM_STREAMING';
  const isThinking = state === 'PROCESSING' || state === 'SKIPPING';
  const isCompleting = state === 'COMPLETING';

  // What text to show in the current question panel
  const questionPanelText = isStreaming
    ? session.streamingText
    : session.currentQuestion;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        backgroundColor: 'var(--ivory)',
        fontFamily: 'var(--font-primary)',
      }}
    >
      {/* ---- Header ---- */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '12px 24px',
          borderBottom: '1px solid var(--ivory-tint)',
          backgroundColor: 'var(--white)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-hero)',
            fontSize: 18,
            color: 'var(--graphite)',
          }}
        >
          Arena
        </span>

        {/* Progress bar */}
        <div
          style={{
            flex: 1,
            height: 4,
            backgroundColor: 'var(--ivory-tint)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
          role="progressbar"
          aria-valuenow={session.progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            style={{
              height: '100%',
              width: `${session.progressPercent}%`,
              backgroundColor: 'var(--horizon-red)',
              borderRadius: 2,
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        {/* Header controls — only shown when user can interact */}
        {isInputEnabled && (
          <>
            <button
              onClick={() => void handlePause()}
              style={{
                background: 'none',
                border: '1px solid var(--ivory-tint)',
                borderRadius: 6,
                padding: '6px 14px',
                color: 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Pause
            </button>
            <button
              onClick={() => void handleEnd()}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              End Interview
            </button>
          </>
        )}
      </header>

      {/* ---- Idle warning banner ---- */}
      {state === 'IDLE_WARNING' && session.idlePrompt && (
        <div
          role="status"
          style={{
            padding: '10px 24px',
            backgroundColor: '#FEF3C7',
            borderBottom: '1px solid #FDE68A',
            flexShrink: 0,
          }}
        >
          <p style={{ color: '#92400E', fontSize: 14 }}>{session.idlePrompt}</p>
        </div>
      )}

      {/* ---- Current question panel ---- */}
      <div
        style={{
          backgroundColor: 'var(--dark-maroon)',
          padding: '28px 32px',
          flexShrink: 0,
          position: 'relative',
          minHeight: 100,
        }}
      >
        <p
          style={{
            color: 'var(--ivory)',
            fontFamily: 'var(--font-primary)',
            fontWeight: 400,
            fontSize: 18,
            lineHeight: 1.65,
            paddingRight: 72, // room for skip button
          }}
        >
          {questionPanelText || '\u00a0'}
          {isStreaming && questionPanelText && (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: '1.1em',
                backgroundColor: 'var(--ivory)',
                marginLeft: 2,
                verticalAlign: 'text-bottom',
                animation: 'arena-blink 1s step-end infinite',
              }}
            />
          )}
          {isThinking && (
            <span style={{ color: 'rgba(245,242,236,0.5)', marginLeft: 8 }}>
              ···
            </span>
          )}
        </p>

        {/* Skip button — available only when input is enabled and not completing */}
        {(state === 'AWAITING_INPUT' || state === 'IDLE_WARNING') && (
          <button
            onClick={() => void actions.skipQuestion()}
            style={{
              position: 'absolute',
              bottom: 16,
              right: 24,
              background: 'none',
              border: 'none',
              color: 'rgba(245,242,236,0.5)',
              fontFamily: 'var(--font-primary)',
              fontSize: 13,
              cursor: 'pointer',
              padding: '4px 8px',
            }}
          >
            Skip
          </button>
        )}
      </div>

      {/* ---- Transcript area ---- */}
      <TranscriptArea transcript={session.transcript} />

      {/* ---- Input area ---- */}
      <div
        style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--ivory-tint)',
          backgroundColor: 'var(--white)',
          flexShrink: 0,
        }}
      >
        {isCompleting ? (
          /* COMPLETING: closing message shown — offer to add something or finish */
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add a final thought (optional)…"
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  borderRadius: 8,
                  border: '1px solid var(--ivory-tint)',
                  backgroundColor: 'var(--ivory-tint)',
                  fontFamily: 'var(--font-primary)',
                  fontSize: 16,
                  color: 'var(--graphite)',
                  outline: 'none',
                }}
              />
              {inputText.trim() && (
                <button
                  onClick={() => void handleSend()}
                  style={{
                    padding: '12px 20px',
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
                  Send
                </button>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <button
                onClick={() => void actions.endInterview()}
                style={{
                  padding: '12px 32px',
                  borderRadius: 999,
                  border: 'none',
                  backgroundColor: 'var(--horizon-red)',
                  color: 'var(--white)',
                  fontFamily: 'var(--font-primary)',
                  fontWeight: 600,
                  fontSize: 15,
                  cursor: 'pointer',
                }}
              >
                Finish Interview
              </button>
            </div>
          </div>
        ) : (
          /* Normal input row */
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!isInputEnabled}
              placeholder={
                isInputEnabled ? 'Type your response…' : 'Waiting…'
              }
              style={{
                flex: 1,
                padding: '12px 16px',
                borderRadius: 8,
                border: '1px solid var(--ivory-tint)',
                backgroundColor: isInputEnabled
                  ? 'var(--ivory-tint)'
                  : 'var(--ivory)',
                fontFamily: 'var(--font-primary)',
                fontSize: 16,
                color: 'var(--graphite)',
                outline: 'none',
                cursor: isInputEnabled ? 'text' : 'not-allowed',
                opacity: isInputEnabled ? 1 : 0.6,
              }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!isInputEnabled || !inputText.trim()}
              style={{
                padding: '12px 24px',
                borderRadius: 999,
                border: 'none',
                backgroundColor:
                  isInputEnabled && inputText.trim()
                    ? 'var(--horizon-red)'
                    : 'var(--ivory-tint)',
                color:
                  isInputEnabled && inputText.trim()
                    ? 'var(--white)'
                    : 'var(--grey)',
                fontFamily: 'var(--font-primary)',
                fontWeight: 600,
                fontSize: 14,
                cursor:
                  isInputEnabled && inputText.trim()
                    ? 'pointer'
                    : 'not-allowed',
                transition: 'background-color 0.15s ease',
              }}
            >
              Send
            </button>
          </div>
        )}
      </div>

      {/* Blinking cursor keyframes */}
      <style>{`
        @keyframes arena-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
