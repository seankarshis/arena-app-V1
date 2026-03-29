'use client';

import { useEffect, useRef } from 'react';
import { getIdToken, getBypassUserId } from '@/lib/auth';

const isBypass = process.env.NEXT_PUBLIC_COGNITO_BYPASS === 'true';

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
  onReconnecting?: (attempt: number) => void;
  onError?: () => void;
  enabled: boolean;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const MAX_RECONNECT_ATTEMPTS = 3;

export function useSSE({
  interviewId,
  onMessage,
  onConnected,
  onReconnecting,
  onError,
  enabled,
}: UseSSEOptions): void {
  // Keep callbacks in refs so they never cause the effect to re-run
  const onMessageRef = useRef(onMessage);
  const onConnectedRef = useRef(onConnected);
  const onReconnectingRef = useRef(onReconnecting);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onConnectedRef.current = onConnected;
  onReconnectingRef.current = onReconnecting;
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

      const url = new URL(`${API_BASE}/api/interview/${interviewId}/stream`);
      if (isBypass) {
        const bypassUserId = getBypassUserId();
        if (bypassUserId) url.searchParams.set('mock-user-id', bypassUserId);
      } else {
        const token = await getIdToken();
        if (cancelled) return;
        if (token !== null) url.searchParams.set('token', token);
      }

      console.log('[useSSE] connecting to', url.toString().replace(/token=[^&]+/, 'token=REDACTED'));
      const eventSource = new EventSource(url.toString());
      es = eventSource;

      eventSource.onopen = () => {
        console.log('[useSSE] connected interviewId=%s', interviewId);
        reconnectAttempts = 0;
        onConnectedRef.current?.();
      };

      eventSource.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as SSEMessage;
          if (msg.type !== 'token') {
            console.log('[useSSE] message type=%s', msg.type, msg);
          }
          onMessageRef.current(msg);
        } catch {
          console.warn('[useSSE] malformed message:', event.data);
        }
      };

      eventSource.onerror = (event) => {
        console.error('[useSSE] error event interviewId=%s readyState=%d attempt=%d/%d', interviewId, eventSource.readyState, reconnectAttempts, MAX_RECONNECT_ATTEMPTS, event);
        if (cancelled) return;
        eventSource.close();
        if (es === eventSource) es = null;

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = Math.pow(2, reconnectAttempts) * 1000;
          reconnectAttempts++;
          console.warn('[useSSE] reconnecting in %dms (attempt %d/%d)', delay, reconnectAttempts, MAX_RECONNECT_ATTEMPTS);
          onReconnectingRef.current?.(reconnectAttempts);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connectSSE();
          }, delay);
        } else {
          console.error('[useSSE] max reconnect attempts reached — giving up interviewId=%s', interviewId);
          onErrorRef.current?.();
        }
      };
    };

    void connectSSE();

    return cleanup;
  }, [enabled, interviewId]);
}
