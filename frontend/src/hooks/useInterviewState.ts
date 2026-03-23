'use client';

import { useState, useCallback, useRef } from 'react';
import { useMutation, gql } from '@apollo/client';
import { useSSE, type SSEMessage } from './useSSE';

// ---------------------------------------------------------------------------
// State machine states
// ---------------------------------------------------------------------------

export type InterviewState =
  | 'READY'
  | 'STARTING'
  | 'AWAITING_INPUT'
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

// ---------------------------------------------------------------------------
// Mutation result types (for type-safe data access)
// ---------------------------------------------------------------------------

interface StartInterviewResult {
  startInterview: { interviewId: string };
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
  });

  // Refs for reading current values inside callbacks without stale closures
  const machineStateRef = useRef(machineState);
  const sessionRef = useRef(session);
  machineStateRef.current = machineState;
  sessionRef.current = session;

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  const [startInterviewMutation] = useMutation<
    StartInterviewResult,
    { templateId: string }
  >(START_INTERVIEW);

  const [submitResponseMutation] = useMutation<
    unknown,
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
      // LLM_STREAMING enables SSE; backend streams the first question immediately
      setMachineState('LLM_STREAMING');
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to start interview';
      setSession((prev) => ({ ...prev, errorMessage }));
      setMachineState('ERROR');
    }
  }, [templateId, startInterviewMutation]);

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
      // In text-only mode there are no pending audio uploads; transition immediately
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
    },
  };
}
