// ---------------------------------------------------------------------------
// Arena SSE Stream — GET /api/interview/:id/stream, GET /api/tts-token
// ---------------------------------------------------------------------------

import type { FastifyPluginAsync, FastifyBaseLogger } from 'fastify';
import { PrismaClient } from '@prisma/client';
import {
  getSession,
  updateSession,
  type ConversationEntry,
} from '../services/session';
import {
  buildSystemPrompt,
  type PromptTemplateData,
  type PromptQuestion,
} from '../services/promptConstructor';
import { applyQuestionAsked, type FollowupTrigger } from '../services/stateManager';
import { clickHouseWrite } from '../observability/clickhouseWriter';

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

  clickHouseWrite('llm_turns', {
    interviewId: params.interviewId,
    questionId: params.questionId ?? '',
    sequenceNumber: params.sequenceNumber,
    isFollowup: params.isFollowup,
    model: result.model,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    latencyMs: result.latencyMs,
  });

  return result;
}

// ===========================================================================
// First-question trigger (called once per interview on SSE connect)
// ===========================================================================

/**
 * Streams the opening LLM question to the SSE connection for a new interview.
 * Acquires the turn lock, fetches template, builds system prompt, calls Claude,
 * then updates Redis session with the result.
 *
 * Called non-blocking (void) from the SSE route handler after ':connected'.
 */
async function triggerFirstQuestion(
  interviewId: string,
  prisma: PrismaClient,
  apiKey: string,
  log: FastifyBaseLogger,
): Promise<void> {
  log.info({ interviewId }, '[SSE] triggerFirstQuestion start');
  const session = await getSession(interviewId);
  if (!session) {
    log.warn({ interviewId }, '[SSE] triggerFirstQuestion: no Redis session found');
    return;
  }
  if (session.isStreaming || session.conversationHistory.length > 0) {
    log.info({ interviewId, isStreaming: session.isStreaming, historyLen: session.conversationHistory.length }, '[SSE] triggerFirstQuestion: skipping');
    return;
  }

  // Acquire turn lock
  await updateSession(interviewId, { isStreaming: true, currentTurnLlmText: '' });

  try {
    const [template, templateQuestions] = await Promise.all([
      prisma.interviewTemplate.findUnique({ where: { id: session.templateId } }),
      prisma.templateQuestion.findMany({
        where: { templateId: session.templateId },
        include: {
          question: {
            include: { questionTags: { include: { tag: true } } },
          },
        },
        orderBy: { sequenceOrder: 'asc' },
      }),
    ]);

    if (!template) {
      log.error({ interviewId, templateId: session.templateId }, '[SSE] triggerFirstQuestion: template not found');
      await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
      return;
    }

    log.info({ interviewId, templateId: session.templateId, questionCount: templateQuestions.length, nextQuestionId: session.requiredRemaining[0] ?? session.optionalRemaining[0] ?? null }, '[SSE] triggerFirstQuestion: template loaded');

    // Build lookup from TemplateQuestion ID → Question ID for trigger resolution
    const tqIdToQuestionId = new Map(templateQuestions.map((tq) => [tq.id, tq.questionId]));

    const questions: PromptQuestion[] = templateQuestions.map((tq) => ({
      questionId: tq.questionId,
      text: tq.question.text,
      categoryBucket: tq.categoryBucket,
      isRequired: tq.isRequired,
      sequenceOrder: tq.sequenceOrder,
      followupTriggers: (
        (Array.isArray(tq.followupTriggers) ? tq.followupTriggers : []) as any[]
      ).flatMap((t: any): FollowupTrigger[] => {
        const condition = t.lengthDescription ?? t.condition ?? '';
        // New format: targetTemplateQuestionIds (TQ IDs → resolve to Question IDs)
        if (Array.isArray(t.targetTemplateQuestionIds)) {
          return t.targetTemplateQuestionIds
            .map((tqId: string) => tqIdToQuestionId.get(tqId))
            .filter((qId: string | undefined): qId is string => !!qId)
            .map((followupQuestionId: string) => ({ condition, followupQuestionId }));
        }
        // Legacy format: followupQuestionId directly
        if (t.followupQuestionId) {
          return [{ condition, followupQuestionId: t.followupQuestionId }];
        }
        return [];
      }),
    }));

    const promptData: PromptTemplateData = {
      name: template.name,
      description: template.description,
      systemPrompt: template.systemPrompt,
      questions,
    };
    const systemPrompt = buildSystemPrompt(promptData);

    const nextQuestionId = session.requiredRemaining[0] ?? session.optionalRemaining[0] ?? null;
    const nextTqRow = nextQuestionId
      ? templateQuestions.find((tq) => tq.questionId === nextQuestionId)
      : null;

    log.info({ interviewId }, '[SSE] triggerFirstQuestion: calling LLM');
    const client = createStreamingClaudeClient(apiKey);
    const result = await streamLlmToSSE(client, {
      interviewId,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Please begin the interview.' }],
      questionId: nextQuestionId,
      sequenceNumber: 1,
      isFollowup: false,
      interviewComplete: false,
      progressPercent: 0,
    });

    const assistantEntry: ConversationEntry = {
      role: 'assistant',
      content: result.fullContent,
      ...(nextQuestionId ? { questionId: nextQuestionId, sequenceNumber: 1 } : {}),
    };

    const questionAskedPatch =
      nextQuestionId && nextTqRow
        ? applyQuestionAsked(session, nextQuestionId, nextTqRow.categoryBucket)
        : {};

    await updateSession(interviewId, {
      isStreaming: false,
      currentTurnLlmText: result.fullContent,
      conversationHistory: [assistantEntry],
      ...questionAskedPatch,
    });
    log.info({ interviewId, completionTokens: result.completionTokens }, '[SSE] triggerFirstQuestion: LLM done');
  } catch (err) {
    log.error({ interviewId, err: err instanceof Error ? err.message : String(err) }, '[SSE] triggerFirstQuestion error');
    await updateSession(interviewId, { isStreaming: false, currentTurnLlmText: null });
  }
}

