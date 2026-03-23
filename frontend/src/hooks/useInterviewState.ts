'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useMutation, gql } from '@apollo/client';
import { useSSE, type SSEMessage } from './useSSE';
import { usePTT } from './usePTT';
import { audioUploadQueue } from '@/lib/audioUploadQueue';

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
}

export interface InterviewActions {
  startInterview: () => Promise<void>;
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
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const START_INTERVIEW = gql`
  mutation StartInterview($templateId: ID!) {
    startInterview(templateId: $templateId) {
      interviewId
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
  startInterview: { interviewId: string };
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

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const [startInterviewMutation] = useMutation<
    StartInterviewResult,
    { templateId: string }
  >(START_INTERVIEW);

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
        if (msg.interviewComplete) {
          // LLM-initiated completion: show closing message, let user decide
          setSession((prev) => ({
            ...prev,
            streamingText: '',
            currentQuestion: msg.fullResponse,
            progressPercent: msg.progressPercent,
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
        setSession((prev) => ({ ...prev, errorMessage: msg.message }));
        setMachineState('ERROR');
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
    }));
    setMachineState('ERROR');
  }, []);

  useSSE({
    interviewId: session.interviewId || null,
    onMessage: handleSSEMessage,
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
    setMachineState('STARTING');
    try {
      const result = await startInterviewMutation({ variables: { templateId } });
      const interviewId = result.data?.startInterview.interviewId;
      if (!interviewId) throw new Error('No interview ID returned from server');
      // Set interviewId and startedAt first — SSE enabled check reads interviewId
      setSession((prev) => ({ ...prev, interviewId, startedAt: new Date() }));

      // Eagerly request microphone permission (non-blocking — interview continues on failure)
      ptt.requestPermission().catch(() => { /* microphoneError set in session by effect */ });

      // LLM_STREAMING enables SSE; backend streams the first question immediately
      setMachineState('LLM_STREAMING');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to start interview';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    }
  }, [templateId, startInterviewMutation, ptt]);

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
      }
    },
    [submitResponseMutation]
  );

  const skipQuestion = useCallback(async () => {
    const state = machineStateRef.current;
    const currentSession = sessionRef.current;
    if (state !== 'AWAITING_INPUT' && state !== 'IDLE_WARNING') return;
    if (!currentSession.interviewId) return;

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

  return {
    state: machineState,
    session,
    actions: {
      startInterview,
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
    },
  };
}
