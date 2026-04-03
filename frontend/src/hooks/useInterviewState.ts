'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation, gql } from '@apollo/client';
import { useSSE, type SSEMessage } from './useSSE';
import { usePTT } from './usePTT';
import { audioUploadQueue } from '@/lib/audioUploadQueue';
import { getIdToken } from '@/lib/auth';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001');

// ---------------------------------------------------------------------------
// State machine states
// ---------------------------------------------------------------------------

export type InterviewState =
  | 'READY'
  | 'STARTING'
  | 'AWAITING_INPUT'
  | 'RECORDING'
  | 'REVIEW'
  | 'REDO'
  | 'MEDIA_ERROR'
  | 'PROCESSING'
  | 'LLM_STREAMING'
  | 'SKIPPING'
  | 'COMPLETING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'PAUSED'
  | 'RESUMING'
  | 'ERROR'
  | 'IDLE_WARNING'
  | 'AUTO_PAUSED';

// ---------------------------------------------------------------------------
// Session data
// ---------------------------------------------------------------------------

export interface Turn {
  questionText: string;
  answerText: string | null;
  isSkipped: boolean;
}

export interface InterviewSession {
  interviewId: string;
  templateId: string;
  currentQuestionId: string | null;
  /** Full text of the current question (shown in question panel when AWAITING_INPUT). */
  currentQuestion: string;
  /** Accumulates SSE token events during LLM_STREAMING. Shown in question panel live. */
  streamingText: string;
  /** Completed question-answer pairs (shown in transcript area). */
  transcript: Turn[];
  progressPercent: number;
  /** Total questions in the template (set at interview start). */
  totalQuestions: number;
  /** Idle prompt text delivered by the backend during inactivity. */
  idlePrompt: string | null;
  errorMessage: string | null;
  /** Set when startInterview succeeds; used for session duration display. */
  startedAt: Date | null;
  // ---- Voice recording fields ----
  /** Live partial transcript during RECORDING state. */
  partialTranscript: string;
  /** Final transcript in REVIEW/REDO; null if STT WebSocket failed or not yet received. */
  finalTranscript: string | null;
  /** Captured audio Blob from the most recent recording; held until upload. */
  audioBlob: Blob | null;
  /** True when recording has passed the 4-minute warning threshold. */
  nearingTimeLimit: boolean;
  /** Non-null when microphone access fails; drives PTT disabled state. */
  microphoneError: string | null;
  /** Number of audio uploads currently in progress or queued. Used for UPLOADING progress indicator. */
  pendingUploadsCount: number;
  /** True if audio uploads were still pending when the 60 s UPLOADING timeout was reached. */
  uploadsPendingOnTimeout: boolean;
  // ---- Error recovery fields ----
  /** True when the browser reports offline status. */
  isOffline: boolean;
  /** Number of LLM stream retries attempted for the current question. */
  llmRetryCount: number;
  /** True when the SSE connection is attempting to reconnect. */
  isReconnecting: boolean;
  /** Set when startInterview fails because the user already has an active interview. */
  conflictingInterviewId: string | null;
}

