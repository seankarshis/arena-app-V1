// ---------------------------------------------------------------------------
// Integration Tests — Inactivity Handler (inactivityHandler.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Module mocks — declared before any imports from mocked modules
// ---------------------------------------------------------------------------

vi.mock('../services/session', () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('../sse/stream', () => ({
  getSSEConnection: vi.fn(),
}));

vi.mock('../services/interviewSession', () => ({
  pauseInterview: vi.fn(),
}));

import {
  startInactivityMonitor,
  stopInactivityMonitor,
  recordActivity,
  recordHeartbeat,
  inactivityPlugin,
  _monitors,
  IDLE_WARN_MS,
  AUTO_PAUSE_MS,
  HEARTBEAT_TIMEOUT_MS,
  CHECK_INTERVAL_MS,
} from '../services/inactivityHandler';
import { getSession, updateSession } from '../services/session';
import { getSSEConnection } from '../sse/stream';
import { pauseInterview } from '../services/interviewSession';
import type { InterviewSession } from '../services/session';
import { createCognitoAuthHook } from '../middleware/auth';

const mockGetSession = vi.mocked(getSession);
const mockUpdateSession = vi.mocked(updateSession);
const mockGetSSEConnection = vi.mocked(getSSEConnection);
const mockPauseInterview = vi.mocked(pauseInterview);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERVIEW_ID = 'interview-inactivity-test';
const USER_ID = '00000000-0000-0000-0000-000000000001'; // COGNITO_BYPASS default

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    interviewId: INTERVIEW_ID,
    templateId: 'template-1',
    userId: USER_ID,
    conversationHistory: [],
    questionsAsked: [],
    questionsSkipped: [],
    bucketsCovered: {},
    requiredRemaining: [],
    optionalRemaining: [],
    triggeredFollowups: [],
    currentTranscriptBuffer: '',
    currentDrafts: [],
    totalExpectedQuestions: 5,
    questionsCompleted: 0,
    lastActivityAt: new Date().toISOString(),
    idleWarningShown: false,
    isStreaming: false,
    currentTurnLlmText: null,
    ...overrides,
  };
}

function makeConn() {
  return { send: vi.fn(), close: vi.fn() };
}

