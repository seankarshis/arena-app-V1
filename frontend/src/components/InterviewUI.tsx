'use client';

import { useState, useRef, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import type {
  InterviewState,
  InterviewSession,
  InterviewActions,
} from '@/hooks/useInterviewState';
import TranscriptArea from './TranscriptArea';
import CompletionSummary from './CompletionSummary';

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
    <div className="min-h-screen flex items-center justify-center bg-ivory">
      <p className="text-grey text-base">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function InterviewUI({ state, session, actions }: Props) {
  const router = useRouter();
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const finalThoughtRef = useRef<HTMLTextAreaElement>(null);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;
    setInputText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    if (finalThoughtRef.current) finalThoughtRef.current.style.height = 'auto';
    await actions.submitText(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
      window.confirm('End your interview now? Your answers so far will be saved.')
    ) {
      await actions.endInterview();
    }
  };

  // =========================================================================
  // Full-screen overlay states
  // =========================================================================

  if (state === 'READY') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-ivory p-6 text-center">
        <div className="max-w-[480px]">
          <span className="font-hero text-xl text-graphite block mb-8">
            Arena
          </span>
          <h1 className="font-semibold text-[26px] text-graphite mb-3 tracking-[-0.01em]">
            Ready to begin?
          </h1>
          <p className="text-grey text-base leading-relaxed mb-10">
            When you click Start, your interview will begin. Take your time and
            answer each question as fully as you like. You can type your
            responses or skip questions.
          </p>
          <button
            onClick={() => void actions.startInterview()}
            className="btn-primary py-3.5 px-11 text-[15px]"
          >
            Start Interview
          </button>
        </div>
      </div>
    );
  }

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
    return (
      <CompletionSummary session={session} onGoHome={() => router.push('/')} />
    );
  }

  if (state === 'PAUSED' || state === 'AUTO_PAUSED') {
    const isAuto = state === 'AUTO_PAUSED';
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-ivory p-6 text-center">
        <div className="max-w-[480px]">
          <h2 className="font-semibold text-[22px] text-graphite mb-3">
            Interview Paused
          </h2>
          <p className={cn('text-grey text-base leading-relaxed', isAuto ? 'mb-2' : 'mb-10')}>
            {isAuto
              ? 'Your interview was paused due to inactivity.'
              : 'Your progress has been saved.'}
          </p>
          {isAuto && (
            <p className="text-grey text-sm mb-10">
              Click Resume when you are ready to continue. You have 72 hours
              before this session expires.
            </p>
          )}
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={() => void actions.resumeInterview()}
              className="btn-primary py-3 px-8 text-[15px]"
            >
              Resume Interview
            </button>
            <button
              onClick={() => router.push('/')}
              className="btn-ghost underline text-sm"
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-ivory p-6 text-center">
        <div className="max-w-[480px]">
          <h2 className="font-semibold text-[22px] text-horizon-red mb-3">
            Something went wrong
          </h2>
          <p className="text-grey text-[15px] mb-8">
            {session.errorMessage ?? 'An unexpected error occurred.'}
          </p>
          <div className="flex flex-col gap-3 items-center">
            <button
              onClick={() => window.location.reload()}
              className="btn-primary py-3 px-8 text-[15px]"
            >
              Retry
            </button>
            <button
              onClick={() => router.push('/')}
              className="btn-ghost underline text-sm"
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
  // =========================================================================

  const isInputEnabled =
    state === 'AWAITING_INPUT' ||
    state === 'IDLE_WARNING' ||
    state === 'COMPLETING';

  const isStreaming = state === 'LLM_STREAMING';
  const isThinking = state === 'PROCESSING' || state === 'SKIPPING';
  const isCompleting = state === 'COMPLETING';

  const canPause = state === 'AWAITING_INPUT' || state === 'IDLE_WARNING';
  const canEnd =
    state === 'AWAITING_INPUT' ||
    state === 'IDLE_WARNING' ||
    state === 'COMPLETING';

  const questionPanelText = isStreaming
    ? session.streamingText
    : isThinking
    ? ''
    : session.currentQuestion;

  return (
    <div className="flex flex-col h-screen bg-ivory">
      {/* ---- Header ---- */}
      <header className="flex items-center gap-4 py-3 px-6 border-b border-ivory-tint bg-white shrink-0">
        <span className="font-hero text-lg text-graphite">Arena</span>

        {/* Progress bar */}
        <div
          className="flex-1 h-1 bg-ivory-tint rounded overflow-hidden"
          role="progressbar"
          aria-valuenow={session.progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-horizon-red rounded"
            style={{
              width: `${session.progressPercent}%`,
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        <button
          onClick={canPause ? () => void handlePause() : undefined}
          disabled={!canPause}
          className={cn(
            'btn-secondary py-1.5 px-3.5 text-[13px] text-grey',
            !canPause && 'opacity-35 cursor-default'
          )}
        >
          Pause
        </button>
        <button
          onClick={canEnd ? () => void handleEnd() : undefined}
          disabled={!canEnd}
          className={cn(
            'btn-ghost text-[13px]',
            !canEnd && 'opacity-35 cursor-default'
          )}
        >
          End Interview
        </button>
      </header>

      {/* ---- Idle warning banner ---- */}
      {state === 'IDLE_WARNING' && session.idlePrompt && (
        <div role="status" className="alert-warning py-2.5 px-6 border-b border-grey/30 rounded-none shrink-0">
          <p className="text-sm text-graphite">{session.idlePrompt}</p>
        </div>
      )}

      {/* ---- Current question panel ---- */}
      <div className="bg-dark-maroon py-7 px-8 shrink-0 relative" style={{ minHeight: 100 }}>
        <p className="text-ivory text-lg leading-relaxed pr-[72px]">
          {questionPanelText || '\u00a0'}
          {isStreaming && questionPanelText && (
            <span className="inline-block w-0.5 h-[1.1em] bg-ivory ml-0.5 align-text-bottom animate-arena-blink" />
          )}
          {isThinking && (
            <span className="text-ivory/50">···</span>
          )}
        </p>

        {/* Skip button */}
        {(state === 'AWAITING_INPUT' || state === 'IDLE_WARNING') && (
          <button
            onClick={() => void actions.skipQuestion()}
            className="absolute bottom-4 right-6 bg-transparent border-none text-ivory/50 text-[13px]
                       cursor-pointer p-1 px-2 hover:text-ivory transition-colors duration-150"
          >
            Skip
          </button>
        )}
      </div>

      {/* ---- Transcript area ---- */}
      <TranscriptArea transcript={session.transcript} />

      {/* ---- Input area ---- */}
      <div className="py-4 px-6 border-t border-ivory-tint bg-white shrink-0">
        {isCompleting ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-2.5 items-end">
              <textarea
                ref={finalThoughtRef}
                value={inputText}
                onChange={handleTextChange}
                onKeyDown={handleKeyDown}
                placeholder="Add a final thought (optional)…"
                rows={1}
                className="input-field flex-1 text-base resize-none overflow-hidden leading-normal border-ivory-tint bg-ivory-tint"
              />
              {inputText.trim() && (
                <button
                  onClick={() => void handleSend()}
                  className="btn-primary py-3 px-5 text-sm"
                >
                  Send
                </button>
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => void actions.endInterview()}
                className="btn-primary py-3 px-8 text-[15px]"
              >
                Finish Interview
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2.5 items-end">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              disabled={!isInputEnabled}
              placeholder={isInputEnabled ? 'Type your response…' : 'Waiting…'}
              rows={1}
              className={cn(
                'input-field flex-1 text-base resize-none overflow-hidden leading-normal border-ivory-tint',
                isInputEnabled ? 'bg-ivory-tint' : 'bg-ivory opacity-60 cursor-not-allowed'
              )}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!isInputEnabled || !inputText.trim()}
              className={cn(
                'rounded-md border-none font-semibold text-sm py-3 px-6 transition-colors duration-150',
                isInputEnabled && inputText.trim()
                  ? 'bg-horizon-red text-white cursor-pointer'
                  : 'bg-ivory-tint text-grey cursor-not-allowed'
              )}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