// ===========================================================================
// pushTurnToSSE — called from resolvers after submitResponse / skipQuestion
// ===========================================================================

/**
 * Reads the current LLM turn from Redis and pushes it to the active SSE
 * connection for the interview. Emits a token event (for LLM_STREAMING
 * state transition), sentence_complete events (for TTS), and stream_complete.
 *
 * Silently returns if no SSE connection is registered or if there is no
 * pending LLM turn (currentTurnLlmText is null/empty).
 */
export async function pushTurnToSSE(interviewId: string): Promise<void> {
  const conn = getSSEConnection(interviewId);
  if (!conn) return;

  const session = await getSession(interviewId);
  if (!session) return;

  const llmText = session.currentTurnLlmText;
  if (!llmText) return;

  // Find the last assistant entry for question metadata
  let questionId: string | null = null;
  let sequenceNumber = 1;
  for (let i = session.conversationHistory.length - 1; i >= 0; i--) {
    const entry = session.conversationHistory[i];
    if (entry.role === 'assistant' && entry.questionId) {
      questionId = entry.questionId;
      sequenceNumber = entry.sequenceNumber ?? 1;
      break;
    }
  }

  const progressPercent =
    session.totalExpectedQuestions > 0
      ? Math.round((session.questionsCompleted / session.totalExpectedQuestions) * 100)
      : 0;

  const interviewComplete =
    session.requiredRemaining.length === 0 && session.optionalRemaining.length === 0;

  // Emit the full text as a single token to trigger LLM_STREAMING state on the frontend
  conn.send({ type: 'token', content: llmText });

  // Emit sentence_complete events for TTS chunking
  const detector = new SentenceBoundaryDetector();
  for (const evt of detector.addToken(llmText)) {
    conn.send(evt);
  }
  const finalSentence = detector.flush();
  if (finalSentence) conn.send(finalSentence);

  // Emit stream_complete to transition frontend to AWAITING_INPUT
  conn.send({
    type: 'stream_complete',
    fullResponse: llmText,
    questionId,
    sequenceNumber,
    isFollowup: false,
    interviewComplete,
    progressPercent,
  });
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
  /**
   * Anthropic API key for streaming Claude calls.
   * Required for the first-question trigger and resume re-engagement.
   */
  apiKey?: string;
}

