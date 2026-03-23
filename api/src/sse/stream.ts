// ---------------------------------------------------------------------------
// Arena SSE Stream — GET /api/interview/:id/stream, GET /api/tts-token
// ---------------------------------------------------------------------------

import type { FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';

// ===========================================================================
// Sentence boundary detection
// ===========================================================================

/**
 * Configurable list of abbreviations that should NOT trigger sentence
 * boundaries. Maintained as a named constant, not hardcoded inline, so it can
 * be tuned without touching the detection logic.
 */
export const ABBREVIATIONS: readonly string[] = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr',
  'Inc', 'Ltd', 'Corp', 'vs', 'etc', 'approx',
  'dept', 'est', 'govt', 'e.g', 'i.e', 'St', 'Ave', 'Blvd',
];

/** Buffer length at which the fallback clause-boundary split is triggered. */
export const FALLBACK_SENTENCE_LENGTH = 500;

function buildSentenceEndRegex(abbreviations: readonly string[]): RegExp {
  // Escape any literal dots in abbreviation strings (e.g. "e.g" → "e\.g")
  const escaped = abbreviations.map((a) => a.replace(/\./g, '\\.'));
  const abbrevPattern = escaped.join('|');
  return new RegExp(
    `(?<!\\b(?:${abbrevPattern}))` + // not preceded by a known abbreviation
    `(?<!\\d)` +                      // not preceded by a digit (decimal guard)
    `(?<!\\.\\.)` +                   // not preceded by ".." (ellipsis guard)
    `[.?!]` +                         // sentence-ending punctuation
    `(?=\\s|$)`,                      // followed by whitespace or end of string
    'u',
  );
}

const SENTENCE_END_REGEX = buildSentenceEndRegex(ABBREVIATIONS);

/** Matches clause delimiters used for fallback splitting (comma, semicolon, colon, em-dash, en-dash). */
const CLAUSE_BOUNDARY_REGEX = /[,;:\u2014\u2013]\s/u;

export interface SentenceCompleteEvent {
  type: 'sentence_complete';
  sentence: string;
  sentenceIndex: number;
}

/**
 * Stateful detector that buffers streaming LLM tokens and emits
 * {@link SentenceCompleteEvent}s as complete sentences are detected.
 *
 * Algorithm (per conversation-protocol-spec.md §14):
 * 1. Tokens are appended to an internal buffer.
 * 2. After each append, the buffer is tested against a sentence-terminating
 *    regex that respects abbreviations, decimal numbers, and ellipses.
 * 3. If the buffer grows past {@link FALLBACK_SENTENCE_LENGTH} without a
 *    boundary, it splits at the next clause delimiter.
 * 4. When the LLM stream ends, call {@link flush} to emit any remainder.
 */
export class SentenceBoundaryDetector {
  private buffer = '';
  private sentenceIndex = 0;

  /** Append {@link token} and return any sentence_complete events produced. */
  addToken(token: string): SentenceCompleteEvent[] {
    this.buffer += token;
    const events: SentenceCompleteEvent[] = [];

    let match = SENTENCE_END_REGEX.exec(this.buffer);
    while (match !== null) {
      const cutPoint = match.index + 1; // include the punctuation character
      const sentence = this.buffer.slice(0, cutPoint).trim();
      this.buffer = this.buffer.slice(cutPoint).replace(/^\s+/, '');

      if (sentence) {
        events.push({ type: 'sentence_complete', sentence, sentenceIndex: this.sentenceIndex++ });
      }

      match = SENTENCE_END_REGEX.exec(this.buffer);
    }

    // Fallback: unusually long buffer without a sentence boundary.
    // Split at the next clause delimiter to prevent TTS from waiting indefinitely.
    // Log when triggered — may indicate a missing abbreviation or unusual punctuation.
    if (this.buffer.length > FALLBACK_SENTENCE_LENGTH) {
      const clauseMatch = CLAUSE_BOUNDARY_REGEX.exec(this.buffer);
      if (clauseMatch) {
        const cutPoint = clauseMatch.index + 1; // include the delimiter char
        const sentence = this.buffer.slice(0, cutPoint).trim();
        this.buffer = this.buffer.slice(cutPoint).replace(/^\s+/, '');

        if (sentence) {
          console.warn(
            '[SSE] Fallback sentence split at %d chars — possible missing abbreviation.',
            cutPoint,
          );
          events.push({ type: 'sentence_complete', sentence, sentenceIndex: this.sentenceIndex++ });
        }
      }
    }

    return events;
  }

