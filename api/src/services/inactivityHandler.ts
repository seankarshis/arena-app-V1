// ---------------------------------------------------------------------------
// Arena Inactivity Handler
// Idle timer, idle_prompt SSE events, heartbeat, and auto-pause.
// ---------------------------------------------------------------------------

import pino from 'pino';
import type { FastifyPluginAsync } from 'fastify';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
import type { PrismaClient } from '@prisma/client';
import type { SSEConnection, StreamingLlmClient } from '../sse/stream';
import { getSession, updateSession, type InterviewSession } from './session';
import { getSSEConnection } from '../sse/stream';
import { pauseInterview } from './interviewSession';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Idle duration before an idle_prompt LLM call is triggered. */
export const IDLE_WARN_MS = 60_000; // 60 seconds

/** Total idle duration before the interview is auto-paused. */
export const AUTO_PAUSE_MS = 3 * 60_000; // 3 minutes

/** Duration without a frontend heartbeat before the interview is auto-paused. */
export const HEARTBEAT_TIMEOUT_MS = 5 * 60_000; // 5 minutes

/** How often the background inactivity check runs (per SSE connection). */
export const CHECK_INTERVAL_MS = 10_000; // 10 seconds

// ---------------------------------------------------------------------------
// Per-interview monitor state
// ---------------------------------------------------------------------------

interface MonitorState {
  checkTimer: ReturnType<typeof setInterval>;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  prisma: PrismaClient;
  llmClient: StreamingLlmClient;
  /** Guards against concurrent idle prompt generation. */
  idlePromptInProgress: boolean;
}

/**
 * In-memory map of active inactivity monitors (one per interview session).
 * Exported with underscore prefix for testing only.
 */
export const _monitors = new Map<string, MonitorState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StartMonitorOptions {
  prisma: PrismaClient;
  llmClient: StreamingLlmClient;
}

/**
 * Start an inactivity monitor for the given interview session.
 * Idempotent — stops any existing monitor before starting a new one.
 * Call this after establishing the SSE connection.
 */
export function startInactivityMonitor(
  interviewId: string,
  opts: StartMonitorOptions,
): void {
  stopInactivityMonitor(interviewId);

  // Use an async callback so advanceTimersByTimeAsync can await it in tests.
  const checkTimer = setInterval(async () => {
    await runInactivityCheck(interviewId);
  }, CHECK_INTERVAL_MS);

  _monitors.set(interviewId, {
    checkTimer,
    heartbeatTimer: null,
    prisma: opts.prisma,
    llmClient: opts.llmClient,
    idlePromptInProgress: false,
  });
}

/** Stop and clean up the inactivity monitor for the given interview. */
export function stopInactivityMonitor(interviewId: string): void {
  const state = _monitors.get(interviewId);
  if (!state) return;

  clearInterval(state.checkTimer);
  if (state.heartbeatTimer !== null) {
    clearTimeout(state.heartbeatTimer);
  }
  _monitors.delete(interviewId);
}

/**
 * Record user activity after each LLM response (stream_complete).
 * Resets `lastActivityAt` in the Redis session and clears `idleWarningShown`.
 */
export async function recordActivity(interviewId: string): Promise<void> {
  await updateSession(interviewId, {
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
  });
}

/**
 * Record a frontend heartbeat, resetting the 5-minute heartbeat timeout.
 * The heartbeat endpoint calls this after updating `lastActivityAt` in Redis.
 */
