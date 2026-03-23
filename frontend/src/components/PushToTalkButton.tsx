'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import type {
  InterviewState,
  InterviewSession,
  InterviewActions,
} from '@/hooks/useInterviewState';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface Props {
  state: InterviewState;
  session: InterviewSession;
  actions: InterviewActions;
}

// ---------------------------------------------------------------------------
// States where the PTT button is shown
// ---------------------------------------------------------------------------

const PTT_VISIBLE_STATES: ReadonlySet<InterviewState> = new Set([
  'AWAITING_INPUT',
  'IDLE_WARNING',
  'RECORDING',
  'REVIEW',
  'REDO',
  'MEDIA_ERROR',
]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PushToTalkButton({ state, session, actions }: Props) {
  const [localTranscript, setLocalTranscript] = useState('');

  // Track whether we've already synced the finalTranscript into the local field
  // for this REVIEW/REDO session so user edits are not overwritten.
  const transcriptSyncedRef = useRef(false);

  // Sync finalTranscript to local field when it first arrives or when state
  // transitions into REVIEW/REDO.
  useEffect(() => {
    if (state !== 'REVIEW' && state !== 'REDO') {
      transcriptSyncedRef.current = false;
      return;
    }
    if (!transcriptSyncedRef.current && session.finalTranscript !== null) {
      setLocalTranscript(session.finalTranscript);
      transcriptSyncedRef.current = true;
    }
  }, [state, session.finalTranscript]);

  // Reset local transcript when entering a fresh REDO (ptt.reset clears finalTranscript)
  useEffect(() => {
    if (state === 'REDO' && session.finalTranscript === null) {
      setLocalTranscript('');
      transcriptSyncedRef.current = false;
    }
  }, [state, session.finalTranscript]);

  // ---- PTT button event handlers ----

  const handlePTTMouseDown = () => {
    void actions.pressPTT();
  };

  const handlePTTMouseUp = () => {
    if (state === 'RECORDING') actions.releasePTT();
  };

  const handlePTTMouseLeave = () => {
    // Safety release: if the user drags off the button while holding
    if (state === 'RECORDING') actions.releasePTT();
  };

  const handlePTTTouchStart = (e: React.TouchEvent) => {
    e.preventDefault(); // prevent ghost mouse events
    void actions.pressPTT();
  };

  const handlePTTTouchEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    if (state === 'RECORDING') actions.releasePTT();
  };

  // ---- REVIEW/REDO transcript field handlers ----

  const handleTranscriptChange = (value: string) => {
    setLocalTranscript(value);
    actions.updateFinalTranscript(value);
  };

  const handleTranscriptFocus = () => {
    actions.onTranscriptFocus();
  };

  const handleTranscriptBlur = () => {
    actions.updateFinalTranscript(localTranscript);
    actions.onTranscriptBlur();
  };

  const handleTranscriptKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && state === 'REDO') {
      e.preventDefault();
      const isEmpty = localTranscript.trim() === '';
      if (!isEmpty) {
        const wasPreviouslyVoice = session.finalTranscript !== null;
        actions.submitEditedTranscript(localTranscript, !wasPreviouslyVoice);
      }
    }
  };

  // ---- Don't render in non-voice states ----
  if (!PTT_VISIBLE_STATES.has(state)) return null;

  // =========================================================================
  // MEDIA_ERROR state (or microphoneError set in any voice state)
  // =========================================================================

  if (state === 'MEDIA_ERROR' || session.microphoneError) {
    return (
      <div style={styles.container}>
        <p style={styles.errorText}>{session.microphoneError}</p>
        <button
          onClick={() => void actions.retryMicrophone()}
          style={styles.retryButton}
        >
          Retry Microphone
        </button>
      </div>
    );
  }

  // =========================================================================
  // REVIEW state
  // =========================================================================

  if (state === 'REVIEW') {
    const hasTranscript = session.finalTranscript !== null;
    return (
      <div style={styles.container}>
        <textarea
          value={localTranscript}
          onChange={(e) => handleTranscriptChange(e.target.value)}
          onFocus={handleTranscriptFocus}
          onBlur={handleTranscriptBlur}
          onKeyDown={handleTranscriptKeyDown}
          placeholder={hasTranscript ? undefined : 'Transcribing…'}
          rows={3}
          style={styles.transcriptArea}
        />

        {/* Auto-send indicator */}
        {hasTranscript && (
          <p style={styles.autoSendHint}>Sending in a moment…</p>
        )}

        <div style={styles.reviewRow}>
          {/* Redo button */}
          <button
            onClick={() => void actions.redo()}
            style={styles.redoButton}
          >
            Redo
          </button>

          {/* Manual send */}
          <button
            onClick={() => void actions.submitVoice()}
            disabled={!hasTranscript && localTranscript.trim() === ''}
            style={{
              ...styles.sendButton,
              opacity: hasTranscript || localTranscript.trim() ? 1 : 0.4,
              cursor: hasTranscript || localTranscript.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Send
          </button>

          {/* PTT re-record button */}
          <button
            onMouseDown={handlePTTMouseDown}
            onMouseUp={handlePTTMouseUp}
            onMouseLeave={handlePTTMouseLeave}
            onTouchStart={handlePTTTouchStart}
            onTouchEnd={handlePTTTouchEnd}
            style={styles.pttButtonSmall}
            aria-label="Re-record answer"
          >
            ● Re-record
          </button>
        </div>
      </div>
    );
  }

  // =========================================================================
  // RECORDING state
  // =========================================================================

  if (state === 'RECORDING') {
    return (
      <div style={styles.container}>
        {/* Live partial transcript */}
        {session.partialTranscript && (
          <p style={styles.partialTranscript}>{session.partialTranscript}</p>
        )}

        {/* Warning at 4-minute mark */}
        {session.nearingTimeLimit && (
          <p style={styles.timeLimitWarning}>1 minute remaining</p>
        )}

        {/* Recording button — release to stop */}
        <button
          onMouseUp={handlePTTMouseUp}
          onMouseLeave={handlePTTMouseLeave}
          onTouchEnd={handlePTTTouchEnd}
          style={styles.pttButtonRecording}
          aria-label="Release to stop recording"
          aria-pressed
        >
          <span style={styles.recordingDot} />
          Recording… release to stop
        </button>
      </div>
    );
  }

  // =========================================================================
  // REDO state
  // =========================================================================

  if (state === 'REDO') {
    const canSendText = localTranscript.trim().length > 0;
    return (
      <div style={styles.container}>
        <textarea
          value={localTranscript}
          onChange={(e) => handleTranscriptChange(e.target.value)}
          onFocus={handleTranscriptFocus}
          onBlur={handleTranscriptBlur}
          onKeyDown={handleTranscriptKeyDown}
          placeholder="Edit your response, or hold the button below to re-record…"
          rows={3}
          style={styles.transcriptArea}
        />

        <div style={styles.redoRow}>
          {/* PTT button */}
          <button
            onMouseDown={handlePTTMouseDown}
            onMouseUp={handlePTTMouseUp}
            onMouseLeave={handlePTTMouseLeave}
            onTouchStart={handlePTTTouchStart}
            onTouchEnd={handlePTTTouchEnd}
            style={styles.pttButton}
            aria-label="Hold to speak"
          >
            ● Hold to Speak
          </button>

          {/* Send edited text */}
          {canSendText && (
            <button
              onClick={() => {
                const wasPreviouslyVoice = session.finalTranscript !== null;
                actions.submitEditedTranscript(localTranscript, !wasPreviouslyVoice);
              }}
              style={styles.sendButton}
            >
              Send
            </button>
          )}
        </div>
      </div>
    );
  }

  // =========================================================================
  // AWAITING_INPUT / IDLE_WARNING — default PTT button
  // =========================================================================

  return (
    <div style={styles.container}>
      <button
        onMouseDown={handlePTTMouseDown}
        onMouseUp={handlePTTMouseUp}
        onMouseLeave={handlePTTMouseLeave}
        onTouchStart={handlePTTTouchStart}
        onTouchEnd={handlePTTTouchEnd}
        disabled={!!session.microphoneError}
        style={{
          ...styles.pttButton,
          opacity: session.microphoneError ? 0.4 : 1,
          cursor: session.microphoneError ? 'not-allowed' : 'pointer',
        }}
        aria-label="Hold to speak"
      >
        ● Hold to Speak
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 8,
    alignItems: 'stretch',
  },

  // Pill PTT button (idle)
  pttButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '14px 32px',
    borderRadius: 999,
    border: 'none',
    backgroundColor: 'var(--horizon-red)',
    color: 'var(--white)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 600,
    fontSize: 15,
    cursor: 'pointer',
    userSelect: 'none' as const,
    WebkitUserSelect: 'none' as const,
    touchAction: 'none' as const,
    transition: 'opacity 0.15s',
    letterSpacing: '0.01em',
  },

  // Small PTT button used in REVIEW row
  pttButtonSmall: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '10px 20px',
    borderRadius: 999,
    border: '1px solid var(--horizon-red)',
    backgroundColor: 'transparent',
    color: 'var(--horizon-red)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    userSelect: 'none' as const,
    WebkitUserSelect: 'none' as const,
    touchAction: 'none' as const,
  },

  // PTT button during active recording
  pttButtonRecording: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: '14px 32px',
    borderRadius: 999,
    border: 'none',
    backgroundColor: 'var(--horizon-red)',
    color: 'var(--white)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 600,
    fontSize: 15,
    cursor: 'pointer',
    userSelect: 'none' as const,
    WebkitUserSelect: 'none' as const,
    touchAction: 'none' as const,
    animation: 'arena-ptt-pulse 1.5s ease-in-out infinite',
  },

  recordingDot: {
    display: 'inline-block',
    width: 10,
    height: 10,
    borderRadius: '50%',
    backgroundColor: 'var(--white)',
    flexShrink: 0,
  },

  // Transcript textarea (REVIEW / REDO)
  transcriptArea: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 8,
    border: '1px solid var(--ivory-tint)',
    backgroundColor: 'var(--ivory-tint)',
    fontFamily: 'var(--font-primary)',
    fontSize: 15,
    color: 'var(--graphite)',
    lineHeight: 1.55,
    resize: 'vertical' as const,
    outline: 'none',
    boxSizing: 'border-box' as const,
  },

  partialTranscript: {
    fontFamily: 'var(--font-primary)',
    fontSize: 15,
    color: 'var(--graphite)',
    lineHeight: 1.55,
    padding: '8px 2px',
    opacity: 0.7,
    fontStyle: 'italic',
  },

  autoSendHint: {
    fontFamily: 'var(--font-primary)',
    fontSize: 12,
    color: 'var(--grey)',
    margin: 0,
  },

  reviewRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap' as const,
  },

  redoRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },

  redoButton: {
    padding: '10px 20px',
    borderRadius: 999,
    border: '1px solid var(--ivory-tint)',
    backgroundColor: 'transparent',
    color: 'var(--grey)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 500,
    fontSize: 13,
    cursor: 'pointer',
  },

  sendButton: {
    padding: '10px 24px',
    borderRadius: 999,
    border: 'none',
    backgroundColor: 'var(--horizon-red)',
    color: 'var(--white)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },

  errorText: {
    fontFamily: 'var(--font-primary)',
    fontSize: 14,
    color: 'var(--grey)',
    lineHeight: 1.5,
    margin: 0,
  },

  retryButton: {
    padding: '10px 20px',
    borderRadius: 999,
    border: '1px solid var(--horizon-red)',
    backgroundColor: 'transparent',
    color: 'var(--horizon-red)',
    fontFamily: 'var(--font-primary)',
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    alignSelf: 'flex-start' as const,
  },

  timeLimitWarning: {
    fontFamily: 'var(--font-primary)',
    fontSize: 12,
    color: 'var(--horizon-red)',
    margin: 0,
  },
} as const;