  /** Flush any remaining buffer text as a final sentence. Call when the LLM stream ends. */
  flush(): SentenceCompleteEvent | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (!remaining) return null;
    return { type: 'sentence_complete', sentence: remaining, sentenceIndex: this.sentenceIndex++ };
  }

  /** Expose internal buffer state — for testing. */
  getBuffer(): string { return this.buffer; }
  /** Expose the current sentence counter — for testing. */
  getSentenceIndex(): number { return this.sentenceIndex; }
}

// ===========================================================================
// SSE event types
// ===========================================================================

export interface TokenEvent {
  type: 'token';
  content: string;
}

export interface StreamCompleteEvent {
  type: 'stream_complete';
  fullResponse: string;
  questionId: string | null;
  sequenceNumber?: number;
  isFollowup?: boolean;
  interviewComplete: boolean;
  progressPercent: number;
  closingMessage?: boolean;
}

export interface IdlePromptEvent {
  type: 'idle_prompt';
  content: string;
  questionId: null;
}

export interface AutoPausedEvent {
  type: 'auto_paused';
  reason: string;
  resumeAvailable: boolean;
}

export type SSEEvent =
  | TokenEvent
  | SentenceCompleteEvent
  | StreamCompleteEvent
  | IdlePromptEvent
  | AutoPausedEvent;

/** Serialize an event to the SSE wire format: `data: <json>\n\n` */
export function formatSSEMessage(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ===========================================================================
// SSE connection registry
// ===========================================================================

export interface SSEConnection {
  send(event: SSEEvent): void;
  close(): void;
}

/** Module-level map: interviewId → active SSE connection. */
const sseRegistry = new Map<string, SSEConnection>();

/** Register a connection, closing any stale connection for the same interview. */
export function registerSSEConnection(interviewId: string, conn: SSEConnection): void {
  const existing = sseRegistry.get(interviewId);
  if (existing) {
    try { existing.close(); } catch { /* ignore errors from stale connection */ }
  }
  sseRegistry.set(interviewId, conn);
}

export function getSSEConnection(interviewId: string): SSEConnection | undefined {
  return sseRegistry.get(interviewId);
}

export function removeSSEConnection(interviewId: string): void {
  sseRegistry.delete(interviewId);
}

/** Clear all registry entries. For testing only. */
export function clearSSERegistry(): void {
  sseRegistry.clear();
}

// ===========================================================================
// Streaming LLM client
// ===========================================================================

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamingLlmParams {
  system: string;
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  onToken(token: string): void;
}

export interface StreamingLlmResult {
  fullContent: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export interface StreamingLlmClient {
  stream(params: StreamingLlmParams): Promise<StreamingLlmResult>;
}

/** Production streaming Anthropic Claude client. */
export function createStreamingClaudeClient(apiKey: string): StreamingLlmClient {
  return {
    async stream({
      system,
      messages,
      model = 'claude-sonnet-4-20250514',
      maxTokens = 4096,
      onToken,
    }) {
      // @ts-expect-error — @anthropic-ai/sdk installed at deploy time, not in devDependencies
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const start = Date.now();
      let fullContent = '';

      const anthropicStream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });

      for await (const chunk of anthropicStream) {
        if (
          chunk.type === 'content_block_delta' &&
          (chunk.delta as { type: string }).type === 'text_delta'
        ) {
          const token = (chunk.delta as { text: string }).text;
          fullContent += token;
          onToken(token);
        }
      }

      const finalMessage = await anthropicStream.finalMessage();
      return {
        fullContent,
        model: finalMessage.model,
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        latencyMs: Date.now() - start,
      };
    },
  };
}

// ===========================================================================
// LLM streaming orchestrator
// ===========================================================================

export interface StreamLlmToSSEParams {
  interviewId: string;
  system: string;
  messages: LlmMessage[];
  questionId: string | null;
  sequenceNumber: number;
  isFollowup: boolean;
  progressPercent: number;
  interviewComplete?: boolean;
  closingMessage?: boolean;
  model?: string;
  maxTokens?: number;
}

/**
 * Stream an LLM response to the registered SSE connection for the given
 * interview. Emits (in order):
 *   - `token` events for each LLM token
 *   - `sentence_complete` events as boundaries are detected
 *   - A final `sentence_complete` for any remaining buffer text
 *   - A `stream_complete` event with turn metadata
 *
 * @throws {Error} if no SSE connection is registered for the interview.
 */
