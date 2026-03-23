// ---------------------------------------------------------------------------
// STT WebSocket Proxy Tests — sttProxy
//
// Unit tests:  RelayBuffer burst-metering logic.
// Integration: WebSocket authentication (HTTP upgrade rejection / acceptance),
//              mock-mode transcript streaming, Redis transcript buffer update.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';

// ─── Module mocks (must be declared before any imports from mocked modules) ───

vi.mock('../middleware/auth', () => ({
  verifyToken: vi.fn(),
  getBypassUser: vi.fn(),
  cognitoAuthHook: vi.fn(),
  buildContext: vi.fn(),
  extractToken: vi.fn(),
  _fetchJwks: vi.fn(),
}));

vi.mock('../services/session', () => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  refreshSessionTTL: vi.fn(),
  setSessionPausedTTL: vi.fn(),
  buildInitialSession: vi.fn(),
  ACTIVE_SESSION_TTL: 14400,
  PAUSED_SESSION_TTL: 900,
}));

import { verifyToken, getBypassUser } from '../middleware/auth';
import { updateSession } from '../services/session';
import { sttProxy, RelayBuffer } from '../websocket/sttProxy';

// ─── Constants ────────────────────────────────────────────────────────────────

const MOCK_USER_ID = 'user-00000000-0000-0000-0000-000000000001';
const MOCK_INTERVIEW_ID = 'interview-00000000-0000-0000-0000-000000000001';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockPrisma(interviewOverride?: {
  id?: string;
  userId?: string;
  status?: string;
} | null) {
  const defaultInterview =
    interviewOverride === null
      ? null
      : {
          id: MOCK_INTERVIEW_ID,
          userId: MOCK_USER_ID,
          status: 'in_progress',
          ...interviewOverride,
        };

  return {
    interview: {
      findUnique: vi.fn().mockResolvedValue(defaultInterview),
    },
  };
}

type MockPrisma = ReturnType<typeof createMockPrisma>;

interface TestServer {
  app: FastifyInstance;
  port: number;
  close: () => Promise<void>;
}

async function createTestServer(prisma: MockPrisma): Promise<TestServer> {
  const app = Fastify({ logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await app.register(sttProxy, { prisma: prisma as any });
  await app.listen({ port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    port,
    close: () => app.close(),
  };
}

function wsConnect(port: number, params: Record<string, string>): WebSocket {
  const qs = new URLSearchParams(params).toString();
  return new WebSocket(`ws://localhost:${port}/stt?${qs}`);
}

/**
 * Resolves with the HTTP status code when the WebSocket upgrade is rejected
 * (i.e., the server returns a non-101 response).
 */
function waitForRejection(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timeout waiting for WebSocket rejection')),
      timeoutMs,
    );

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode ?? 0);
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      // `ws` may emit 'error' instead of 'unexpected-response' on some platforms.
      // We can still confirm rejection occurred; status code extraction is best-effort.
      const match = /(\d{3})/.exec(err.message);
      resolve(match ? parseInt(match[1], 10) : 0);
    });

    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('Expected upgrade rejection but connection was accepted'));
    });
  });
}

/**
 * Resolves with the parsed JSON of the first WebSocket message whose `type`
 * field matches `expectedType` (or the first message if no type is given).
 */
