'use client';

import { useEffect, useRef } from 'react';
import { getIdToken } from '@/lib/auth';

export type SSEMessage =
  | { type: 'token'; content: string }
  | { type: 'sentence_complete'; sentence: string; sentenceIndex: number }
  | {
      type: 'stream_complete';
      fullResponse: string;
      questionId: string | null;
      sequenceNumber: number;
      isFollowup: boolean;
      interviewComplete: boolean;
      progressPercent: number;
      closingMessage?: boolean;
    }
  | { type: 'idle_prompt'; content: string; questionId: string | null }
  | { type: 'auto_paused'; reason: string; resumeAvailable: boolean }
  | { type: 'error'; message: string; retryable: boolean };

interface UseSSEOptions {
  interviewId: string | null;
  onMessage: (msg: SSEMessage) => void;
  onConnected?: () => void;
  onError?: () => void;
  enabled: boolean;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const MAX_RECONNECT_ATTEMPTS = 3;

export function useSSE({
  interviewId,
  onMessage,
  onConnected,
  onError,
  enabled,
}: UseSSEOptions): void {
  // Keep callbacks in refs so they never cause the effect to re-run
  const onMessageRef = useRef(onMessage);
  const onConnectedRef = useRef(onConnected);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onConnectedRef.current = onConnected;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !interviewId) return;

    let es: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const cleanup = () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es !== null) {
        es.close();
        es = null;
      }
    };

    const connectSSE = async () => {
      if (cancelled) return;

      if (es !== null) {
        es.close();
        es = null;
      }

      const token = await getIdToken();
      if (cancelled) return;

      const url = new URL(`${API_BASE}/api/interview/${interviewId}/stream`);
      if (token !== null) url.searchParams.set('token', token);

      const eventSource = new EventSource(url.toString());
      es = eventSource;

      eventSource.onopen = () => {
        reconnectAttempts = 0;
        onConnectedRef.current?.();
      };

      eventSource.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as SSEMessage;
          onMessageRef.current(msg);
        } catch {
          // ignore malformed messages
        }
      };

      eventSource.onerror = () => {
        if (cancelled) return;
        eventSource.close();
        if (es === eventSource) es = null;

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.pow(2, reconnectAttempts) * 1000;
          reconnectAttempts++;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectSSE();
          }, delay);
        } else {
          onErrorRef.current?.();
        }
      };
    };

    void connectSSE();

    return cleanup;
  }, [enabled, interviewId]);
}