export const ssePlugin: FastifyPluginAsync<SSEPluginOptions> = async (app, opts) => {
  const prisma = opts.prisma ?? new PrismaClient();
  const apiKey = opts.apiKey ?? '';

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
        request.log.warn('[SSE] /stream rejected — no authenticated user');
        return reply.code(401).send({
          errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }],
        });
      }

      const interviewId = request.params.id;
      request.log.info('[SSE] /stream connect userId=%s interviewId=%s', user.userId, interviewId);

      // Interview existence, ownership, and status checks
      const interview = await prisma.interview.findUnique({
        where: { id: interviewId },
        select: { id: true, userId: true, status: true },
      });

      if (!interview) {
        request.log.warn('[SSE] /stream interview not found interviewId=%s', interviewId);
        return reply.code(404).send({
          errors: [{ message: 'Interview not found', extensions: { code: 'NOT_FOUND' } }],
        });
      }

      if (interview.userId !== user.userId) {
        request.log.warn('[SSE] /stream ownership mismatch interviewId=%s ownerId=%s requesterId=%s', interviewId, interview.userId, user.userId);
        return reply.code(403).send({
          errors: [{ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }],
        });
      }

      if (interview.status !== 'in_progress' && interview.status !== 'paused') {
        request.log.warn('[SSE] /stream invalid status interviewId=%s status=%s', interviewId, interview.status);
        return reply.code(400).send({
          errors: [{
            message: 'Interview is not active',
            extensions: { code: 'INVALID_STATE' },
          }],
        });
      }

      // Write SSE headers and hijack — Fastify won't send its own response.
      // CORS headers must be set manually here because reply.hijack() bypasses
      // the @fastify/cors plugin's onSend hook entirely.
      const origin = request.headers.origin;
      const corsOrigin = process.env.CORS_ORIGIN || (origin ?? '*');
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Credentials': 'true',
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

      // Trigger LLM turn based on current session state (non-blocking)
      // Wrapped in try-catch so a Redis error doesn't crash the hijacked handler
      try {
        const session = await getSession(interviewId);
        if (!session) {
          request.log.warn('[SSE] No Redis session found for interviewId=%s — first question will not stream', interviewId);
        } else if (session.conversationHistory.length === 0 && !session.isStreaming) {
          // New interview — stream the opening question
          if (!apiKey) {
            request.log.error('[SSE] CLAUDE_API_KEY is not set — cannot trigger first question for interviewId=%s', interviewId);
          } else {
            request.log.info('[SSE] Triggering first question for interviewId=%s', interviewId);
            void triggerFirstQuestion(interviewId, prisma, apiKey, app.log);
          }
        } else if (session.currentTurnLlmText && !session.isStreaming) {
          // Reconnect or resume — replay the last LLM turn to the new connection
          request.log.info('[SSE] Replaying last LLM turn for interviewId=%s', interviewId);
          void pushTurnToSSE(interviewId);
        } else {
          request.log.info('[SSE] Session state: isStreaming=%s historyLen=%d hasPendingText=%s', session.isStreaming, session.conversationHistory.length, !!session.currentTurnLlmText);
        }
      } catch (triggerErr) {
        // Log but don't crash — the connection stays open, frontend will retry
        request.log.error('[SSE] Failed to read session for LLM trigger: %s', triggerErr instanceof Error ? triggerErr.message : triggerErr);
      }

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
