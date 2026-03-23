// ---------------------------------------------------------------------------
// Unit + Integration Tests — SSE Stream (stream.ts)
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Poll until `getSSEConnection(id)` returns a connection or the timeout elapses. */
async function waitForSSEConnection(id: string, timeoutMs = 500): Promise<SSEConnection> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conn = getSSEConnection(id);
    if (conn) return conn;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error(`SSE connection for '${id}' was never registered within ${timeoutMs}ms`);
}
import Fastify from 'fastify';
import {
  SentenceBoundaryDetector,
  formatSSEMessage,
  registerSSEConnection,
  getSSEConnection,
  removeSSEConnection,
  clearSSERegistry,
  streamLlmToSSE,
  ssePlugin,
  ABBREVIATIONS,
  FALLBACK_SENTENCE_LENGTH,
  type SSEEvent,
  type SSEConnection,
  type StreamingLlmClient,
  type SentenceCompleteEvent,
  type StreamCompleteEvent,
} from '../sse/stream';
import { cognitoAuthHook } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER_ID = '00000000-0000-0000-0000-000000000001'; // matches COGNITO_BYPASS default
const INTERVIEW_ID = 'interview-test-abc';

function makeMockPrisma(
  interviewOverride:
    | Partial<{ id: string; userId: string; status: string }>
    | null = { id: INTERVIEW_ID, userId: MOCK_USER_ID, status: 'in_progress' },
) {
  return {
    interview: {
      findUnique: vi.fn().mockResolvedValue(
        interviewOverride === null
          ? null
          : { id: INTERVIEW_ID, userId: MOCK_USER_ID, status: 'in_progress', ...interviewOverride },
      ),
    },
  };
}

function makeCollector(): { events: SSEEvent[]; conn: SSEConnection } {
  const events: SSEEvent[] = [];
  const conn: SSEConnection = {
    send(e) { events.push(e); },
    close() { /* no-op in unit tests */ },
  };
  return { events, conn };
}

function makeMockLlmClient(tokens: string[]): StreamingLlmClient {
  return {
    async stream({ onToken }) {
      let fullContent = '';
      for (const token of tokens) {
        onToken(token);
        fullContent += token;
      }
      return {
        fullContent,
        model: 'claude-sonnet-4-20250514',
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 42,
      };
    },
  };
}

async function buildTestApp(
  prismaOverride:
    | Partial<{ id: string; userId: string; status: string }>
    | null = undefined,
  envOverrides: Record<string, string> = {},
) {
  Object.assign(process.env, { COGNITO_BYPASS: 'true', ...envOverrides });
  const app = Fastify({ logger: false });
  app.addHook('onRequest', cognitoAuthHook);
  await app.register(ssePlugin, {
    prisma: makeMockPrisma(prismaOverride) as Parameters<typeof ssePlugin>[1]['prisma'],
  });
  return app;
}

// ---------------------------------------------------------------------------
// SentenceBoundaryDetector — unit tests
// ---------------------------------------------------------------------------