export async function streamLlmToSSE(
  client: StreamingLlmClient,
  params: StreamLlmToSSEParams,
): Promise<StreamingLlmResult> {
  const conn = getSSEConnection(params.interviewId);
  if (!conn) {
    throw new Error(`No active SSE connection for interview ${params.interviewId}`);
  }

  const detector = new SentenceBoundaryDetector();

  const result = await client.stream({
    system: params.system,
    messages: params.messages,
    model: params.model,
    maxTokens: params.maxTokens,
    onToken: (token) => {
      conn.send({ type: 'token', content: token });
      for (const evt of detector.addToken(token)) {
        conn.send(evt);
      }
    },
  });

  // Flush any remaining buffer as a final sentence before stream_complete
  const finalSentence = detector.flush();
  if (finalSentence) conn.send(finalSentence);

  const completeEvent: StreamCompleteEvent = {
    type: 'stream_complete',
    fullResponse: result.fullContent,
    questionId: params.questionId,
    sequenceNumber: params.sequenceNumber,
    isFollowup: params.isFollowup,
    interviewComplete: params.interviewComplete ?? false,
    progressPercent: params.progressPercent,
    ...(params.closingMessage ? { closingMessage: true } : {}),
  };
  conn.send(completeEvent);

  return result;
}

// ===========================================================================
// Fastify plugin
// ===========================================================================

export interface SSEPluginOptions {
  /**
   * Prisma client for database lookups.
   * Defaults to `new PrismaClient()`. Pass a mock instance in tests.
   */
  prisma?: PrismaClient;
}

export const ssePlugin: FastifyPluginAsync<SSEPluginOptions> = async (app, opts) => {
  const prisma = opts.prisma ?? new PrismaClient();

  // -------------------------------------------------------------------------
  // GET /api/interview/:id/stream
  // Long-lived SSE connection — opens at interview start, persists across turns.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/api/interview/:id/stream',
    async (request, reply) => {
      // Auth — hook sets request.user; guard here for defence-in-depth
      const user = request.user;
      if (!user) {
        return reply.code(401).send({
          errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }],
        });
      }

      const interviewId = request.params.id;

      // Interview existence, ownership, and status checks
      const interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        select: { id: true, userId: true, status: true },
      });

      if (!interview) {
        return reply.code(404).send({
          errors: [{ message: 'Interview not found', extensions: { code: 'NOT_FOUND' } }],
        });
      }

      if (interview.userId !== user.userId) {
        return reply.code(403).send({
          errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
        });
      }

      if (interview.status !== 'in_progress' && interview.status !== 'paused') {
        return reply.code(400).send({
          errors: [{
            message: 'Interview is not active',
            extensions: { code: 'INVALID_STATE' },
          }],
        });
      }

      // Write SSE headers and hijack — Fastify won't send its own response
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.hijack();

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const conn: SSEConnection = {
        send(event) {
          if (!reply.raw.writableEnded) {
            reply.raw.write(formatSSEMessage(event));
          }
        },
        close() {
          if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          removeSSEConnection(interviewId);
          if (!reply.raw.writableEnded) {
            reply.raw.end();
          }
        },
      };

      registerSSEConnection(interviewId, conn);

      // Heartbeat comment every 30 s to keep the connection alive through proxies
      heartbeatTimer = setInterval(() => {
        if (reply.raw.writableEnded) {
          if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
        } else {
          reply.raw.write(':heartbeat\n\n');
        }
      }, 30_000);

      // Clean up when the client disconnects (tab closed, navigation)
      request.raw.on('close', () => {
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        removeSSEConnection(interviewId);
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      });

      // Initial comment confirms the connection is open
      reply.raw.write(':connected\n\n');

      // Hold the handler open until the response is ended
      await new Promise<void>((resolve) => {
        reply.raw.on('finish', resolve);
        reply.raw.on('close', resolve);
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/tts-token
  // Returns a short-lived ElevenLabs API token for the frontend to use
  // when calling TTS directly (per conversation-protocol-spec.md §9).
  // -------------------------------------------------------------------------
  app.get('/api/tts-token', async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.code(401).send({
        errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }],
      });
    }

    if (process.env.ELEVENLABS_MOCK === 'true') {
      return reply.code(200).send({ token: 'mock-tts-token', expiresIn: 300 });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return reply.code(503).send({
        errors: [{
          message: 'TTS service not configured',
          extensions: { code: 'INTERNAL_ERROR' },
        }],
      });
    }

    return reply.code(200).send({ token: apiKey, expiresIn: 300 });
  });
};
