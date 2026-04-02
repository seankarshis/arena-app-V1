'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
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

  const transcriptSyncedRef = useRef(false);

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
    if (state === 'RECORDING') actions.releasePTT();
  };

  const handlePTTTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
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
  // MEDIA_ERROR state
  // =========================================================================

  if (state === 'MEDIA_ERROR' || session.microphoneError) {
    return (
      <div className="flex flex-col gap-2 items-stretch">
        <p className="text-sm text-grey leading-normal m-0">{session.microphoneError}</p>
        <button
          onClick={() => void actions.retryMicrophone()}
          className="btn-secondary self-start py-2.5 px-5 text-[13px] border-horizon-red text-horizon-red"
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
      <div className="flex flex-col gap-2 items-stretch">
        <textarea
          value={localTranscript}
          onChange={(e) => handleTranscriptChange(e.target.value)}
          onFocus={handleTranscriptFocus}
          onBlur={handleTranscriptBlur}
          onKeyDown={handleTranscriptKeyDown}
          placeholder={hasTranscript ? undefined : 'Transcribing…'}
          rows={3}
          className="input-field text-[15px] leading-relaxed resize-y border-ivory-tint bg-ivory-tint"
        />

        {hasTranscript && (
          <p className="text-xs text-grey m-0">Sending in a moment…</p>
        )}

        <div className="flex gap-2 items-center flex-wrap">
          <button
            onClick={() => void actions.redo()}
            className="btn-secondary py-2.5 px-5 text-[13px] text-grey border-ivory-tint"
          >
            Redo
          </button>

          <button
            onClick={() => void actions.submitVoice()}
            disabled={!hasTranscript && localTranscript.trim() === ''}
            className="btn-primary py-2.5 px-6 text-[13px]"
          >
            Send
          </button>

          <button
            onMouseDown={handlePTTMouseDown}
            onMouseUp={handlePTTMouseUp}
            onMouseLeave={handlePTTMouseLeave}
            onTouchStart={handlePTTTouchStart}
            onTouchEnd={handlePTTTouchEnd}
            className="btn-secondary py-2.5 px-5 text-[13px] border-horizon-red text-horizon-red select-none touch-none"
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
      <div className="flex flex-col gap-2 items-stretch">
        {session.partialTranscript && (
          <p className="text-[15px] text-graphite leading-relaxed py-2 px-0.5 opacity-70 italic">
            {session.partialTranscript}
          </p>
        )}

        {session.nearingTimeLimit && (
          <p className="text-xs text-horizon-red m-0">1 minute remaining</p>
        )}

        <button
          onMouseUp={handlePTTMouseUp}
          onMouseLeave={handlePTTMouseLeave}
          onTouchEnd={handlePTTTouchEnd}
          className="btn-primary flex items-center justify-center gap-2.5 py-3.5 px-8 text-[15px]
                     select-none touch-none animate-arena-ptt-pulse"
          aria-label="Release to stop recording"
          aria-pressed
        >
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-white shrink-0" />
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
      <div className="flex flex-col gap-2 items-stretch">
        <textarea
          value={localTranscript}
          onChange={(e) => handleTranscriptChange(e.target.value)}
          onFocus={handleTranscriptFocus}
          onBlur={handleTranscriptBlur}
          onKeyDown={handleTranscriptKeyDown}
          placeholder="Edit your response, or hold the button below to re-record…"
          rows={3}
          className="input-field text-[15px] leading-relaxed resize-y border-ivory-tint bg-ivory-tint"
        />

        <div className="flex gap-2 items-center">
          <button
            onMouseDown={handlePTTMouseDown}
            onMouseUp={handlePTTMouseUp}
            onMouseLeave={handlePTTMouseLeave}
            onTouchStart={handlePTTTouchStart}
            onTouchEnd={handlePTTTouchEnd}
            className="btn-primary flex items-center justify-center gap-2 py-3.5 px-8 text-[15px]
                       select-none touch-none tracking-[0.01em]"
            aria-label="Hold to speak"
          >
            ● Hold to Speak
          </button>

          {canSendText && (
            <button
              onClick={() => {
                const wasPreviouslyVoice = session.finalTranscript !== null;
                actions.submitEditedTranscript(localTranscript, !wasPreviouslyVoice);
              }}
              className="btn-primary py-2.5 px-6 text-[13px]"
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
    <div className="flex flex-col gap-2 items-stretch">
      <button
        onMouseDown={handlePTTMouseDown}
        onMouseUp={handlePTTMouseUp}
        onMouseLeave={handlePTTMouseLeave}
        onTouchStart={handlePTTTouchStart}
        onTouchEnd={handlePTTTouchEnd}
        disabled={!!session.microphoneError}
        className={cn(
          'btn-primary flex items-center justify-center gap-2 py-3.5 px-8 text-[15px]',
          'select-none touch-none tracking-[0.01em]',
          session.microphoneError && 'opacity-40 cursor-not-allowed'
        )}
        aria-label="Hold to speak"
      >
        ● Hold to Speak
      </button>
    </div>
  );
}
