'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { getIdToken } from '@/lib/auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PTTPhase = 'idle' | 'connecting' | 'recording' | 'stopping';

export interface PTTHook {
  phase: PTTPhase;
  partialTranscript: string;
  /** Set when STT sends final_transcript; null if WS failed or not yet received */
  finalTranscript: string | null;
  /** Captured audio Blob; set when MediaRecorder stops */
  audioBlob: Blob | null;
  /** True when recording has passed the 4-minute warning threshold */
  nearingTimeLimit: boolean;
  /** Non-null when microphone acquisition fails */
  microphoneError: string | null;
  /** Eagerly request microphone permission (call on interview start) */
  requestPermission: () => Promise<boolean>;
  /** Press PTT: acquire mic, start MediaRecorder, open STT WebSocket.
   *  Returns false if microphone is unavailable. */
  start: (interviewId: string) => Promise<boolean>;
  /** Release PTT: stop MediaRecorder and await final transcript */
  stop: () => void;
  /** Reset all PTT state back to idle (call before a new recording attempt) */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STT_WS_BASE =
  process.env.NEXT_PUBLIC_STT_WS_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/stt`
    : 'ws://localhost:3001/stt');
const MAX_RECORDING_MS = 5 * 60 * 1000; // 5 minutes
const WARNING_MS = 4 * 60 * 1000;        // 4 minutes

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePTT(): PTTHook {
  const [phase, setPhase] = useState<PTTPhase>('idle');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [nearingTimeLimit, setNearingTimeLimit] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const pendingChunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReadyRef = useRef(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mimeTypeRef = useRef('audio/webm');
  const stoppedRef = useRef(false);

  // ---- cleanup helpers ----

  const clearTimers = useCallback(() => {
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    if (warnTimerRef.current) { clearTimeout(warnTimerRef.current); warnTimerRef.current = null; }
  }, []);

  const closeWS = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    wsReadyRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      closeWS();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
      }
    };
  }, [clearTimers, closeWS]);

  // ---- requestPermission ----

  const requestPermission = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicrophoneError(null);
      return true;
    } catch (err) {
      setMicrophoneError(micErrMsg(err as DOMException));
      return false;
    }
  }, []);

  // ---- stop ----

  const stop = useCallback(() => {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    clearTimers();
    setPhase('stopping');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
  }, [clearTimers]);

  // Keep a stable ref so the max-recording timer always calls the latest stop
  const stopRef = useRef(stop);
  useEffect(() => { stopRef.current = stop; }, [stop]);

  // ---- start ----

  const start = useCallback(async (interviewId: string): Promise<boolean> => {
    if (phase !== 'idle') return false;

    // Reset per-recording state
    setPartialTranscript('');
    setFinalTranscript(null);
    setAudioBlob(null);
    setNearingTimeLimit(false);
    chunksRef.current = [];
    pendingChunksRef.current = [];
    wsReadyRef.current = false;
    stoppedRef.current = false;

    setPhase('connecting');

    // Acquire microphone
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicrophoneError(null);
    } catch (err) {
      setMicrophoneError(micErrMsg(err as DOMException));
      setPhase('idle');
      return false;
    }

    // Create MediaRecorder
    const mimeType = pickMimeType();
    mimeTypeRef.current = mimeType || 'audio/webm';
    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      chunksRef.current.push(e.data);
      if (wsReadyRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(e.data);
      } else {
        pendingChunksRef.current.push(e.data);
      }
    };

    mr.onerror = () => {
      // Hardware failure mid-recording — capture what we have and surface the error
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
      setAudioBlob(blob);
      setMicrophoneError(
        'Your microphone became unavailable during recording. You can type your response or try again.'
      );
      stream.getTracks().forEach((t) => t.stop());
      clearTimers();
      closeWS();
      setPhase('idle');
    };

    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
      setAudioBlob(blob);
      stream.getTracks().forEach((t) => t.stop());

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Signal end of audio; final_transcript response will transition phase to idle
        wsRef.current.send(JSON.stringify({ type: 'audio_end' }));
      } else {
        // No WS — transition immediately (no transcript available)
        setPhase('idle');
      }
    };

    mr.start(250); // emit chunks every 250ms
    setPhase('recording');

    // Timers
    warnTimerRef.current = setTimeout(() => setNearingTimeLimit(true), WARNING_MS);
    maxTimerRef.current = setTimeout(() => stopRef.current(), MAX_RECORDING_MS);

    // Open authenticated STT WebSocket in parallel with recording
    try {
      const token = await getIdToken();
      const wsUrl = buildWsUrl(STT_WS_BASE, interviewId, token);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data as string) as Record<string, unknown>; }
        catch { return; }

        switch (msg['type']) {
          case 'session_ready':
            wsReadyRef.current = true;
            // Flush audio buffered during WS handshake
            for (const chunk of pendingChunksRef.current) ws.send(chunk);
            pendingChunksRef.current = [];
            break;

          case 'partial_transcript':
            setPartialTranscript((msg['text'] as string) ?? '');
            break;

          case 'final_transcript':
            setFinalTranscript((msg['text'] as string) ?? '');
            closeWS();
            setPhase('idle');
            break;

          case 'error':
            // STT service error — surface no transcript; recording Blob still captured
            closeWS();
            setPhase('idle');
            break;
        }
      };

      ws.onerror = () => {
        // Connection failed — MediaRecorder continues; onstop will transition to idle
        wsRef.current = null;
        wsReadyRef.current = false;
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
      };
    } catch {
      // getIdToken failed — proceed without STT (onstop will transition to idle)
    }

    return true;
  }, [phase, clearTimers, closeWS]);

  // ---- reset ----

  const reset = useCallback(() => {
    clearTimers();
    closeWS();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    pendingChunksRef.current = [];
    stoppedRef.current = false;
    setPhase('idle');
    setPartialTranscript('');
    setFinalTranscript(null);
    setAudioBlob(null);
    setNearingTimeLimit(false);
  }, [clearTimers, closeWS]);

  return {
    phase,
    partialTranscript,
    finalTranscript,
    audioBlob,
    nearingTimeLimit,
    microphoneError,
    requestPermission,
    start,
    stop,
    reset,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function micErrMsg(err: DOMException): string {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Microphone access was denied. Please allow it in your browser settings to use voice input.';
    case 'NotFoundError':
      return 'No microphone detected. Please connect a microphone to use voice input, or type your responses.';
    case 'NotReadableError':
      return 'Your microphone is currently unavailable (it may be in use by another application). You can type your responses or try again.';
    default:
      return 'Microphone setup failed. You can type your responses or try again.';
  }
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function buildWsUrl(base: string, interviewId: string, token: string | null): string {
  const url = new URL(base);
  url.searchParams.set('interviewId', interviewId);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