function waitForMessage(
  ws: WebSocket,
  expectedType?: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for message type=${expectedType ?? 'any'}`)),
      timeoutMs,
    );

    const handler = (raw: WebSocket.RawData): void => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (expectedType === undefined || msg.type === expectedType) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };

    ws.on('message', handler);
    ws.on('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed before message received')); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Collect N messages from a WebSocket, or fail after timeoutMs. */
function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 3000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const msgs: Record<string, unknown>[] = [];
    const timer = setTimeout(
      () => reject(new Error(`Timeout: collected ${msgs.length}/${count} messages`)),
      timeoutMs,
    );

    ws.on('message', (raw) => {
      try {
        msgs.push(JSON.parse(raw.toString()) as Record<string, unknown>);
        if (msgs.length >= count) {
          clearTimeout(timer);
          resolve(msgs);
        }
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    ws.on('close', () => { clearTimeout(timer); reject(new Error('WebSocket closed')); });
  });
}

// ─── RelayBuffer unit tests ────────────────────────────────────────────────────

describe('RelayBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues chunks in burst phase without forwarding', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    rb.push(Buffer.alloc(500));
    rb.push(Buffer.alloc(300));

    // No time has elapsed — nothing should have been forwarded yet.
    expect(forwarded).toHaveLength(0);
    expect(rb.isBursting).toBe(true);

    rb.destroy();
  });

  it('forwards chunks once enough time budget accumulates', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    // 12 000 bytes ≈ 1.5 s of audio at 64 kbps.
    // At 1.5× real-time, this needs 1 s to accumulate budget: 1 * 8000 * 1.5 = 12 000.
    rb.push(Buffer.alloc(12_000));

    // Advance 1 050 ms (50 ms past the 1 s threshold so the drain tick fires).
    vi.advanceTimersByTime(1_050);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].length).toBe(12_000);

    rb.destroy();
  });

  it('does not forward a large chunk before the budget is available', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    // 24 000 bytes ≈ 3 s of audio. At 1.5×, needs 2 s to drain.
    rb.push(Buffer.alloc(24_000));

    // Only 100 ms → budget = 0.1 * 8000 * 1.5 = 1 200 bytes. Not enough.
    vi.advanceTimersByTime(100);

    expect(forwarded).toHaveLength(0);

    rb.destroy();
  });

  it('switches to pass-through mode once burst buffer drains', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    // Small chunk that drains quickly: 800 bytes < 1 200 bytes budget at 100 ms.
    rb.push(Buffer.alloc(800));
    vi.advanceTimersByTime(200); // 200 ms → budget = 2 400 bytes — chunk drains.

    expect(forwarded).toHaveLength(1);
    expect(rb.isBursting).toBe(false);

    // Next chunk should be forwarded immediately (pass-through).
    const passthrough = Buffer.alloc(100);
    rb.push(passthrough);

    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]).toBe(passthrough);

    rb.destroy();
  });

  it('flushes remaining buffer immediately on destroy', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    rb.push(Buffer.alloc(100));
    rb.push(Buffer.alloc(200));
    rb.push(Buffer.alloc(50));

    // No time passes — all chunks are still buffered.
    expect(forwarded).toHaveLength(0);

    rb.destroy();

    // All three chunks must be flushed.
    expect(forwarded).toHaveLength(3);
  });

  it('forwards multiple chunks in order within a single drain tick', () => {
    const forwarded: Buffer[] = [];
    const rb = new RelayBuffer((c) => forwarded.push(c));

    // Two small chunks, total 800 bytes — well within 1 200-byte budget at 100 ms.
    const a = Buffer.alloc(300);
    const b = Buffer.alloc(500);
    rb.push(a);
    rb.push(b);

    vi.advanceTimersByTime(200);

    expect(forwarded).toHaveLength(2);
    expect(forwarded[0]).toBe(a);
    expect(forwarded[1]).toBe(b);

    rb.destroy();
  });
});

// ─── Integration: WebSocket upgrade authentication ────────────────────────────

describe('WebSocket /stt — authentication', () => {
  let server: TestServer;
  let mockPrisma: MockPrisma;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetAllMocks();

    vi.mocked(getBypassUser).mockReturnValue({
      userId: MOCK_USER_ID,
      groups: ['user'],
      email: 'dev@localhost',
    });
    vi.mocked(updateSession).mockResolvedValue(null);

    savedEnv.COGNITO_BYPASS = process.env.COGNITO_BYPASS;
    savedEnv.ELEVENLABS_MOCK = process.env.ELEVENLABS_MOCK;

    process.env.COGNITO_BYPASS = 'false';
    process.env.ELEVENLABS_MOCK = 'true'; // so accepted connections don't hit ElevenLabs

    mockPrisma = createMockPrisma();
    server = await createTestServer(mockPrisma);
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('rejects with HTTP 400 when interviewId is missing', async () => {
    const ws = wsConnect(server.port, { token: 'sometoken' });
    const status = await waitForRejection(ws);
    expect(status).toBe(400);
  });

  it('rejects with HTTP 401 when token is missing', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });
    const status = await waitForRejection(ws);
    expect(status).toBe(401);
  });

  it('rejects with HTTP 401 when token is invalid', async () => {
    vi.mocked(verifyToken).mockRejectedValueOnce(new Error('Token has expired'));

    const ws = wsConnect(server.port, {
      token: 'bad-token',
      interviewId: MOCK_INTERVIEW_ID,
    });
    const status = await waitForRejection(ws);
    expect(status).toBe(401);
  });

  it('rejects with HTTP 404 when interview is not found', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({
      userId: MOCK_USER_ID,
      groups: [],
    });
    mockPrisma.interview.findUnique.mockResolvedValueOnce(null);

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: 'nonexistent-id',
    });
    const status = await waitForRejection(ws);
    expect(status).toBe(404);
  });

  it('rejects with HTTP 403 when interview belongs to a different user', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({
      userId: MOCK_USER_ID,
      groups: [],
    });
    mockPrisma.interview.findUnique.mockResolvedValueOnce({
      id: MOCK_INTERVIEW_ID,
      userId: 'other-user-id',
      status: 'in_progress',
    });

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: MOCK_INTERVIEW_ID,
    });
    const status = await waitForRejection(ws);
    expect(status).toBe(403);
  });

  it('rejects with HTTP 422 when interview status is not in_progress', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({
      userId: MOCK_USER_ID,
      groups: [],
    });
    mockPrisma.interview.findUnique.mockResolvedValueOnce({
      id: MOCK_INTERVIEW_ID,
      userId: MOCK_USER_ID,
      status: 'completed',
    });

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: MOCK_INTERVIEW_ID,
    });
    const status = await waitForRejection(ws);
    expect(status).toBe(422);
  });

  it('rejects with HTTP 422 when interview status is paused', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({
      userId: MOCK_USER_ID,
      groups: [],
    });
    mockPrisma.interview.findUnique.mockResolvedValueOnce({
      id: MOCK_INTERVIEW_ID,
      userId: MOCK_USER_ID,
      status: 'paused',
    });

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: MOCK_INTERVIEW_ID,
    });
    const status = await waitForRejection(ws);
    expect(status).toBe(422);
  });

  it('accepts connection and sends session_ready when token is valid', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({
      userId: MOCK_USER_ID,
      groups: [],
    });

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: MOCK_INTERVIEW_ID,
    });

    const msg = await waitForMessage(ws, 'session_ready');
    expect(msg.type).toBe('session_ready');

    ws.close();
  });

  it('accepts connection via COGNITO_BYPASS without a token', async () => {
    process.env.COGNITO_BYPASS = 'true';

    // Re-create server so auth hook sees the new env value.
    await server.close();
    server = await createTestServer(mockPrisma);

    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    const msg = await waitForMessage(ws, 'session_ready');
    expect(msg.type).toBe('session_ready');

    ws.close();
  });

  it('does not call verifyToken when COGNITO_BYPASS is enabled', async () => {
    process.env.COGNITO_BYPASS = 'true';

    await server.close();
    server = await createTestServer(mockPrisma);

    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });
    await waitForMessage(ws, 'session_ready');
    ws.close();

    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('queries prisma with the provided interviewId', async () => {
    vi.mocked(verifyToken).mockResolvedValueOnce({ userId: MOCK_USER_ID, groups: [] });

    const ws = wsConnect(server.port, {
      token: 'valid-token',
      interviewId: MOCK_INTERVIEW_ID,
    });
    await waitForMessage(ws, 'session_ready');
    ws.close();

    expect(mockPrisma.interview.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MOCK_INTERVIEW_ID } }),
    );
  });
});

// ─── Integration: mock STT transcript streaming ───────────────────────────────

describe('WebSocket /stt — mock STT mode (ELEVENLABS_MOCK=true)', () => {
  let server: TestServer;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetAllMocks();

    vi.mocked(getBypassUser).mockReturnValue({
      userId: MOCK_USER_ID,
      groups: ['user'],
      email: 'dev@localhost',
    });
    vi.mocked(updateSession).mockResolvedValue(null);

    savedEnv.COGNITO_BYPASS = process.env.COGNITO_BYPASS;
    savedEnv.ELEVENLABS_MOCK = process.env.ELEVENLABS_MOCK;

    process.env.COGNITO_BYPASS = 'true';
    process.env.ELEVENLABS_MOCK = 'true';

    server = await createTestServer(createMockPrisma());
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sends session_ready immediately after connection', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    const msg = await waitForMessage(ws, 'session_ready');
    expect(msg.type).toBe('session_ready');

    ws.close();
  });

  it('sends partial_transcript messages when audio chunks are received', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    // Send a binary audio chunk.
    ws.send(Buffer.alloc(1_024));

    const partial = await waitForMessage(ws, 'partial_transcript');
    expect(partial.type).toBe('partial_transcript');
    expect(typeof partial.text).toBe('string');
    expect((partial.text as string).length).toBeGreaterThan(0);

    ws.close();
  });

  it('sends final_transcript on audio_end and updates Redis transcript buffer', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    // Simulate audio then signal end-of-recording.
    ws.send(Buffer.alloc(512));
    ws.send(JSON.stringify({ type: 'audio_end' }));

    const final = await waitForMessage(ws, 'final_transcript');
    expect(final.type).toBe('final_transcript');
    expect(typeof final.text).toBe('string');
    expect((final.text as string).length).toBeGreaterThan(0);

    // Give the updateSession promise a tick to resolve.
    await new Promise((r) => setTimeout(r, 50));

    expect(updateSession).toHaveBeenCalledWith(
      MOCK_INTERVIEW_ID,
      expect.objectContaining({ currentTranscriptBuffer: expect.any(String) }),
    );

    ws.close();
  });

  it('partial transcripts have progressively longer text', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    // Send audio to trigger partials.
    ws.send(Buffer.alloc(1_024));

    // Collect at least 2 partial transcripts.
    const partials: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timeout collecting partials')),
        2_500,
      );
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as { type: string; text?: string };
        if (msg.type === 'partial_transcript' && msg.text) {
          partials.push(msg.text);
          if (partials.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    expect(partials[1].length).toBeGreaterThanOrEqual(partials[0].length);

    ws.close();
  });

  it('ignores malformed text messages without crashing', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    // Send garbage.
    ws.send('not valid json {{{');

    // A subsequent valid interaction should still work.
    ws.send(Buffer.alloc(512));
    const partial = await waitForMessage(ws, 'partial_transcript');
    expect(partial.type).toBe('partial_transcript');

    ws.close();
  });

  it('does not call updateSession for partial transcripts', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    ws.send(Buffer.alloc(512));
    await waitForMessage(ws, 'partial_transcript');

    // Give async calls a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    // updateSession must not have been called yet (no audio_end sent).
    expect(updateSession).not.toHaveBeenCalled();

    ws.close();
  });

  it('final_transcript text from mock matches expected canned response', async () => {
    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    ws.send(Buffer.alloc(512));
    ws.send(JSON.stringify({ type: 'audio_end' }));

    const final = await waitForMessage(ws, 'final_transcript');

    // The mock final transcript should be a non-trivial sentence.
    expect((final.text as string).split(' ').length).toBeGreaterThan(5);

    ws.close();
  });
});

// ─── Integration: session safety timeout ──────────────────────────────────────

describe('WebSocket /stt — safety timeout', () => {
  let server: TestServer;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetAllMocks();

    vi.mocked(getBypassUser).mockReturnValue({
      userId: MOCK_USER_ID,
      groups: ['user'],
      email: 'dev@localhost',
    });
    vi.mocked(updateSession).mockResolvedValue(null);

    savedEnv.COGNITO_BYPASS = process.env.COGNITO_BYPASS;
    savedEnv.ELEVENLABS_MOCK = process.env.ELEVENLABS_MOCK;

    process.env.COGNITO_BYPASS = 'true';
    process.env.ELEVENLABS_MOCK = 'true';

    server = await createTestServer(createMockPrisma());
  });

  afterEach(async () => {
    await server.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('sends an error message and closes with recording_too_long when timeout fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const ws = wsConnect(server.port, { interviewId: MOCK_INTERVIEW_ID });

    await waitForMessage(ws, 'session_ready');

    // Advance fake timers past the 6-minute safety limit.
    vi.advanceTimersByTime(6 * 60 * 1_000 + 100);

    const errorMsg = await waitForMessage(ws, 'error');
    expect(errorMsg.code).toBe('recording_too_long');

    vi.useRealTimers();
    ws.close();
  });
});