describe('SentenceBoundaryDetector', () => {
  let detector: SentenceBoundaryDetector;

  beforeEach(() => {
    detector = new SentenceBoundaryDetector();
  });

  it('exports a non-empty ABBREVIATIONS list', () => {
    expect(ABBREVIATIONS.length).toBeGreaterThan(0);
    expect(ABBREVIATIONS).toContain('Dr');
    expect(ABBREVIATIONS).toContain('Mr');
  });

  it('exports FALLBACK_SENTENCE_LENGTH as a positive number', () => {
    expect(FALLBACK_SENTENCE_LENGTH).toBeGreaterThan(0);
  });

  it('detects a sentence ending with a period', () => {
    const events = detector.addToken('Hello world. ');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('sentence_complete');
    expect(events[0].sentence).toBe('Hello world.');
    expect(events[0].sentenceIndex).toBe(0);
  });

  it('detects a sentence ending with a question mark', () => {
    const events = detector.addToken('How are you? ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toBe('How are you?');
  });

  it('detects a sentence ending with an exclamation mark', () => {
    const events = detector.addToken('Great! ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toBe('Great!');
  });

  it('detects multiple sentences in a single token', () => {
    const events = detector.addToken('First sentence. Second sentence. ');
    expect(events).toHaveLength(2);
    expect(events[0].sentence).toBe('First sentence.');
    expect(events[1].sentence).toBe('Second sentence.');
    expect(events[1].sentenceIndex).toBe(1);
  });

  it('detects sentences across multiple addToken calls', () => {
    detector.addToken('First. ');
    const events = detector.addToken('Second. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentenceIndex).toBe(1);
  });

  it('does NOT split on Dr.', () => {
    const events = detector.addToken('Dr. Smith arrived today. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toContain('Dr. Smith');
    expect(events[0].sentence).toContain('today.');
  });

  it('does NOT split on Mr.', () => {
    const events = detector.addToken('Mr. Jones said hello. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toContain('Mr. Jones');
  });

  it('does NOT split on Mrs.', () => {
    const events = detector.addToken('Mrs. Brown arrived. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toContain('Mrs. Brown');
  });

  it('does NOT split on Inc.', () => {
    const events = detector.addToken('Acme Inc. was founded here. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toContain('Inc.');
  });

  it('does NOT split on decimal numbers (3.5)', () => {
    const events = detector.addToken('It cost 3.5 million dollars. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toBe('It cost 3.5 million dollars.');
  });

  it('does NOT split on a three-dot ellipsis (...)', () => {
    const events = detector.addToken('Wait... then it happened. ');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toContain('Wait...');
    expect(events[0].sentence).toContain('happened.');
  });

  it('assigns sequential sentenceIndex values across calls', () => {
    detector.addToken('A. ');
    detector.addToken('B. ');
    const events = detector.addToken('C. ');
    expect(events[0].sentenceIndex).toBe(2);
  });

  it('handles tokens arriving one character at a time', () => {
    const text = 'Hello. ';
    let allEvents: SentenceCompleteEvent[] = [];
    for (const ch of text) {
      allEvents = allEvents.concat(detector.addToken(ch));
    }
    expect(allEvents).toHaveLength(1);
    expect(allEvents[0].sentence).toBe('Hello.');
  });

  it('detects end-of-string as a sentence boundary (no trailing space)', () => {
    const events = detector.addToken('Done.');
    expect(events).toHaveLength(1);
    expect(events[0].sentence).toBe('Done.');
  });

  it('flush() returns null when buffer is empty', () => {
    expect(detector.flush()).toBeNull();
  });

  it('flush() returns remaining text without terminal punctuation', () => {
    detector.addToken('No period here');
    const result = detector.flush();
    expect(result).not.toBeNull();
    expect(result!.type).toBe('sentence_complete');
    expect(result!.sentence).toBe('No period here');
    expect(result!.sentenceIndex).toBe(0);
  });

  it('flush() clears the buffer', () => {
    detector.addToken('Some text');
    detector.flush();
    expect(detector.getBuffer()).toBe('');
    expect(detector.flush()).toBeNull();
  });

  it('flush() increments sentenceIndex', () => {
    detector.addToken('First. ');
    detector.addToken('Trailing');
    const flushed = detector.flush();
    expect(flushed!.sentenceIndex).toBe(1);
  });

  it('getBuffer() returns the current unprocessed buffer', () => {
    detector.addToken('partial');
    expect(detector.getBuffer()).toBe('partial');
  });

  it('triggers fallback split when buffer exceeds FALLBACK_SENTENCE_LENGTH at a comma', () => {
    const longText = 'a'.repeat(FALLBACK_SENTENCE_LENGTH + 20) + ', then more';
    const events = detector.addToken(longText);
    expect(events.length).toBeGreaterThanOrEqual(1);
    // The split should include the comma
    expect(events[0].sentence).toMatch(/,$/);
  });

  it('triggers fallback split at semicolon', () => {
    const longText = 'b'.repeat(FALLBACK_SENTENCE_LENGTH + 5) + '; continued';
    const events = detector.addToken(longText);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].sentence).toMatch(/;$/);
  });
});

// ---------------------------------------------------------------------------
// formatSSEMessage — unit tests
// ---------------------------------------------------------------------------

describe('formatSSEMessage', () => {
  it('formats a token event', () => {
    const msg = formatSSEMessage({ type: 'token', content: 'Hello' });
    expect(msg).toBe('data: {"type":"token","content":"Hello"}\n\n');
  });

  it('formats a sentence_complete event', () => {
    const msg = formatSSEMessage({
      type: 'sentence_complete',
      sentence: 'Hi there.',
      sentenceIndex: 0,
    });
    expect(msg).toContain('"type":"sentence_complete"');
    expect(msg).toContain('"sentenceIndex":0');
    expect(msg).toMatch(/\n\n$/);
  });

  it('formats a stream_complete event', () => {
    const msg = formatSSEMessage({
      type: 'stream_complete',
      fullResponse: 'Tell me more.',
      questionId: 'q-1',
      interviewComplete: false,
      progressPercent: 50,
    });
    expect(msg).toContain('"type":"stream_complete"');
    expect(msg).toContain('"progressPercent":50');
    expect(msg).toContain('"questionId":"q-1"');
  });

  it('formats an idle_prompt event', () => {
    const msg = formatSSEMessage({
      type: 'idle_prompt',
      content: 'Still there?',
      questionId: null,
    });
    expect(msg).toContain('"type":"idle_prompt"');
    expect(msg).toContain('"questionId":null');
  });

  it('formats an auto_paused event', () => {
    const msg = formatSSEMessage({
      type: 'auto_paused',
      reason: 'inactivity',
      resumeAvailable: true,
    });
    expect(msg).toContain('"type":"auto_paused"');
    expect(msg).toContain('"resumeAvailable":true');
  });

  it('always ends with \\n\\n', () => {
    const msg = formatSSEMessage({ type: 'token', content: 'x' });
    expect(msg.endsWith('\n\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE connection registry — unit tests
// ---------------------------------------------------------------------------

describe('SSE connection registry', () => {
  beforeEach(() => clearSSERegistry());
  afterEach(() => clearSSERegistry());

  it('registers and retrieves a connection', () => {
    const { conn } = makeCollector();
    registerSSEConnection('iw-1', conn);
    expect(getSSEConnection('iw-1')).toBe(conn);
  });

  it('returns undefined for an unknown interview', () => {
    expect(getSSEConnection('no-such-id')).toBeUndefined();
  });

  it('removes a connection', () => {
    const { conn } = makeCollector();
    registerSSEConnection('iw-1', conn);
    removeSSEConnection('iw-1');
    expect(getSSEConnection('iw-1')).toBeUndefined();
  });

  it('closes existing connection when a new one is registered for the same interview', () => {
    const oldClose = vi.fn();
    const oldConn: SSEConnection = { send: vi.fn(), close: oldClose };
    const { conn: newConn } = makeCollector();

    registerSSEConnection('iw-1', oldConn);
    registerSSEConnection('iw-1', newConn);

    expect(oldClose).toHaveBeenCalledOnce();
    expect(getSSEConnection('iw-1')).toBe(newConn);
  });

  it('clearSSERegistry removes all connections', () => {
    const { conn: c1 } = makeCollector();
    const { conn: c2 } = makeCollector();
    registerSSEConnection('a', c1);
    registerSSEConnection('b', c2);
    clearSSERegistry();
    expect(getSSEConnection('a')).toBeUndefined();
    expect(getSSEConnection('b')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// streamLlmToSSE — unit tests
// ---------------------------------------------------------------------------

describe('streamLlmToSSE', () => {
  beforeEach(() => clearSSERegistry());
  afterEach(() => clearSSERegistry());

  const BASE_PARAMS = {
    interviewId: 'iw-x',
    system: 'You are an interviewer.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    questionId: 'q-1',
    sequenceNumber: 1,
    isFollowup: false,
    progressPercent: 25,
  };

  it('throws when no SSE connection is registered', async () => {
    const client = makeMockLlmClient(['Hi.']);
    await expect(
      streamLlmToSSE(client, { ...BASE_PARAMS, interviewId: 'no-conn' }),
    ).rejects.toThrow('No active SSE connection');
  });

  it('emits a token event for each LLM token', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(makeMockLlmClient(['Hello', ' there', '!']), BASE_PARAMS);

    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents).toHaveLength(3);
    expect(tokenEvents[0]).toEqual({ type: 'token', content: 'Hello' });
    expect(tokenEvents[1]).toEqual({ type: 'token', content: ' there' });
    expect(tokenEvents[2]).toEqual({ type: 'token', content: '!' });
  });

  it('emits sentence_complete events as sentence boundaries are detected', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(
      makeMockLlmClient(['First sentence. ', 'Second sentence. ']),
      BASE_PARAMS,
    );

    const sentEvents = events.filter((e) => e.type === 'sentence_complete') as SentenceCompleteEvent[];
    expect(sentEvents.length).toBeGreaterThanOrEqual(2);
    expect(sentEvents[0].sentence).toBe('First sentence.');
    expect(sentEvents[1].sentence).toBe('Second sentence.');
  });

  it('flushes remaining buffer as a final sentence_complete before stream_complete', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    // No terminal punctuation — should be flushed
    await streamLlmToSSE(makeMockLlmClient(['Unfinished answer']), BASE_PARAMS);

    const sentEvents = events.filter((e) => e.type === 'sentence_complete') as SentenceCompleteEvent[];
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].sentence).toBe('Unfinished answer');

    // stream_complete must come after the final sentence_complete
    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('stream_complete');
  });

  it('emits stream_complete with correct metadata', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(makeMockLlmClient(['The answer.']), {
      ...BASE_PARAMS,
      questionId: 'q-5',
      sequenceNumber: 3,
      isFollowup: true,
      progressPercent: 75,
      interviewComplete: false,
    });

    const completeEvent = events.find((e) => e.type === 'stream_complete') as StreamCompleteEvent;
    expect(completeEvent).toBeDefined();
    expect(completeEvent.fullResponse).toBe('The answer.');
    expect(completeEvent.questionId).toBe('q-5');
    expect(completeEvent.sequenceNumber).toBe(3);
    expect(completeEvent.isFollowup).toBe(true);
    expect(completeEvent.progressPercent).toBe(75);
    expect(completeEvent.interviewComplete).toBe(false);
  });

  it('emits stream_complete with interviewComplete: true and closingMessage', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(makeMockLlmClient(['Thank you!']), {
      ...BASE_PARAMS,
      questionId: null,
      interviewComplete: true,
      closingMessage: true,
      progressPercent: 100,
    });

    const completeEvent = events.find((e) => e.type === 'stream_complete') as StreamCompleteEvent;
    expect(completeEvent.interviewComplete).toBe(true);
    expect(completeEvent.closingMessage).toBe(true);
    expect(completeEvent.questionId).toBeNull();
    expect(completeEvent.progressPercent).toBe(100);
  });

  it('stream_complete is always the last event', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(makeMockLlmClient(['First. ', 'Second.']), BASE_PARAMS);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.type).toBe('stream_complete');
  });

  it('token events appear before sentence_complete events in emission order', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    // Tokens "Hello" " world" ". " — sentence fires on third token
    await streamLlmToSSE(makeMockLlmClient(['Hello', ' world', '. ']), BASE_PARAMS);

    const types = events.map((e) => e.type);
    const firstSentence = types.indexOf('sentence_complete');
    const lastToken = types.lastIndexOf('token');
    // At least one token fires before the sentence_complete
    expect(lastToken).toBeGreaterThan(-1);
    expect(firstSentence).toBeGreaterThan(-1);
  });

  it('returns the LLM result with token and latency metrics', async () => {
    const { conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    const result = await streamLlmToSSE(makeMockLlmClient(['Hello.']), BASE_PARAMS);

    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
    expect(result.fullContent).toBe('Hello.');
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.latencyMs).toBe(42);
  });

  it('handles an empty response gracefully', async () => {
    const { events, conn } = makeCollector();
    registerSSEConnection('iw-x', conn);

    await streamLlmToSSE(makeMockLlmClient([]), BASE_PARAMS);

    // No token events, no sentence events, just stream_complete
    const tokenEvents = events.filter((e) => e.type === 'token');
    const sentEvents = events.filter((e) => e.type === 'sentence_complete');
    expect(tokenEvents).toHaveLength(0);
    expect(sentEvents).toHaveLength(0);
    expect(events[events.length - 1].type).toBe('stream_complete');
  });
});

// ---------------------------------------------------------------------------
// GET /api/tts-token — Fastify plugin integration tests
// ---------------------------------------------------------------------------

describe('GET /api/tts-token', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    // Restore env vars
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns 401 without authentication', async () => {
    process.env.COGNITO_BYPASS = 'false';
    process.env.COGNITO_USER_POOL_ID = 'us-east-2_test';
    const app = Fastify({ logger: false });
    app.addHook('onRequest', cognitoAuthHook);
    await app.register(ssePlugin, { prisma: makeMockPrisma() as Parameters<typeof ssePlugin>[1]['prisma'] });

    const response = await app.inject({ method: 'GET', url: '/api/tts-token' });
    expect(response.statusCode).toBe(401);
  });

  it('returns mock token when ELEVENLABS_MOCK=true', async () => {
    const app = await buildTestApp(undefined, { ELEVENLABS_MOCK: 'true' });
    const response = await app.inject({ method: 'GET', url: '/api/tts-token' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; expiresIn: number }>();
    expect(body.token).toBe('mock-tts-token');
    expect(body.expiresIn).toBe(300);
  });

  it('returns 503 when ELEVENLABS_API_KEY is absent and ELEVENLABS_MOCK is not set', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_MOCK;
    const app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/api/tts-token' });

    expect(response.statusCode).toBe(503);
  });

  it('returns the real API key as the token when ELEVENLABS_API_KEY is set', async () => {
    const app = await buildTestApp(undefined, {
      ELEVENLABS_API_KEY: 'test-key-xyz',
      ELEVENLABS_MOCK: 'false',
    });
    const response = await app.inject({ method: 'GET', url: '/api/tts-token' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; expiresIn: number }>();
    expect(body.token).toBe('test-key-xyz');
    expect(body.expiresIn).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// GET /api/interview/:id/stream — Fastify plugin integration tests
// ---------------------------------------------------------------------------

describe('GET /api/interview/:id/stream', () => {
  beforeEach(() => {
    clearSSERegistry();
    process.env.COGNITO_BYPASS = 'true';
  });

  afterEach(() => {
    clearSSERegistry();
  });

  it('returns 401 without authentication', async () => {
    process.env.COGNITO_BYPASS = 'false';
    process.env.COGNITO_USER_POOL_ID = 'us-east-2_test';
    const app = Fastify({ logger: false });
    app.addHook('onRequest', cognitoAuthHook);
    await app.register(ssePlugin, {
      prisma: makeMockPrisma() as Parameters<typeof ssePlugin>[1]['prisma'],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 when interview does not exist', async () => {
    const app = await buildTestApp(null);

    const response = await app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 403 when interview belongs to a different user', async () => {
    const app = await buildTestApp({ userId: 'different-user-id' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 400 when interview status is completed', async () => {
    const app = await buildTestApp({ userId: MOCK_USER_ID, status: 'completed' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when interview status is abandoned', async () => {
    const app = await buildTestApp({ userId: MOCK_USER_ID, status: 'abandoned' });

    const response = await app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a paused interview', async () => {
    const app = await buildTestApp({ userId: MOCK_USER_ID, status: 'paused' });

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.close();
    const response = await injectPromise;
    expect(response.statusCode).toBe(200);
  });

  it('registers SSE connection, sets SSE headers, and returns 200', async () => {
    const app = await buildTestApp();

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.close();
    const response = await injectPromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  it('sends events through the SSE connection', async () => {
    const app = await buildTestApp();

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.send({ type: 'token', content: 'Hello' });
    conn.close();

    const response = await injectPromise;
    expect(response.body).toContain('"type":"token"');
    expect(response.body).toContain('"content":"Hello"');
  });

  it('includes the initial :connected comment in the response body', async () => {
    const app = await buildTestApp();

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.close();
    const response = await injectPromise;

    expect(response.body).toContain(':connected');
  });

  it('removes the connection from the registry after close', async () => {
    const app = await buildTestApp();

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.close();
    await injectPromise;

    // conn.close() removes the connection from the registry
    expect(getSSEConnection(INTERVIEW_ID)).toBeUndefined();
  });

  it('multiple sentence_complete events can be sent over SSE', async () => {
    const app = await buildTestApp();

    const injectPromise = app.inject({
      method: 'GET',
      url: `/api/interview/${INTERVIEW_ID}/stream`,
    });

    const conn = await waitForSSEConnection(INTERVIEW_ID);
    conn.send({ type: 'sentence_complete', sentence: 'First.', sentenceIndex: 0 });
    conn.send({ type: 'sentence_complete', sentence: 'Second.', sentenceIndex: 1 });
    conn.send({
      type: 'stream_complete',
      fullResponse: 'First. Second.',
      questionId: 'q-1',
      interviewComplete: false,
      progressPercent: 50,
    });
    conn.close();

    const response = await injectPromise;
    expect(response.body).toContain('"sentenceIndex":0');
    expect(response.body).toContain('"sentenceIndex":1');
    expect(response.body).toContain('"type":"stream_complete"');
  });
});