export interface InterviewActions {
  startInterview: () => Promise<void>;
  abandonAndStart: () => Promise<void>;
  submitText: (text: string) => Promise<void>;
  skipQuestion: () => Promise<void>;
  pauseInterview: () => Promise<void>;
  resumeInterview: () => Promise<void>;
  /** End the interview (user-initiated or from COMPLETING state). */
  endInterview: () => Promise<void>;
  /** Return to AWAITING_INPUT from LLM-initiated COMPLETING state. */
  continueFromCompletion: () => void;
  // ---- Voice recording actions ----
  /** Press PTT button: start recording (valid from AWAITING_INPUT, IDLE_WARNING, REDO, REVIEW). */
  pressPTT: () => Promise<void>;
  /** Release PTT button: stop recording and enter REVIEW state. */
  releasePTT: () => void;
  /** Explicitly submit the current REVIEW transcript (also fired by auto-send timer). */
  submitVoice: () => Promise<void>;
  /** Update the editable transcript text in REVIEW/REDO without submitting. */
  updateFinalTranscript: (text: string) => void;
  /** Submit edited/typed text from REDO → transitions to REVIEW then auto-sends.
   *  Pass fromScratch=true when the user typed fresh text (not editing a prior transcript). */
  submitEditedTranscript: (text: string, fromScratch?: boolean) => void;
  /** Save current recording as a draft and enter REDO state. */
  redo: () => Promise<void>;
  /** Re-attempt microphone access after a MEDIA_ERROR. */
  retryMicrophone: () => Promise<void>;
  /** Call when transcript text field receives focus (pauses auto-send timer). */
  onTranscriptFocus: () => void;
  /** Call when transcript text field loses focus (restarts auto-send timer). */
  onTranscriptBlur: () => void;
  /** Retry the LLM stream after a retryable error (up to 3 attempts, then auto-pauses). */
  retryLLM: () => void;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const START_INTERVIEW = gql`
  mutation StartInterview($templateId: ID!) {
    startInterview(templateId: $templateId) {
      interviewId
      totalQuestions
    }
  }
`;

const ABANDON_INTERVIEW = gql`
  mutation AbandonInterview($interviewId: ID!) {
    abandonInterview(interviewId: $interviewId) {
      id
      status
    }
  }
`;

const SUBMIT_RESPONSE = gql`
  mutation SubmitResponse(
    $interviewId: ID!
    $rawTranscription: String!
    $inputMode: String!
  ) {
    submitResponse(
      interviewId: $interviewId
      rawTranscription: $rawTranscription
      inputMode: $inputMode
    ) {
      responseId
    }
  }
`;

const SKIP_QUESTION = gql`
  mutation SkipQuestion($interviewId: ID!) {
    skipQuestion(interviewId: $interviewId) {
      success
    }
  }
`;

const PAUSE_INTERVIEW = gql`
  mutation PauseInterview($interviewId: ID!) {
    pauseInterview(interviewId: $interviewId) {
      id
      status
    }
  }
`;

const RESUME_INTERVIEW = gql`
  mutation ResumeInterview($interviewId: ID!) {
    resumeInterview(interviewId: $interviewId) {
      id
      status
    }
  }
`;

const COMPLETE_INTERVIEW = gql`
  mutation CompleteInterview($interviewId: ID!) {
    completeInterview(interviewId: $interviewId) {
      id
      status
    }
  }
`;

const SAVE_DRAFT = gql`
  mutation SaveDraft(
    $interviewId: ID!
    $transcript: String!
    $inputMode: String!
  ) {
    saveDraft(
      interviewId: $interviewId
      transcript: $transcript
      inputMode: $inputMode
    ) {
      draftId
    }
  }
`;

// ---------------------------------------------------------------------------
// Mutation result types (for type-safe data access)
// ---------------------------------------------------------------------------

interface StartInterviewResult {
  startInterview: { interviewId: string; totalQuestions: number };
}

interface SubmitResponseResult {
  submitResponse: { responseId: string };
}

interface SaveDraftResult {
  saveDraft: { draftId: string };
}

// ---------------------------------------------------------------------------
// SSE states where the connection must be open
// ---------------------------------------------------------------------------

const SSE_ENABLED_STATES: ReadonlySet<InterviewState> = new Set([
  'LLM_STREAMING',
  'AWAITING_INPUT',
  'PROCESSING',
  'SKIPPING',
  'IDLE_WARNING',
  'RESUMING',
  'RECORDING',
  'REVIEW',
  'REDO',
  'MEDIA_ERROR',
  // Keep SSE open during COMPLETING so a submitted final thought can stream a response
  'COMPLETING',
]);

// States where the interview is active and should be preserved on navigation
const ACTIVE_INTERVIEW_STATES: ReadonlySet<InterviewState> = new Set([
  'AWAITING_INPUT',
  'IDLE_WARNING',
  'RECORDING',
  'REVIEW',
  'REDO',
  'PROCESSING',
  'LLM_STREAMING',
  'SKIPPING',
  'MEDIA_ERROR',
  'COMPLETING',
  'STARTING',
  'RESUMING',
]);

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useInterviewState(templateId: string): {
  state: InterviewState;
  session: InterviewSession;
  actions: InterviewActions;
} {
  const [machineState, setMachineState] = useState<InterviewState>('READY');
  const [session, setSession] = useState<InterviewSession>({
    interviewId: '',
    templateId,
    currentQuestionId: null,
    currentQuestion: '',
    streamingText: '',
    transcript: [],
    progressPercent: 0,
    totalQuestions: 0,
    idlePrompt: null,
    errorMessage: null,
    startedAt: null,
    partialTranscript: '',
    finalTranscript: null,
    audioBlob: null,
    nearingTimeLimit: false,
    microphoneError: null,
    pendingUploadsCount: 0,
    uploadsPendingOnTimeout: false,
    isOffline: false,
    llmRetryCount: 0,
    isReconnecting: false,
    conflictingInterviewId: null,
  });

  // Refs for reading current values inside callbacks without stale closures
  const machineStateRef = useRef(machineState);
  const sessionRef = useRef(session);
  machineStateRef.current = machineState;
  sessionRef.current = session;

  // ---------------------------------------------------------------------------
  // PTT hook
  // ---------------------------------------------------------------------------

  const ptt = usePTT();

  // ---------------------------------------------------------------------------
  // Auto-send timer management
  // ---------------------------------------------------------------------------

  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // pendingInputMode tracks what inputMode to use when auto-send fires
  const pendingInputModeRef = useRef<'voice' | 'edited' | 'text'>('voice');

  // Recording duration tracking — set on pressPTT, computed on releasePTT
  const recordingStartTimeRef = useRef<number | null>(null);
  const recordingDurationRef = useRef<number>(0);

  // LLM retry counter ref (avoids stale closure in SSE callback)
  const llmRetryCountRef = useRef(0);

  // Cached auth token for best-effort beforeunload pause
  const cachedTokenRef = useRef<string | null>(null);

  // Guard against rapid duplicate user actions
  const actionInFlightRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const [startInterviewMutation] = useMutation<
    StartInterviewResult,
    { templateId: string }
  >(START_INTERVIEW);

  const [abandonInterviewMutation] = useMutation<unknown, { interviewId: string }>(
    ABANDON_INTERVIEW
  );

  const [submitResponseMutation] = useMutation<
    SubmitResponseResult,
    { interviewId: string; rawTranscription: string; inputMode: string }
  >(SUBMIT_RESPONSE);

  const [skipQuestionMutation] = useMutation<unknown, { interviewId: string }>(
    SKIP_QUESTION
  );

  const [pauseInterviewMutation] = useMutation<unknown, { interviewId: string }>(
    PAUSE_INTERVIEW
  );

  const [resumeInterviewMutation] = useMutation<unknown, { interviewId: string }>(
    RESUME_INTERVIEW
  );

  const [completeInterviewMutation] = useMutation<
    unknown,
    { interviewId: string }
  >(COMPLETE_INTERVIEW);

  const [saveDraftMutation] = useMutation<
    SaveDraftResult,
    { interviewId: string; transcript: string; inputMode: string }
  >(SAVE_DRAFT);

  // Keep mutation refs current so timer callbacks always use the latest version
  const submitResponseMutationRef = useRef(submitResponseMutation);
  useEffect(() => { submitResponseMutationRef.current = submitResponseMutation; }, [submitResponseMutation]);

  const pauseInterviewMutationRef = useRef(pauseInterviewMutation);
  useEffect(() => { pauseInterviewMutationRef.current = pauseInterviewMutation; }, [pauseInterviewMutation]);

  // ---------------------------------------------------------------------------
  // SSE message handler
  // ---------------------------------------------------------------------------

  const handleSSEMessage = useCallback((msg: SSEMessage) => {
    switch (msg.type) {
      case 'token':
        // Transition to LLM_STREAMING on first token from PROCESSING or SKIPPING
        setMachineState((prev) =>
          prev === 'PROCESSING' || prev === 'LLM_STREAMING' || prev === 'SKIPPING'
            ? 'LLM_STREAMING'
            : prev
        );
        setSession((prev) => ({
          ...prev,
          streamingText: prev.streamingText + msg.content,
        }));
        break;

      case 'stream_complete':
        llmRetryCountRef.current = 0;
        if (msg.interviewComplete) {
          // LLM-initiated completion: show closing message, let user decide
          setSession((prev) => ({
            ...prev,
            streamingText: '',
            currentQuestion: msg.fullResponse,
            progressPercent: msg.progressPercent,
            llmRetryCount: 0,
          }));
          setMachineState('COMPLETING');
        } else {
          // Normal turn: next question ready
          setSession((prev) => ({
            ...prev,
            streamingText: '',
            currentQuestion: msg.fullResponse,
            currentQuestionId: msg.questionId,
            progressPercent: msg.progressPercent,
            idlePrompt: null,
            llmRetryCount: 0,
          }));
          setMachineState('AWAITING_INPUT');
        }
        break;

      case 'idle_prompt':
        setSession((prev) => ({ ...prev, idlePrompt: msg.content }));
        setMachineState('IDLE_WARNING');
        break;

      case 'auto_paused':
        setMachineState('AUTO_PAUSED');
        break;

      case 'error':
        if (msg.retryable) {
          // LLM stream error — track retries; auto-pause after 3
          const newCount = llmRetryCountRef.current + 1;
          llmRetryCountRef.current = newCount;
          if (newCount >= 3) {
            setSession((prev) => ({
              ...prev,
              errorMessage:
                "We're experiencing technical difficulties. Your interview has been saved — you can resume later.",
              llmRetryCount: newCount,
            }));
            setMachineState('PAUSED');
            // Best-effort pause mutation
            const id = sessionRef.current.interviewId;
            if (id) {
              pauseInterviewMutationRef.current({
                variables: { interviewId: id },
              }).catch(() => {});
            }
          } else {
            setSession((prev) => ({
              ...prev,
              errorMessage: msg.message,
              llmRetryCount: newCount,
            }));
            setMachineState('ERROR');
          }
        } else {
          setSession((prev) => ({
            ...prev,
            errorMessage: msg.message,
            llmRetryCount: 0,
          }));
          setMachineState('ERROR');
        }
        break;

      default:
        break;
    }
  }, []);

  const handleSSEError = useCallback(() => {
    setSession((prev) => ({
      ...prev,
      errorMessage:
        'Connection lost after multiple retries. Please refresh and try again.',
      isReconnecting: false,
    }));
    setMachineState('ERROR');
  }, []);

  const handleSSEReconnecting = useCallback(() => {
    setSession((prev) => ({ ...prev, isReconnecting: true }));
  }, []);

  const handleSSEConnected = useCallback(() => {
    setSession((prev) => ({ ...prev, isReconnecting: false }));
  }, []);

  useSSE({
    interviewId: session.interviewId || null,
    onMessage: handleSSEMessage,
    onConnected: handleSSEConnected,
    onReconnecting: handleSSEReconnecting,
    onError: handleSSEError,
    enabled: !!session.interviewId && SSE_ENABLED_STATES.has(machineState),
  });

  // ---------------------------------------------------------------------------
  // PTT state → session sync effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setSession((prev) => ({ ...prev, partialTranscript: ptt.partialTranscript }));
  }, [ptt.partialTranscript]);

  useEffect(() => {
    setSession((prev) => ({ ...prev, audioBlob: ptt.audioBlob }));
  }, [ptt.audioBlob]);

  useEffect(() => {
    setSession((prev) => ({ ...prev, nearingTimeLimit: ptt.nearingTimeLimit }));
  }, [ptt.nearingTimeLimit]);

  useEffect(() => {
    setSession((prev) => ({ ...prev, microphoneError: ptt.microphoneError }));
  }, [ptt.microphoneError]);

  // Sync audioUploadQueue pending count into session for UI progress display
  useEffect(() => {
    return audioUploadQueue.subscribe((count) => {
      setSession((prev) => ({ ...prev, pendingUploadsCount: count }));
    });
  }, []);

  // When final_transcript arrives from STT, sync to session and start auto-send
  // (auto-send only starts if we're in REVIEW state when the transcript arrives)
  useEffect(() => {
    if (ptt.finalTranscript === null) return;
    setSession((prev) => ({ ...prev, finalTranscript: ptt.finalTranscript }));
    if (machineStateRef.current === 'REVIEW') {
      startAutoSend();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptt.finalTranscript]);

  // ---------------------------------------------------------------------------
  // Error recovery & edge case effects
  // ---------------------------------------------------------------------------

  // Cache auth token for best-effort beforeunload pause
  useEffect(() => {
    if (!session.interviewId) return;
    const refresh = () => {
      getIdToken()
        .then((t) => { cachedTokenRef.current = t; })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [session.interviewId]);

  // beforeunload: best-effort pause on tab close / navigation away
  useEffect(() => {
    if (!session.interviewId) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const state = machineStateRef.current;
      if (!ACTIVE_INTERVIEW_STATES.has(state)) return;
      const id = sessionRef.current.interviewId;
      if (!id) return;

      // Best-effort pause via fetch keepalive (auth may fail — backend heartbeat is fallback)
      const token = cachedTokenRef.current;
      const body = JSON.stringify({
        query:
          'mutation PauseInterview($id: ID!) { pauseInterview(interviewId: $id) { id } }',
        variables: { id },
      });
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        fetch(`${API_BASE}/graphql`, {
          method: 'POST',
          headers,
          body,
          keepalive: true,
        });
      } catch {
        // best effort — backend heartbeat timeout will auto-pause
      }

      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [session.interviewId]);

  // Network online/offline detection
  useEffect(() => {
    if (!session.interviewId) return;

    const handleOffline = () => {
      setSession((prev) => ({ ...prev, isOffline: true }));
    };
    const handleOnline = () => {
      setSession((prev) => ({ ...prev, isOffline: false }));
      // SSE will auto-reconnect via the enabled flag when the connection returns
    };

    // Check initial state
    if (!navigator.onLine) {
      setSession((prev) => ({ ...prev, isOffline: true }));
    }

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [session.interviewId]);

  // Tab visibility change: refresh online status when tab becomes visible
  useEffect(() => {
    if (!session.interviewId) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Browser may not fire online/offline events while tab is hidden
        setSession((prev) => ({ ...prev, isOffline: !navigator.onLine }));
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [session.interviewId]);

  // Browser back/forward: prevent accidental navigation during active interview
  useEffect(() => {
    if (!session.interviewId) return;

    window.history.pushState({ arena: 'interview' }, '');

    const handlePopState = () => {
      if (ACTIVE_INTERVIEW_STATES.has(machineStateRef.current)) {
        // Re-push to prevent navigation; user must use End Interview or close tab
        window.history.pushState({ arena: 'interview' }, '');
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [session.interviewId]);

  // ---------------------------------------------------------------------------
  // Auto-send helpers (stable — only use refs and React setters)
  // ---------------------------------------------------------------------------

  const clearAutoSend = useCallback(() => {
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current);
      autoSendTimerRef.current = null;
    }
  }, []);

  // startAutoSend: starts the 2-second auto-send countdown.
  // Stable — depends only on clearAutoSend (which has [] deps) and refs.
  const startAutoSend = useCallback(() => {
    clearAutoSend();
    autoSendTimerRef.current = setTimeout(() => {
      autoSendTimerRef.current = null;
      if (machineStateRef.current !== 'REVIEW') return;
      const sess = sessionRef.current;
      if (!sess.interviewId) return;

      const transcript = sess.finalTranscript ?? '';
      const inputMode = pendingInputModeRef.current;
      const audioBlob = sess.audioBlob;
      const durationSeconds = recordingDurationRef.current;

      setSession((prev) => ({
        ...prev,
        transcript: [
          ...prev.transcript,
          { questionText: prev.currentQuestion, answerText: transcript, isSkipped: false },
        ],
        streamingText: '',
        partialTranscript: '',
        finalTranscript: null,
        idlePrompt: null,
      }));
      setMachineState('PROCESSING');

      submitResponseMutationRef.current({
        variables: { interviewId: sess.interviewId, rawTranscription: transcript, inputMode },
      }).then((result) => {
        const responseId = result.data?.submitResponse.responseId;
        if (audioBlob && responseId && inputMode === 'voice') {
          audioUploadQueue.enqueueResponseUpload(
            sess.interviewId,
            responseId,
            audioBlob,
            audioBlob.type || 'audio/webm',
            durationSeconds,
          );
        }
      }).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : 'Failed to submit response';
        setSession((prev) => ({ ...prev, errorMessage }));
        setMachineState('ERROR');
      });
    }, 2000);
  }, [clearAutoSend]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const startInterview = useCallback(async () => {
    if (machineStateRef.current !== 'READY') return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setMachineState('STARTING');
    try {
      console.log('[interview] startInterview templateId=%s', templateId);
      const result = await startInterviewMutation({ variables: { templateId } });
      const interviewId = result.data?.startInterview.interviewId;
      const totalQuestions = result.data?.startInterview.totalQuestions ?? 0;
      if (!interviewId) throw new Error('No interview ID returned from server');
      console.log('[interview] startInterview success interviewId=%s', interviewId);
      // Set interviewId and startedAt first — SSE enabled check reads interviewId
      setSession((prev) => ({ ...prev, interviewId, totalQuestions, startedAt: new Date() }));

      // Eagerly request microphone permission (non-blocking — interview continues on failure)
      ptt.requestPermission().catch(() => { /* microphoneError set in session by effect */ });

      // LLM_STREAMING enables SSE; backend streams the first question immediately
      setMachineState('LLM_STREAMING');
    } catch (err) {
      console.error('[interview] startInterview failed:', err);
      if (err && typeof err === 'object' && 'graphQLErrors' in err) {
        console.error('[interview] GraphQL errors:', JSON.stringify((err as { graphQLErrors: unknown }).graphQLErrors, null, 2));
      }
      // Detect "already has active interview" — stay in READY and surface a conflict prompt
      const graphqlErrors = (err && typeof err === 'object' && 'graphQLErrors' in err)
        ? (err as { graphQLErrors: Array<{ extensions?: { code?: string; details?: { existingInterviewId?: string } } }> }).graphQLErrors
        : [];
      const conflictError = graphqlErrors.find(
        (e) => e.extensions?.code === 'INVALID_STATE' && e.extensions?.details?.existingInterviewId
      );
      if (conflictError) {
        setSession((prev) => ({
          ...prev,
          conflictingInterviewId: conflictError.extensions!.details!.existingInterviewId!,
        }));
        setMachineState('READY');
      } else {
        const errorMessage = err instanceof Error ? err.message : 'Failed to start interview';
        setSession((prev) => ({ ...prev, errorMessage }));
        setMachineState('ERROR');
      }
    } finally {
      actionInFlightRef.current = false;
    }
  }, [templateId, startInterviewMutation, ptt]);

  const abandonAndStart = useCallback(async () => {
    const conflictId = sessionRef.current.conflictingInterviewId;
    if (!conflictId) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setMachineState('STARTING');
    try {
      await abandonInterviewMutation({ variables: { interviewId: conflictId } });
      setSession((prev) => ({ ...prev, conflictingInterviewId: null }));
      const result = await startInterviewMutation({ variables: { templateId } });
      const interviewId = result.data?.startInterview.interviewId;
      const totalQuestions = result.data?.startInterview.totalQuestions ?? 0;
      if (!interviewId) throw new Error('No interview ID returned from server');
      setSession((prev) => ({ ...prev, interviewId, totalQuestions, startedAt: new Date() }));
      ptt.requestPermission().catch(() => {});
      setMachineState('LLM_STREAMING');
    } catch (err) {
      console.error('[interview] abandonAndStart failed:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to start interview';
      setSession((prev) => ({ ...prev, errorMessage, conflictingInterviewId: null }));
      setMachineState('ERROR');
    } finally {
      actionInFlightRef.current = false;
    }
  }, [templateId, abandonInterviewMutation, startInterviewMutation, ptt]);

  const submitText = useCallback(
    async (text: string) => {
      const state = machineStateRef.current;
      const currentSession = sessionRef.current;
      if (
        state !== 'AWAITING_INPUT' &&
        state !== 'IDLE_WARNING' &&
        state !== 'COMPLETING'
      )
        return;
      if (!currentSession.interviewId) return;
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;

      // Add completed turn to transcript immediately for optimistic UI
      setSession((prev) => ({
        ...prev,
        transcript: [
          ...prev.transcript,
          {
            questionText: prev.currentQuestion,
            answerText: text,
            isSkipped: false,
          },
        ],
        streamingText: '',
        idlePrompt: null,
      }));
      setMachineState('PROCESSING');

      try {
        await submitResponseMutation({
          variables: {
            interviewId: currentSession.interviewId,
            rawTranscription: text,
            inputMode: 'text',
          },
        });
        // Backend now streams LLM response via open SSE connection
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Failed to submit response';
        setSession((prev) => ({ ...prev, errorMessage }));
        setMachineState('ERROR');
      } finally {
        actionInFlightRef.current = false;
      }
    },
    [submitResponseMutation]
  );

  const skipQuestion = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (state !== 'AWAITING_INPUT' && state !== 'IDLE_WARNING') return;
    if (!currentSession.interviewId) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;

    setSession((prev) => ({
      ...prev,
      transcript: [
        ...prev.transcript,
        {
          questionText: prev.currentQuestion,
          answerText: null,
          isSkipped: true,
        },
      ],
      idlePrompt: null,
    }));
    setMachineState('SKIPPING');

    try {
      await skipQuestionMutation({
        variables: { interviewId: currentSession.interviewId },
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to skip question';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    } finally {
      actionInFlightRef.current = false;
    }
  }, [skipQuestionMutation]);

  const pauseInterview = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (state !== 'AWAITING_INPUT' && state !== 'IDLE_WARNING') return;
    if (!currentSession.interviewId) return;

    // Optimistic: transition immediately (SSE_ENABLED_STATES won't include PAUSED,
    // so the SSE connection tears down on next render cycle)
    setMachineState('PAUSED');

    try {
      await pauseInterviewMutation({
        variables: { interviewId: currentSession.interviewId },
      });
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to pause interview';
      setSession((prev) => ({ ...prev, errorMessage }));
    }
  }, [pauseInterviewMutation]);

  const resumeInterview = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (state !== 'PAUSED' && state !== 'AUTO_PAUSED') return;
    if (!currentSession.interviewId) return;

    setMachineState('RESUMING');

    try {
      await resumeInterviewMutation({
        variables: { interviewId: currentSession.interviewId },
      });
      // Backend will stream re-engagement message; SSE connects via RESUMING state
      setMachineState('LLM_STREAMING');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to resume interview';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    }
  }, [resumeInterviewMutation]);

  const endInterview = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (
      state !== 'AWAITING_INPUT' &&
      state !== 'IDLE_WARNING' &&
      state !== 'COMPLETING'
    )
      return;
    if (!currentSession.interviewId) return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;

    // Skip COMPLETING UI for user-initiated end; go straight to UPLOADING spinner
    setMachineState('UPLOADING');

    try {
      await completeInterviewMutation({
        variables: { interviewId: currentSession.interviewId },
      });
      // Wait up to 60 s for any in-flight audio uploads to finish
      const allUploaded = await audioUploadQueue.waitForEmpty(60_000);
      if (!allUploaded) {
        // Timeout — uploads continue in background; surface a note in session
        setSession((prev) => ({ ...prev, uploadsPendingOnTimeout: true }));
      }
      setMachineState('COMPLETED');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to complete interview';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    } finally {
      actionInFlightRef.current = false;
    }
  }, [completeInterviewMutation]);

  const continueFromCompletion = useCallback(() => {
    if (machineStateRef.current !== 'COMPLETING') return;
    // Return to input mode so the user can add a freeform final response
    setMachineState('AWAITING_INPUT');
  }, []);

  // ---- PTT actions ----

  const pressPTT = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (
      state !== 'AWAITING_INPUT' &&
      state !== 'IDLE_WARNING' &&
      state !== 'REDO' &&
      state !== 'REVIEW'
    )
      return;
    if (!currentSession.interviewId) return;
    // Guard: if mic is unavailable, don't attempt recording
    if (currentSession.microphoneError) return;

    // Cancel auto-send immediately (spec: PTT mousedown kills auto-send unconditionally)
    clearAutoSend();

    // If coming from REVIEW, reset prior recording state before starting fresh
    if (state === 'REVIEW') {
      ptt.reset();
      setSession((prev) => ({
        ...prev,
        partialTranscript: '',
        finalTranscript: null,
        audioBlob: null,
      }));
    }

    pendingInputModeRef.current = 'voice';
    recordingStartTimeRef.current = Date.now();
    setMachineState('RECORDING');

    const started = await ptt.start(currentSession.interviewId);
    if (!started) {
      // Mic failure during start — ptt.microphoneError synced to session by effect
      setMachineState('MEDIA_ERROR');
    }
  }, [ptt, clearAutoSend]);

  const releasePTT = useCallback(() => {
    if (machineStateRef.current !== 'RECORDING') return;
    if (recordingStartTimeRef.current !== null) {
      recordingDurationRef.current = (Date.now() - recordingStartTimeRef.current) / 1000;
      recordingStartTimeRef.current = null;
    }
    ptt.stop();
    // Enter REVIEW immediately; auto-send timer starts when finalTranscript arrives
    setMachineState('REVIEW');
  }, [ptt]);

  const submitVoice = useCallback(async () => {
    if (machineStateRef.current !== 'REVIEW') return;
    clearAutoSend();
    const sess = sessionRef.current;
    if (!sess.interviewId) return;

    const transcript = sess.finalTranscript ?? '';
    const inputMode = pendingInputModeRef.current;
    const audioBlob = sess.audioBlob;
    const durationSeconds = recordingDurationRef.current;

    setSession((prev) => ({
      ...prev,
      transcript: [
        ...prev.transcript,
        { questionText: prev.currentQuestion, answerText: transcript, isSkipped: false },
      ],
      streamingText: '',
      partialTranscript: '',
      finalTranscript: null,
      idlePrompt: null,
    }));
    setMachineState('PROCESSING');

    try {
      const result = await submitResponseMutation({
        variables: {
          interviewId: sess.interviewId,
          rawTranscription: transcript,
          inputMode,
        },
      });
      const responseId = result.data?.submitResponse.responseId;
      if (audioBlob && responseId && inputMode === 'voice') {
        audioUploadQueue.enqueueResponseUpload(
          sess.interviewId,
          responseId,
          audioBlob,
          audioBlob.type || 'audio/webm',
          durationSeconds,
        );
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to submit response';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    }
  }, [submitResponseMutation, clearAutoSend]);

  const updateFinalTranscript = useCallback((text: string) => {
    setSession((prev) => ({ ...prev, finalTranscript: text }));
  }, []);

  const submitEditedTranscript = useCallback(
    (text: string, fromScratch = false) => {
      if (machineStateRef.current !== 'REDO') return;
      pendingInputModeRef.current = fromScratch ? 'text' : 'edited';
      setSession((prev) => ({ ...prev, finalTranscript: text, audioBlob: null }));
      setMachineState('REVIEW');
      // Start auto-send immediately since we already have the text
      startAutoSend();
    },
    [startAutoSend]
  );

  const redo = useCallback(async () => {
    if (machineStateRef.current !== 'REVIEW') return;
    const currentSession = sessionRef.current;
    if (!currentSession.interviewId) return;

    clearAutoSend();
    const transcript = currentSession.finalTranscript ?? '';
    const audioBlob = currentSession.audioBlob;
    const durationSeconds = recordingDurationRef.current;

    setMachineState('REDO');

    // Save draft to DB and queue audio upload (non-blocking — REDO proceeds even if this fails)
    saveDraftMutation({
      variables: {
        interviewId: currentSession.interviewId,
        transcript,
        inputMode: pendingInputModeRef.current,
      },
    }).then((result) => {
      const draftId = result.data?.saveDraft.draftId;
      if (audioBlob && draftId) {
        audioUploadQueue.enqueueDraftUpload(
          currentSession.interviewId,
          draftId,
          audioBlob,
          audioBlob.type || 'audio/webm',
          durationSeconds,
        );
      }
    }).catch(() => { /* draft save failure is non-fatal */ });

    // Reset PTT state so the next press starts fresh
    ptt.reset();
    setSession((prev) => ({
      ...prev,
      partialTranscript: '',
      audioBlob: null,
      // Keep finalTranscript so user can edit it in REDO
    }));
  }, [ptt, saveDraftMutation, clearAutoSend]);

  const retryMicrophone = useCallback(async () => {
    const granted = await ptt.requestPermission();
    if (granted) {
      const state = machineStateRef.current;
      // Return from MEDIA_ERROR to AWAITING_INPUT so the interview can continue
      if (state === 'MEDIA_ERROR') {
        setMachineState('AWAITING_INPUT');
      }
    }
  }, [ptt]);

  const onTranscriptFocus = useCallback(() => {
    clearAutoSend();
  }, [clearAutoSend]);

  const onTranscriptBlur = useCallback(() => {
    // Restart auto-send if we're still in REVIEW and have a transcript
    if (
      machineStateRef.current === 'REVIEW' &&
      sessionRef.current.finalTranscript !== null
    ) {
      startAutoSend();
    }
  }, [startAutoSend]);

  const retryLLM = useCallback(() => {
    if (machineStateRef.current !== 'ERROR') return;
    // Clear error and return to PROCESSING — SSE reconnects and backend retries the LLM call
    setSession((prev) => ({ ...prev, errorMessage: null }));
    setMachineState('PROCESSING');
  }, []);

  return {
    state: machineState,
    session,
    actions: {
      startInterview,
      abandonAndStart,
      submitText,
      skipQuestion,
      pauseInterview,
      resumeInterview,
      endInterview,
      continueFromCompletion,
      pressPTT,
      releasePTT,
      submitVoice,
      updateFinalTranscript,
      submitEditedTranscript,
      redo,
      retryMicrophone,
      onTranscriptFocus,
      onTranscriptBlur,
      retryLLM,
    },
  };
}