export function recordHeartbeat(interviewId: string): void {
  const state = _monitors.get(interviewId);
  if (!state) return;

  if (state.heartbeatTimer !== null) {
    clearTimeout(state.heartbeatTimer);
  }

  // Use an async callback so advanceTimersByTimeAsync can await it in tests.
  state.heartbeatTimer = setTimeout(async () => {
    await onHeartbeatTimeout(interviewId);
  }, HEARTBEAT_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Internal: background inactivity check
// ---------------------------------------------------------------------------

async function runInactivityCheck(interviewId: string): Promise<void> {
  const state = _monitors.get(interviewId);
  if (!state) return;

  const session = await getSession(interviewId);
  if (!session) {
    stopInactivityMonitor(interviewId);
    return;
  }

  // Do not interrupt an active LLM streaming turn.
  if (session.isStreaming) return;

  const conn = getSSEConnection(interviewId);
  if (!conn) {
    stopInactivityMonitor(interviewId);
    return;
  }

  const idleDurationMs = Date.now() - new Date(session.lastActivityAt).getTime();

  if (idleDurationMs >= AUTO_PAUSE_MS) {
    await triggerAutoPause(interviewId, session.userId, conn, state.prisma, 'inactivity');
    stopInactivityMonitor(interviewId);
  } else if (
    idleDurationMs >= IDLE_WARN_MS &&
    !session.idleWarningShown &&
    !state.idlePromptInProgress
  ) {
    state.idlePromptInProgress = true;
    try {
      await triggerIdlePrompt(interviewId, session, conn, state);
    } finally {
      state.idlePromptInProgress = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal: idle prompt
// ---------------------------------------------------------------------------

async function triggerIdlePrompt(
  interviewId: string,
  session: InterviewSession,
  conn: SSEConnection,
  state: MonitorState,
): Promise<void> {
  // Mark idleWarningShown before the LLM call to block concurrent triggers.
  await updateSession(interviewId, { idleWarningShown: true });

  try {
    let content = '';
    await state.llmClient.stream({
      system:
        'You are a warm, professional interviewer. The interviewee has been quiet for a minute. ' +
        'Generate a brief, warm prompt to re-engage them. You may offer to rephrase the current ' +
        'question. Keep it to one or two sentences.',
      messages: session.conversationHistory.map((e) => ({
        role: e.role as 'user' | 'assistant',
        content: e.content,
      })),
      onToken: (token) => {
        content += token;
      },
    });

    if (!content) return;

    conn.send({ type: 'idle_prompt', content, questionId: null });

    // Re-fetch the session to get the latest history before appending.
    const latest = await getSession(interviewId);
    if (latest) {
      await updateSession(interviewId, {
        conversationHistory: [
          ...latest.conversationHistory,
          { role: 'assistant', content, type: 'idle_prompt' },
        ],
      });
    }
  } catch (err) {
    log.error({ interviewId, err: err instanceof Error ? err.message : String(err) }, '[InactivityHandler] Failed to generate idle prompt');
  }
}

// ---------------------------------------------------------------------------
// Internal: auto-pause
// ---------------------------------------------------------------------------

async function triggerAutoPause(
  interviewId: string,
  userId: string,
  conn: SSEConnection,
  prisma: PrismaClient,
  reason: 'inactivity' | 'heartbeat_timeout',
): Promise<void> {
  conn.send({ type: 'auto_paused', reason, resumeAvailable: true });

  try {
    await pauseInterview(prisma, userId, interviewId);
  } catch (err) {
    log.error({ interviewId, reason, err: err instanceof Error ? err.message : String(err) }, '[InactivityHandler] Failed to auto-pause interview');
  }
}

// ---------------------------------------------------------------------------
// Internal: heartbeat timeout
// ---------------------------------------------------------------------------

async function onHeartbeatTimeout(interviewId: string): Promise<void> {
  const state = _monitors.get(interviewId);
  if (!state) return;

  const session = await getSession(interviewId);
  if (!session) {
    stopInactivityMonitor(interviewId);
    return;
  }

  const conn = getSSEConnection(interviewId);
  if (conn) {
    await triggerAutoPause(
      interviewId,
      session.userId,
      conn,
      state.prisma,
      'heartbeat_timeout',
    );
  } else {
    // SSE connection is gone but we still pause the interview in the DB.
    try {
      await pauseInterview(state.prisma, session.userId, interviewId);
    } catch (err) {
      log.error({ interviewId, err: err instanceof Error ? err.message : String(err) }, '[InactivityHandler] Failed to auto-pause interview (heartbeat timeout, no SSE conn)');
    }
  }

  stopInactivityMonitor(interviewId);
}

// ---------------------------------------------------------------------------
// Fastify plugin — POST /api/heartbeat
// ---------------------------------------------------------------------------

/**
 * Registers POST /api/heartbeat.
 *
 * The frontend calls this every 30 seconds while in AWAITING_INPUT state.
 * Resets `lastActivityAt` in Redis and refreshes the per-interview heartbeat
 * timeout that auto-pauses the session if the tab is closed.
 */
export const inactivityPlugin: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { interviewId: string } }>(
    '/api/heartbeat',
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        return reply.code(401).send({
          errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }],
        });
      }

      const interviewId = (request.body as { interviewId?: string } | null)?.interviewId;
      if (!interviewId) {
        return reply.code(400).send({
          errors: [{ message: 'interviewId is required', extensions: { code: 'VALIDATION_ERROR' } }],
        });
      }

      const session = await getSession(interviewId);
      if (!session) {
        return reply.code(404).send({
          errors: [{ message: 'Session not found', extensions: { code: 'NOT_FOUND' } }],
        });
      }

      if (session.userId !== user.userId) {
        return reply.code(403).send({
          errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
        });
      }

      await updateSession(interviewId, {
        lastActivityAt: new Date().toISOString(),
      });

      recordHeartbeat(interviewId);

      return reply.code(200).send({ ok: true });
    },
  );
};