function makeLlmClient(response = 'Take your time, there is no rush.') {
  return {
    stream: vi.fn().mockImplementation(
      async ({ onToken }: { onToken: (t: string) => void }) => {
        onToken(response);
        return {
          fullContent: response,
          model: 'claude-sonnet-4-20250514',
          promptTokens: 10,
          completionTokens: 10,
          latencyMs: 50,
        };
      },
    ),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePrisma(): any {
  return {};
}

function cleanupMonitors() {
  for (const id of [..._monitors.keys()]) {
    stopInactivityMonitor(id);
  }
}

// ---------------------------------------------------------------------------
// startInactivityMonitor / stopInactivityMonitor
// ---------------------------------------------------------------------------

describe('startInactivityMonitor / stopInactivityMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanupMonitors();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('registers a monitor entry', () => {
    startInactivityMonitor(INTERVIEW_ID, {
      prisma: makePrisma(),
      llmClient: makeLlmClient(),
    });
    expect(_monitors.has(INTERVIEW_ID)).toBe(true);
  });

  it('replaces an existing monitor (idempotent)', () => {
    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    const first = _monitors.get(INTERVIEW_ID);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    const second = _monitors.get(INTERVIEW_ID);

    expect(_monitors.size).toBe(1);
    expect(second).not.toBe(first);
  });

  it('removes the monitor entry on stop', () => {
    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    stopInactivityMonitor(INTERVIEW_ID);
    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });

  it('is safe to stop a non-existent monitor', () => {
    expect(() => stopInactivityMonitor('no-such-interview')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// recordActivity
// ---------------------------------------------------------------------------

describe('recordActivity', () => {
  afterEach(() => vi.clearAllMocks());

  it('updates lastActivityAt and resets idleWarningShown in Redis', async () => {
    mockUpdateSession.mockResolvedValue(null);

    await recordActivity(INTERVIEW_ID);

    expect(mockUpdateSession).toHaveBeenCalledOnce();
    const [id, patch] = mockUpdateSession.mock.calls[0] as [string, Partial<InterviewSession>];
    expect(id).toBe(INTERVIEW_ID);
    expect(patch.idleWarningShown).toBe(false);
    expect(typeof patch.lastActivityAt).toBe('string');
    expect(new Date(patch.lastActivityAt!).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// ---------------------------------------------------------------------------
// recordHeartbeat
// ---------------------------------------------------------------------------

describe('recordHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanupMonitors();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('is a no-op when no monitor is registered', () => {
    expect(() => recordHeartbeat(INTERVIEW_ID)).not.toThrow();
  });

  it('sets a heartbeat timeout timer on the monitor', () => {
    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    expect(_monitors.get(INTERVIEW_ID)!.heartbeatTimer).toBeNull();

    recordHeartbeat(INTERVIEW_ID);
    expect(_monitors.get(INTERVIEW_ID)!.heartbeatTimer).not.toBeNull();
  });

  it('replaces an existing heartbeat timer on subsequent calls', () => {
    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    recordHeartbeat(INTERVIEW_ID);
    const first = _monitors.get(INTERVIEW_ID)!.heartbeatTimer;

    recordHeartbeat(INTERVIEW_ID);
    const second = _monitors.get(INTERVIEW_ID)!.heartbeatTimer;

    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// Inactivity check — idle_prompt at 60 s
// ---------------------------------------------------------------------------

describe('inactivity check — idle_prompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanupMonitors();
    vi.useRealTimers();
  });

  it('sends idle_prompt and appends to conversationHistory when idle for 60 s', async () => {
    // lastActivityAt is 61 s before fake-clock start
    const lastActivityAt = new Date(Date.now() - IDLE_WARN_MS - 1000).toISOString();
    const session = makeSession({ lastActivityAt });
    const conn = makeConn();
    const llm = makeLlmClient('Can I rephrase that for you?');

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);
    mockUpdateSession.mockResolvedValue(null);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: llm });

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    // LLM called once
    expect(llm.stream).toHaveBeenCalledOnce();

    // idle_prompt SSE event sent
    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'idle_prompt',
        content: 'Can I rephrase that for you?',
        questionId: null,
      }),
    );

    // idleWarningShown flagged true in Redis
    const updateCalls = mockUpdateSession.mock.calls as Array<[string, Partial<InterviewSession>]>;
    const idleFlagCall = updateCalls.find(([, p]) => p.idleWarningShown === true);
    expect(idleFlagCall).toBeDefined();

    // conversationHistory updated with idle_prompt entry
    const historyCall = updateCalls.find(([, p]) => Array.isArray(p.conversationHistory));
    expect(historyCall).toBeDefined();
    const history = historyCall![1].conversationHistory!;
    expect(history[history.length - 1]).toMatchObject({
      role: 'assistant',
      content: 'Can I rephrase that for you?',
      type: 'idle_prompt',
    });
  });

  it('does NOT send idle_prompt when LLM is actively streaming', async () => {
    const lastActivityAt = new Date(Date.now() - IDLE_WARN_MS - 1000).toISOString();
    const session = makeSession({ lastActivityAt, isStreaming: true });
    const conn = makeConn();
    const llm = makeLlmClient();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: llm });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(llm.stream).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('does NOT send idle_prompt when idleWarningShown is already true', async () => {
    const lastActivityAt = new Date(Date.now() - IDLE_WARN_MS - 1000).toISOString();
    const session = makeSession({ lastActivityAt, idleWarningShown: true });
    const conn = makeConn();
    const llm = makeLlmClient();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: llm });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(llm.stream).not.toHaveBeenCalled();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('does NOT fire twice if the check runs again before the LLM call finishes', async () => {
    const lastActivityAt = new Date(Date.now() - IDLE_WARN_MS - 1000).toISOString();
    const session = makeSession({ lastActivityAt });
    const conn = makeConn();

    // Slow LLM — resolves after 15 s of fake time
    let resolveLlm!: () => void;
    const slowLlm = {
      stream: vi.fn().mockImplementation(
        ({ onToken }: { onToken: (t: string) => void }) =>
          new Promise<ReturnType<typeof makeLlmClient>['stream']>((resolve) => {
            resolveLlm = () => {
              onToken('Still here?');
              resolve({
                fullContent: 'Still here?',
                model: 'claude-sonnet-4-20250514',
                promptTokens: 5,
                completionTokens: 5,
                latencyMs: 50,
              });
            };
          }),
      ),
    };

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);
    mockUpdateSession.mockResolvedValue(null);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: slowLlm });

    // First check fires and starts the LLM call (doesn't resolve yet)
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await Promise.resolve(); // allow the async check to start

    // Second check fires while first LLM call is still in progress
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await Promise.resolve();

    // Resolve the slow LLM
    resolveLlm();
    await vi.advanceTimersByTimeAsync(0);

    // LLM called exactly once despite two interval firings
    expect(slowLlm.stream).toHaveBeenCalledOnce();
  });

  it('stops the monitor when the Redis session is missing', async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetSSEConnection.mockReturnValue(makeConn() as ReturnType<typeof makeConn>);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });

  it('stops the monitor when the SSE connection is gone', async () => {
    const session = makeSession({
      lastActivityAt: new Date(Date.now() - 1000).toISOString(),
    });
    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(undefined);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inactivity check — auto-pause at 3 min
// ---------------------------------------------------------------------------

describe('inactivity check — auto-pause at 3 min', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanupMonitors();
    vi.useRealTimers();
  });

  it('sends auto_paused SSE event and calls pauseInterview after 3 min idle', async () => {
    const lastActivityAt = new Date(Date.now() - AUTO_PAUSE_MS - 1000).toISOString();
    const session = makeSession({ lastActivityAt });
    const conn = makeConn();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);
    mockPauseInterview.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });

    const prisma = makePrisma();
    startInactivityMonitor(INTERVIEW_ID, { prisma, llmClient: makeLlmClient() });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auto_paused', reason: 'inactivity', resumeAvailable: true }),
    );
    expect(mockPauseInterview).toHaveBeenCalledWith(prisma, USER_ID, INTERVIEW_ID);
    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });

  it('auto-pause takes precedence over idle_prompt when both thresholds are exceeded', async () => {
    // More than 3 minutes idle — should auto-pause, not send idle_prompt
    const lastActivityAt = new Date(Date.now() - AUTO_PAUSE_MS - 5000).toISOString();
    const session = makeSession({ lastActivityAt });
    const conn = makeConn();
    const llm = makeLlmClient();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);
    mockPauseInterview.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: llm });
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    // LLM not called (no idle_prompt)
    expect(llm.stream).not.toHaveBeenCalled();

    // auto_paused sent, not idle_prompt
    const sendCalls = (conn.send as ReturnType<typeof vi.fn>).mock.calls as Array<[{ type: string }]>;
    expect(sendCalls.some(([e]) => e.type === 'auto_paused')).toBe(true);
    expect(sendCalls.some(([e]) => e.type === 'idle_prompt')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat timeout — auto-pause at 5 min without heartbeat
// ---------------------------------------------------------------------------

describe('heartbeat timeout — auto-pause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanupMonitors();
    vi.useRealTimers();
  });

  it('auto-pauses when heartbeat stops for 5 min', async () => {
    // isStreaming=true prevents inactivity checks from interfering
    const session = makeSession({ isStreaming: true });
    const conn = makeConn();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);
    mockPauseInterview.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });

    const prisma = makePrisma();
    startInactivityMonitor(INTERVIEW_ID, { prisma, llmClient: makeLlmClient() });
    recordHeartbeat(INTERVIEW_ID);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1000);

    expect(conn.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auto_paused', reason: 'heartbeat_timeout' }),
    );
    expect(mockPauseInterview).toHaveBeenCalledWith(prisma, USER_ID, INTERVIEW_ID);
    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });

  it('does NOT auto-pause when heartbeat is refreshed before the timeout', async () => {
    const session = makeSession({ isStreaming: true });
    const conn = makeConn();

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(conn as ReturnType<typeof makeConn>);

    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    recordHeartbeat(INTERVIEW_ID); // sets timeout at T+300s

    // Refresh just before timeout fires
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS - 5000); // T+295s
    recordHeartbeat(INTERVIEW_ID); // resets timeout to T+595s

    // Advance past the original deadline (T+300s) — timer was cleared so no pause
    await vi.advanceTimersByTimeAsync(5001); // now T+300001ms

    expect(mockPauseInterview).not.toHaveBeenCalled();
    const sendCalls = (conn.send as ReturnType<typeof vi.fn>).mock.calls as Array<[{ type: string }]>;
    expect(sendCalls.some(([e]) => e.type === 'auto_paused')).toBe(false);
  });

  it('auto-pauses in DB even when SSE connection is gone at timeout', async () => {
    const session = makeSession({ isStreaming: true });

    mockGetSession.mockResolvedValue(session);
    mockGetSSEConnection.mockReturnValue(undefined); // no SSE conn
    mockPauseInterview.mockResolvedValue({
      id: INTERVIEW_ID,
      status: 'paused',
      pausedAt: new Date().toISOString(),
    });

    const prisma = makePrisma();
    startInactivityMonitor(INTERVIEW_ID, { prisma, llmClient: makeLlmClient() });
    recordHeartbeat(INTERVIEW_ID);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1000);

    expect(mockPauseInterview).toHaveBeenCalledWith(prisma, USER_ID, INTERVIEW_ID);
    expect(_monitors.has(INTERVIEW_ID)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/heartbeat — Fastify plugin
// ---------------------------------------------------------------------------

describe('POST /api/heartbeat', () => {
  const savedEnv = { ...process.env };

  async function buildApp(envOverrides: Record<string, string> = {}) {
    Object.assign(process.env, { COGNITO_BYPASS: 'true', ...envOverrides });
    const app = Fastify({ logger: false });
    app.addHook('onRequest', createCognitoAuthHook({} as any));
    await app.register(inactivityPlugin);
    await app.ready();
    return app;
  }

  afterEach(async () => {
    vi.useRealTimers();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    cleanupMonitors();
    vi.clearAllMocks();
  });

  it('returns 401 without a Bearer token', async () => {
    const app = await buildApp({
      COGNITO_BYPASS: 'false',
      COGNITO_USER_POOL_ID: 'us-east-2_test',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { interviewId: INTERVIEW_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when interviewId is missing from the body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: {},
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errors: [expect.objectContaining({ extensions: { code: 'VALIDATION_ERROR' } })],
    });
  });

  it('returns 404 when no Redis session exists for the interview', async () => {
    mockGetSession.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { interviewId: INTERVIEW_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errors: [expect.objectContaining({ extensions: { code: 'NOT_FOUND' } })],
    });
  });

  it('returns 403 when session belongs to a different user', async () => {
    mockGetSession.mockResolvedValue(makeSession({ userId: 'other-user-id' }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { interviewId: INTERVIEW_ID },
    });
    await app.close();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errors: [expect.objectContaining({ extensions: { code: 'FORBIDDEN' } })],
    });
  });

  it('returns 200, updates lastActivityAt, and resets the heartbeat timer', async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockUpdateSession.mockResolvedValue(null);

    // Start monitor before app so we can inspect the heartbeat timer after the request.
    startInactivityMonitor(INTERVIEW_ID, { prisma: makePrisma(), llmClient: makeLlmClient() });
    expect(_monitors.get(INTERVIEW_ID)?.heartbeatTimer).toBeNull(); // initially unset

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { interviewId: INTERVIEW_ID },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // lastActivityAt updated in Redis
    expect(mockUpdateSession).toHaveBeenCalledWith(
      INTERVIEW_ID,
      expect.objectContaining({ lastActivityAt: expect.any(String) }),
    );

    // Heartbeat timer was set on the monitor by recordHeartbeat
    expect(_monitors.get(INTERVIEW_ID)?.heartbeatTimer).not.toBeNull();
  });

  it('returns 200 even when no inactivity monitor is active (heartbeat is a no-op)', async () => {
    mockGetSession.mockResolvedValue(makeSession());
    mockUpdateSession.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/heartbeat',
      payload: { interviewId: INTERVIEW_ID },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
